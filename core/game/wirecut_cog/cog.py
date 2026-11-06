# -*- coding: utf-8 -*-
"""「爆弾処理班」（Bomb Busters 系の協力推理ゲーム）。

盤面表現: ラウンド5では「位置＋公開メモの列挙が本質」として V2 構造化
テキストを選んだが、実プレイで「画像がないと何もわからん」と判定された
ため方針転換（レビュー対応 2026-11-06）: 共有の進行表示は PIL 盤面画像
（core/game/board_image.render_wirecut_board）にし、各ラックを位置番号
つきスロットで描く。未カットタイルの数字そのものは画像にも共有テキスト
にも出さず、公開済み情報（偶奇ヒント・≠メモ）だけをタイル上に併記する。
自分のタイルは ephemeral でのみ表示する。
操作は対象セレクト（ephemeral）→モーダルで位置と数字を入力する分離方式で、
ラックが長くてもセレクト上限に触れない。
"""
import asyncio
import io
import logging

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_cached, render_wirecut_board
from core.game.game_v2 import GamePanelView, text_panel
from core.game.wirecut import MAX_MISS, WireCutGame
from core.support.panel_v2 import edit_message_v2

logger = logging.getLogger(__name__)

GAME_ID = "wirecut"
RECRUIT_SECONDS = 60
MIN_PLAYERS = 2
MAX_PLAYERS = 5


def player_labels(game: WireCutGame) -> dict[int, str]:
    return {uid: f"プレイヤー{i + 1}" for i, uid in enumerate(game.players)}


def board_slots(game: WireCutGame, uid: int) -> list[tuple]:
    """共有盤面用のスロット列。公開情報だけを含み、未カットタイルの数字は渡さない。

    カット済みタイルの数字は宣言で公知になっているため渡してよい。
    """
    slots = []
    for i in range(len(game.rack(uid))):
        if game.is_cut(uid, i):
            slots.append(("cut", game.rack(uid)[i]))
        else:
            note = game.notes.get((uid, i), {})
            slots.append(("hidden", note.get("parity"),
                          tuple(sorted(note.get("not", ())))))
    return slots


def board_png(game: WireCutGame) -> bytes:
    labels = player_labels(game)
    players = [{"label": f"{labels[uid]}（情報トークン {game.info_left[uid]}）",
                "slots": board_slots(game, uid)} for uid in game.players]
    fuse_left = game.max_miss - game.misses
    key = ("wirecut",
           tuple((p["label"], tuple(p["slots"])) for p in players),
           game.remaining_numbers(), fuse_left, game.max_miss)
    return render_cached(key, lambda: render_wirecut_board(
        players, remaining=game.remaining_numbers(),
        fuse_left=fuse_left, fuse_max=game.max_miss))


def board_file(game: WireCutGame) -> discord.File:
    return discord.File(io.BytesIO(board_png(game)), "board.png")


def status_text(game: WireCutGame) -> str:
    labels = player_labels(game)
    lines = [f"残り数字ワイヤー: **{game.remaining_numbers()}本**／ヒューズ: **{game.max_miss - game.misses}/{game.max_miss}**"]
    for uid in game.players:
        cut_count = sum(1 for i in range(len(game.rack(uid))) if game.is_cut(uid, i))
        lines.append(f"{labels[uid]} <@{uid}>（情報 {game.info_left[uid]}／カット済み {cut_count}枚）")
    lines.append("各タイルの状態は盤面画像を見てください（数字は左から小さい順、赤の位置だけ不明）。")
    if not game.finished:
        lines.append(f"\n手番は {labels[game.current]} <@{game.current}> です。")
    return "\n".join(lines)


class DeclareModal(discord.ui.Modal, title="カット宣言"):
    position = discord.ui.TextInput(label="相手のタイルの位置（左から何番目か）", max_length=3)
    number = discord.ui.TextInput(label="そのタイルだと思う数字（1〜12）", max_length=3)

    def __init__(self, cog, game: WireCutGame, target: int):
        super().__init__()
        self.cog = cog
        self.game = game
        self.target = target

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.apply_declare(interaction, self.game, self.target,
                                     str(self.position.value), str(self.number.value))


class InfoModal(discord.ui.Modal, title="情報トークンを使う"):
    position = discord.ui.TextInput(label="相手のタイルの位置（左から何番目か）", max_length=3)

    def __init__(self, cog, game: WireCutGame, target: int):
        super().__init__()
        self.cog = cog
        self.game = game
        self.target = target

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.apply_info(interaction, self.game, self.target, str(self.position.value))


class TargetView(discord.ui.View):
    """宣言/情報の対象プレイヤー選択（本人 ephemeral）。"""

    def __init__(self, cog, game: WireCutGame, mode: str):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.mode = mode
        labels = player_labels(game)
        if mode == "declare":
            targets = list(game.players)  # 自分のラックも宣言対象にできる
        else:
            targets = [uid for uid in game.players if uid != game.current]
        options = [discord.SelectOption(
            label=labels[uid] + ("（自分）" if uid == game.current else ""), value=str(uid))
            for uid in targets]
        select = discord.ui.Select(placeholder="対象のプレイヤー", options=options)
        self.target: int | None = None

        async def on_target(inter: discord.Interaction):
            self.target = int(select.values[0])
            await inter.response.send_message(f"対象を選びました。続いて「入力する」を押してください。", ephemeral=True)

        select.callback = on_target
        self.add_item(select)
        next_btn = discord.ui.Button(label="入力する", style=discord.ButtonStyle.primary)

        async def on_next(inter: discord.Interaction):
            if self.target is None:
                return await inter.response.send_message("先に対象を選んでください。", ephemeral=True)
            if mode == "declare":
                await inter.response.send_modal(DeclareModal(cog, game, self.target))
            else:
                await inter.response.send_modal(InfoModal(cog, game, self.target))

        next_btn.callback = on_next
        self.add_item(next_btn)


class WireCut(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, WireCutGame | None] = {}
        self.messages: dict[int, discord.Message] = {}

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}

        panel = GamePanelView("💣 爆弾処理班 参加者募集",
                              f"数字ワイヤーを推理でカットしていく協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"数字ワイヤーを推理でカットしていく協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                                   f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n"
                                   f"参加者（{len(players)}名）: " + " ".join(f"<@{p}>" for p in players))
            await inter.response.edit_message(view=panel)

        async def on_start(inter: discord.Interaction):
            if inter.user.id != players[0]:
                return await inter.response.send_message("開始できるのはホストだけです。", ephemeral=True)
            state["started"] = True
            await inter.response.send_message("開始します！", ephemeral=True)

        join_btn = discord.ui.Button(label="参加する", style=discord.ButtonStyle.success)
        join_btn.callback = on_join
        start_btn = discord.ui.Button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
        start_btn.callback = on_start
        panel.add_row(join_btn, start_btn)
        await interaction.response.send_message(view=panel)
        asyncio.create_task(self._run(channel, players, state))

    async def _run(self, channel, players: list[int], state: dict):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if state["started"]:
                    break
                await asyncio.sleep(0.5)
            players = list(dict.fromkeys(players))
            if len(players) < MIN_PLAYERS:
                await channel.send(view=text_panel("爆弾処理班", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = WireCutGame(players)
            self.channels[channel.id] = game
            await self._send_panel(channel, game)
            while not game.finished:
                await asyncio.sleep(1.0)
            await self._refresh_panel(channel, game)
            if game.cleared:
                body = "🎉 全ての数字ワイヤーをカットしました。ミッション成功です！\n" + status_text(game)
            else:
                reason = "赤ワイヤーに触れてしまいました…" if game.misses < game.max_miss else "ヒューズが尽きました…"
                body = f"💥 {reason}ミッション失敗です。\n" + status_text(game)
            await channel.send(view=text_panel("💣 爆弾処理班 結果", body))
            for uid in game.players:
                game_records.record_wirecut_safely(uid, game.cleared)
        except Exception:  # noqa: BLE001
            logger.exception("WireCut: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    # ------------------------------------------------------------------ パネル
    def _panel(self, game: WireCutGame) -> GamePanelView:
        panel = GamePanelView("💣 爆弾処理班", status_text(game) + "\n\n「自分のタイル」で自分のタイルを確認できます。")
        panel.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))

        async def on_mine(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.players:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            tiles = []
            for i, tile in enumerate(game.rack(uid)):
                if game.is_cut(uid, i):
                    tiles.append(f"{i + 1}:済")
                elif tile == 0:
                    tiles.append(f"{i + 1}:赤")
                else:
                    tiles.append(f"{i + 1}:{tile}")
            await inter.response.send_message(
                view=GamePanelView("あなたのタイル（左から）", " ".join(tiles)), ephemeral=True)

        async def on_declare(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            await inter.response.send_message(view=TargetView(self, game, "declare"), ephemeral=True)

        async def on_info(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            if game.info_left[inter.user.id] <= 0:
                return await inter.response.send_message("情報トークンはもうありません。", ephemeral=True)
            await inter.response.send_message(view=TargetView(self, game, "info"), ephemeral=True)

        mine_btn = discord.ui.Button(label="自分のタイル", style=discord.ButtonStyle.secondary)
        mine_btn.callback = on_mine
        declare_btn = discord.ui.Button(label="カット宣言", style=discord.ButtonStyle.success)
        declare_btn.callback = on_declare
        info_btn = discord.ui.Button(label="情報トークン", style=discord.ButtonStyle.primary)
        info_btn.callback = on_info
        panel.add_row(mine_btn, declare_btn, info_btn)
        return panel

    async def _send_panel(self, channel, game: WireCutGame):
        self.messages[channel.id] = await channel.send(file=board_file(game), view=self._panel(game))

    async def _refresh_panel(self, channel, game: WireCutGame):
        msg = self.messages.get(channel.id)
        if msg is not None:
            try:
                # 画像つきパネルは添付し直して編集する（花火大会の前例）
                await edit_message_v2(msg, self._panel(game), files=[board_file(game)])
            except Exception:  # noqa: BLE001
                logger.debug("WireCut: パネル更新に失敗", exc_info=True)

    # ------------------------------------------------------------------ 行動適用
    def _parse_pos(self, game: WireCutGame, target: int, text: str) -> int | None:
        try:
            pos = int(str(text).strip()) - 1
        except ValueError:
            return None
        if not (0 <= pos < len(game.rack(target))):
            return None
        return pos

    async def apply_declare(self, interaction: discord.Interaction, game: WireCutGame,
                            target: int, pos_text: str, num_text: str):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        pos = self._parse_pos(game, target, pos_text)
        try:
            number = int(str(num_text).strip())
        except ValueError:
            number = -1
        if pos is None or number not in range(1, 13):
            return await interaction.response.send_message("位置または数字が正しくありません。", ephemeral=True)
        actor = interaction.user.id
        result = game.declare(actor, target, pos, number)
        if result is None:
            return await interaction.response.send_message(
                "宣言できませんでした（その数字のペアがもう残っていない／カット済みの位置など）。", ephemeral=True)
        await interaction.response.send_message("宣言を受け付けました。", ephemeral=True)
        labels = player_labels(game)
        if result["result"] == "cut":
            text = f"✂️ {labels[actor]} <@{actor}> が {labels[target]} の{pos + 1}番を **{number}** と宣言してカット成功！"
        elif result["result"] == "miss":
            text = (f"❌ {labels[actor]} <@{actor}> の宣言（{labels[target]} の{pos + 1}番＝{number}）は外れでした。"
                    f"ヒューズ残り {game.max_miss - game.misses}。")
        else:
            text = f"💥 {labels[actor]} <@{actor}> が {labels[target]} の{pos + 1}番を触りましたが、それは赤ワイヤーでした…"
        await interaction.channel.send(view=text_panel("爆弾処理班", text))
        await self._refresh_panel(interaction.channel, game)

    async def apply_info(self, interaction: discord.Interaction, game: WireCutGame,
                         target: int, pos_text: str):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        pos = self._parse_pos(game, target, pos_text)
        if pos is None:
            return await interaction.response.send_message("位置が正しくありません。", ephemeral=True)
        actor = interaction.user.id
        result = game.use_info(actor, target, pos)
        if result is None:
            return await interaction.response.send_message("情報トークンを使えませんでした。", ephemeral=True)
        await interaction.response.send_message("情報トークンを使いました。", ephemeral=True)
        labels = player_labels(game)
        parity_text = {"red": "赤ワイヤー", "even": "偶数", "odd": "奇数"}[result["parity"]]
        await interaction.channel.send(view=text_panel(
            "爆弾処理班", f"🔍 {labels[actor]} <@{actor}> の情報: {labels[target]} の{pos + 1}番は **{parity_text}** です。"))
        await self._refresh_panel(interaction.channel, game)


async def setup(bot):
    await bot.add_cog(WireCut(bot))
