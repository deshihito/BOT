# -*- coding: utf-8 -*-
"""「花火大会」（Hanabi 系の協力カードゲーム）。

盤面表現: 場の山・他人の手札はタイル状の視覚情報なので、PIL タイル画像
（core/board_image.render_tiles）で共有パネルに表示し、手番ごとに
edit_message_v2（添付再送つき）で差し替える。自分の手札の実物は誰にも
（本人にも）出さず、「盤面を見る」ephemeral では他人手札＋自分の
ヒント情報だけを V2 テキストで本人に表示する。操作はボタン＋セレクト。
"""
import asyncio
import io
import logging

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_tiles
from core.game.game_v2 import GamePanelView, preview_notice_line, text_panel
from core.game.hanabi import COLOR_EMOJI, COLORS, HanabiGame
from core.support.panel_v2 import edit_message_v2

logger = logging.getLogger(__name__)

GAME_ID = "hanabi"
RECRUIT_SECONDS = 60
TURN_SECONDS = 180
MIN_PLAYERS = 2
MAX_PLAYERS = 5

TILE_COLORS = {"赤": (229, 115, 115), "青": (100, 181, 246), "黄": (255, 213, 79),
               "緑": (129, 199, 132), "白": (236, 239, 241)}


def board_png(game: HanabiGame, names: dict[int, str]) -> bytes:
    rows = [[(str(game.piles[c]) if game.piles[c] else "―", TILE_COLORS[c]) for c in COLORS]]
    for uid in game.players:
        rows.append([(str(num), TILE_COLORS[color]) for color, num in game.hands[uid]])
    return render_tiles(rows, tile=52, title="花火の場（1行目=完成状況）")


def board_text(game: HanabiGame) -> str:
    piles = " ".join(f"{COLOR_EMOJI[c]}{game.piles[c] or '―'}" for c in COLORS)
    discards = " ".join(f"{COLOR_EMOJI[c]}{n}" for c, n in game.discards) or "なし"
    return (f"場: {piles}（スコア {game.score}/25）\n"
            f"ヒント ⭐×{game.hints}／導火線 💥残り{game.fuse}／山札 {len(game.deck)}枚\n"
            f"捨て札: {discards}\n"
            f"手番: <@{game.current}> ／ 手札の並びは画像の2行目以降が参加順です")


class ActionSelectView(discord.ui.View):
    """出す/捨てる用の位置セレクト（本人 ephemeral）。"""

    def __init__(self, cog, game: HanabiGame, mode: str):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.mode = mode
        options = []
        for i, know in enumerate(game.knowledge[game.current]):
            color = know["color"] or "？"
            number = know["number"] or "？"
            options.append(discord.SelectOption(
                label=f"{i + 1}枚目（色:{color} 数字:{number}）", value=str(i)))
        select = discord.ui.Select(placeholder="出す位置" if mode == "play" else "捨てる位置", options=options)

        async def on_pick(inter: discord.Interaction):
            idx = int(select.values[0])
            await inter.response.send_message("受け付けました。", ephemeral=True)
            await cog.apply_move(inter.channel, game, mode, idx)

        select.callback = on_pick
        self.add_item(select)


class HintView(discord.ui.View):
    """ヒント用の対象＋内容セレクト（本人 ephemeral）。"""

    def __init__(self, cog, game: HanabiGame):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.target: int | None = None
        self.kind_value: tuple[str, object] | None = None
        target_options = [discord.SelectOption(label=f"プレイヤー {i + 1}", value=str(uid))
                          for i, uid in enumerate(game.players) if uid != game.current]
        self.target_names = {uid: f"プレイヤー {i + 1}" for i, uid in enumerate(game.players) if uid != game.current}
        target_select = discord.ui.Select(placeholder="ヒントを出す相手", options=target_options)
        value_options = ([discord.SelectOption(label=f"色: {c}", value=f"color:{c}") for c in COLORS]
                         + [discord.SelectOption(label=f"数字: {n}", value=f"number:{n}") for n in range(1, 6)])
        value_select = discord.ui.Select(placeholder="伝える内容（色または数字）", options=value_options)

        async def on_target(inter: discord.Interaction):
            self.target = int(target_select.values[0])
            await inter.response.send_message(f"相手を {self.target_names[self.target]} にしました。", ephemeral=True)

        async def on_value(inter: discord.Interaction):
            kind, raw = value_select.values[0].split(":", 1)
            self.kind_value = (kind, int(raw) if kind == "number" else raw)
            await inter.response.send_message("内容を選びました。「ヒントを出す」を押してください。", ephemeral=True)

        target_select.callback = on_target
        value_select.callback = on_value
        self.add_item(target_select)
        self.add_item(value_select)

    @discord.ui.button(label="この内容でヒントを出す", style=discord.ButtonStyle.primary)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.target is None or self.kind_value is None:
            return await interaction.response.send_message("相手と内容の両方を選んでください。", ephemeral=True)
        kind, value = self.kind_value
        await interaction.response.send_message("受け付けました。", ephemeral=True)
        await self.cog.apply_hint(interaction.channel, self.game, self.target, kind, value)


class Hanabi(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, HanabiGame | None] = {}
        self.messages: dict[int, discord.Message] = {}
        self.turn_marks: dict[int, int] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🎆 花火大会 参加者募集",
                              f"自分の手札だけ見えない協力カードゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>",
                              notice=preview_notice_line(GAME_ID))

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"自分の手札だけ見えない協力カードゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("花火大会", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = HanabiGame(players)
            self.channels[channel.id] = game
            await self._send_board(channel, game)
            asyncio.create_task(self._watchdog(channel, game))
            while not game.finished:
                await asyncio.sleep(1.0)
            await self._finish(channel, game)
        except Exception:  # noqa: BLE001
            logger.exception("Hanabi: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)
            self.turn_marks.pop(channel.id, None)

    async def _watchdog(self, channel, game: HanabiGame):
        """手番が TURN_SECONDS 進まなければ自動で1枚捨てる（満タン時は出す）。"""
        while not game.finished and self.channels.get(channel.id) is game:
            mark = game.turn
            for _ in range(TURN_SECONDS):
                if game.finished or game.turn != mark:
                    break
                await asyncio.sleep(1.0)
            if game.finished or game.turn != mark:
                continue
            actor = game.current
            if game.hints >= 8:
                result = game.play(actor, 0)
                note = f"⏰ <@{actor}> が時間切れのため自動で1枚目を出しました: {result.get('card')}"
            else:
                result = game.discard(actor, 0)
                note = f"⏰ <@{actor}> が時間切れのため自動で1枚目を捨てました: {result.get('card')}"
            await channel.send(view=text_panel("時間切れ", note))
            await self._send_board(channel, game, edit=True)

    def _panel(self, channel_id: int, game: HanabiGame) -> GamePanelView:
        panel = GamePanelView("🎆 花火大会", board_text(game),
                              notice=preview_notice_line(GAME_ID))
        panel.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))

        async def on_view(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.players:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            lines = []
            for other in game.players:
                hand = " ".join(f"{COLOR_EMOJI[c]}{n}" for c, n in game.hands[other])
                if other == uid:
                    know = " ".join(
                        f"[{k['color'] or '?'}{k['number'] or '?'}]" for k in game.knowledge[uid])
                    lines.append(f"あなた（手札は見えません） ヒント情報: {know}")
                else:
                    lines.append(f"<@{other}> の手札: {hand}")
            await inter.response.send_message(
                view=GamePanelView("盤面（本人用）", "\n".join(lines)), ephemeral=True)

        async def on_play(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            await inter.response.send_message(view=ActionSelectView(self, game, "play"), ephemeral=True)

        async def on_discard(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            await inter.response.send_message(view=ActionSelectView(self, game, "discard"), ephemeral=True)

        async def on_hint(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            if game.hints <= 0:
                return await inter.response.send_message("ヒントがありません。", ephemeral=True)
            await inter.response.send_message(view=HintView(self, game), ephemeral=True)

        view_btn = discord.ui.Button(label="盤面を見る", style=discord.ButtonStyle.secondary)
        view_btn.callback = on_view
        play_btn = discord.ui.Button(label="カードを出す", style=discord.ButtonStyle.success)
        play_btn.callback = on_play
        discard_btn = discord.ui.Button(label="捨てる", style=discord.ButtonStyle.primary)
        discard_btn.callback = on_discard
        hint_btn = discord.ui.Button(label="ヒントを出す", style=discord.ButtonStyle.primary)
        hint_btn.callback = on_hint
        panel.add_row(view_btn, play_btn, discard_btn, hint_btn)
        return panel

    async def _send_board(self, channel, game: HanabiGame, edit: bool = False):
        png = board_png(game, {})
        panel = self._panel(channel.id, game)
        file = discord.File(io.BytesIO(png), "board.png")
        msg = self.messages.get(channel.id)
        if edit and msg is not None:
            await edit_message_v2(msg, panel, files=[file])
        else:
            self.messages[channel.id] = await channel.send(file=file, view=panel)

    async def apply_move(self, channel, game: HanabiGame, mode: str, index: int):
        if self.channels.get(channel.id) is not game or game.finished:
            return
        actor = game.current
        if mode == "play":
            result = game.play(actor, index)
            if result.get("ok"):
                color, num = result["card"]
                head = "🎆 成功！" if result["success"] else "💥 ミス…"
                await channel.send(view=text_panel("花火大会", f"{head} <@{actor}> が {COLOR_EMOJI[color]}{num} を出しました。"))
        else:
            result = game.discard(actor, index)
            if result.get("ok"):
                color, num = result["card"]
                await channel.send(view=text_panel("花火大会", f"<@{actor}> が {COLOR_EMOJI[color]}{num} を捨て、ヒントが回復しました。"))
            elif result.get("reason"):
                await channel.send(view=text_panel("花火大会", result["reason"]))
                return
        await self._send_board(channel, game, edit=True)

    async def apply_hint(self, channel, game: HanabiGame, target: int, kind: str, value):
        if self.channels.get(channel.id) is not game or game.finished:
            return
        giver = game.current
        result = game.hint(giver, target, kind, value)
        if not result.get("ok"):
            await channel.send(view=text_panel("花火大会", result.get("reason", "ヒントを出せませんでした。")))
            return
        label = f"色「{value}」" if kind == "color" else f"数字「{value}」"
        await channel.send(view=text_panel(
            "花火大会", f"💡 <@{giver}> → <@{target}>: {label}のカードは {result['count']} 枚あります。"))
        await self._send_board(channel, game, edit=True)

    async def _finish(self, channel, game: HanabiGame):
        reason = f"（{game.fail_reason}）" if game.fail_reason else ""
        await channel.send(view=text_panel(
            "🎆 花火大会 結果",
            f"チームのスコアは **{game.score} / 25** でした{reason}。\n"
            + "参加者: " + " ".join(f"<@{p}>" for p in game.players)))
        for uid in game.players:
            game_records.record_hanabi_safely(uid, game.score)


async def setup(bot):
    await bot.add_cog(Hanabi(bot))
