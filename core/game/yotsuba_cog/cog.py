# -*- coding: utf-8 -*-
"""「よつば合わせ」（So Clover! 系の協力ワードゲーム）。

盤面表現: ヒント盤は「4辺の単語＋4隅のヒント」の空間配置が本体のため、
board_image.render_yotsuba で画像化し MediaGallery で表示する（判断は
実装ログ参照）。自分のカード配置は ephemeral でのみ表示する。
配置の指定は候補カードと回転のセレクト（ephemeral）。
"""
import asyncio
import io
import logging
import random

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_yotsuba
from core.game.game_v2 import GamePanelView, text_panel
from core.game.yotsuba import EDGES, PAIR_NAMES, PAIRS, ROTATION_LABELS, WORDS, YotsubaGame, placed_words

logger = logging.getLogger(__name__)

GAME_ID = "yotsuba"
RECRUIT_SECONDS = 60
HINT_SECONDS = 180
SOLVE_SECONDS = 120
MIN_PLAYERS = 3
MAX_PLAYERS = 6


def player_label(game: YotsubaGame, user_id: int) -> str:
    return f"プレイヤー{game.players.index(user_id) + 1}"


class HintModal(discord.ui.Modal, title="ヒントを書く（各ペア1語）"):
    def __init__(self, cog, game: YotsubaGame, user_id: int):
        super().__init__()
        self.cog = cog
        self.game = game
        self.user_id = user_id
        self.inputs = []
        words = game.boards[user_id]
        for i, (a, b) in enumerate(PAIRS):
            field = discord.ui.TextInput(
                label=f"{PAIR_NAMES[i]}ペア: 「{words[a]}」と「{words[b]}」"[:45],
                max_length=20, placeholder="共通する言葉を1語")
            self.inputs.append(field)
            self.add_item(field)

    async def on_submit(self, interaction: discord.Interaction):
        hints = [str(f.value) for f in self.inputs]
        if self.game.submit_hints(interaction.user.id, hints):
            await interaction.response.send_message("ヒントを受け付けました。", ephemeral=True)
        else:
            await interaction.response.send_message(
                "受け付けできませんでした（空白を含む・提出済みなど）。", ephemeral=True)


class PlaceView(discord.ui.View):
    """候補カードと回転の選択（本人 ephemeral）。"""

    def __init__(self, cog, game: YotsubaGame):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.card_index: int | None = None
        self.rotation: int | None = None
        options = []
        for idx in game.available_cards():
            _owner, words = game.pool[idx]
            options.append(discord.SelectOption(
                label="、".join(words)[:100], value=str(idx)))
        card_select = discord.ui.Select(placeholder="置くカード", options=options)

        async def on_card(inter: discord.Interaction):
            self.card_index = int(card_select.values[0])
            await inter.response.send_message("カードを選びました。", ephemeral=True)

        card_select.callback = on_card
        self.add_item(card_select)
        rot_select = discord.ui.Select(
            placeholder="向き（回転）",
            options=[discord.SelectOption(label=ROTATION_LABELS[r], value=str(r)) for r in range(4)])

        async def on_rot(inter: discord.Interaction):
            self.rotation = int(rot_select.values[0])
            await inter.response.send_message(f"向き: {ROTATION_LABELS[self.rotation]}", ephemeral=True)

        rot_select.callback = on_rot
        self.add_item(rot_select)
        confirm = discord.ui.Button(label="この配置で置く", style=discord.ButtonStyle.success)

        async def on_confirm(inter: discord.Interaction):
            if self.card_index is None or self.rotation is None:
                return await inter.response.send_message("カードと向きを選んでください。", ephemeral=True)
            await cog.apply_place(inter, game, self.card_index, self.rotation)

        confirm.callback = on_confirm
        self.add_item(confirm)


class Yotsuba(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, YotsubaGame | None] = {}

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}

        panel = GamePanelView("🍀 よつば合わせ 参加者募集",
                              f"単語ペアへのヒントを捻って配置を当てる協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"単語ペアへのヒントを捻って配置を当てる協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("よつば合わせ", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            n = len(players)
            sampled = random.sample(WORDS, 4 * (n + 1))
            boards = {uid: tuple(sampled[4 * i:4 * i + 4]) for i, uid in enumerate(players)}
            dummy = tuple(sampled[4 * n:4 * n + 4])
            game = YotsubaGame(players, boards, dummy)
            self.channels[channel.id] = game
            await self._hint_phase(channel, game)
            await self._solve_phase(channel, game)
            await channel.send(view=text_panel(
                "🏆 よつば合わせ 結果",
                f"チームスコア: **{game.total_score} / {game.max_score} 点**\n"
                + "参加者: " + " ".join(f"<@{p}>" for p in game.players)))
            for uid in game.players:
                game_records.record_yotsuba_safely(uid, game.total_score)
        except Exception:  # noqa: BLE001
            logger.exception("Yotsuba: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)

    # ------------------------------------------------------------------ ヒントフェーズ
    async def _hint_phase(self, channel, game: YotsubaGame):
        panel = GamePanelView(
            "🍀 ヒントを書こう",
            f"「自分のカード」で自分の単語配置を確認し、「ヒントを書く」から4ペア分のヒントを入力してください（{HINT_SECONDS}秒）。\n"
            "ヒントは隣り合う2語に共通する言葉を1語で書きます。")

        async def on_mine(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.boards:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            words = game.boards[uid]
            lines = [f"{EDGES[i]}: **{words[i]}**" for i in range(4)]
            lines.append("")
            for i, (a, b) in enumerate(PAIRS):
                lines.append(f"{PAIR_NAMES[i]}ペア: 「{words[a]}」と「{words[b]}」")
            await inter.response.send_message(
                view=GamePanelView("あなたのカード", "\n".join(lines)), ephemeral=True)

        async def on_hint(inter: discord.Interaction):
            if inter.user.id not in game.boards:
                return await inter.response.send_message("参加者だけが書けます。", ephemeral=True)
            if inter.user.id in game.hints:
                return await inter.response.send_message("すでに提出済みです。", ephemeral=True)
            await inter.response.send_modal(HintModal(self, game, inter.user.id))

        mine_btn = discord.ui.Button(label="自分のカード", style=discord.ButtonStyle.secondary)
        mine_btn.callback = on_mine
        hint_btn = discord.ui.Button(label="ヒントを書く", style=discord.ButtonStyle.primary)
        hint_btn.callback = on_hint
        panel.add_row(mine_btn, hint_btn)
        await channel.send(view=panel)
        for _ in range(HINT_SECONDS * 2):
            if game.all_hints_in():
                break
            await asyncio.sleep(0.5)
        for uid in game.players:
            if uid not in game.hints:
                game.hints[uid] = ["なし", "なし", "なし", "なし"]

    # ------------------------------------------------------------------ 配置フェーズ
    async def _solve_phase(self, channel, game: YotsubaGame):
        while not game.finished:
            owner = game.current_board_owner
            index_before = game.solve_index
            await self._send_board(channel, game, owner, placed=False)
            for _ in range(SOLVE_SECONDS * 2):
                if game.solve_index != index_before:
                    break
                await asyncio.sleep(0.5)
            if game.solve_index == index_before:
                game.skip_board()
                await channel.send(view=text_panel(
                    "🍀 時間切れ", f"{player_label(game, owner)} <@{owner}> の盤は配置されませんでした。"))
                continue
            score = game.score_board(owner)
            await self._send_board(channel, game, owner, placed=True)
            await channel.send(view=text_panel(
                "🍀 配置結果",
                f"{player_label(game, owner)} <@{owner}> の盤: **{score} / 4 点**\n"
                f"現在のチームスコア: {game.total_score} / {game.max_score}"))
            await asyncio.sleep(2)

    async def _send_board(self, channel, game: YotsubaGame, owner: int, placed: bool):
        hints = game.hints.get(owner)
        if placed and owner in game.placements:
            card_index, rotation = game.placements[owner]
            words = placed_words(game.pool[card_index][1], rotation)
        else:
            words = (None, None, None, None)
        png = render_yotsuba(words, hints, title=f"{player_label(game, owner)}のヒント盤")
        body = (f"{player_label(game, owner)} <@{owner}> のヒント盤です。"
                if not placed else f"{player_label(game, owner)} <@{owner}> の盤に置かれた配置です。")
        if not placed:
            body += f"\n出題者以外の人は「カードを置く」から候補カードと向きを選んでください（{SOLVE_SECONDS}秒）。最初に置いた人の回答が採用されます。"
        panel = GamePanelView("🍀 よつば合わせ", body)
        panel.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))
        if not placed:
            async def on_place(inter: discord.Interaction):
                if inter.user.id not in game.players or inter.user.id == owner:
                    return await inter.response.send_message("出題者以外が置けます。", ephemeral=True)
                if game.current_board_owner != owner:
                    return await inter.response.send_message("この盤はもう終わっています。", ephemeral=True)
                await inter.response.send_message(view=PlaceView(self, game), ephemeral=True)

            place_btn = discord.ui.Button(label="カードを置く", style=discord.ButtonStyle.success)
            place_btn.callback = on_place
            panel.add_row(place_btn)
        file = discord.File(io.BytesIO(png), "board.png")
        await channel.send(file=file, view=panel)

    async def apply_place(self, interaction: discord.Interaction, game: YotsubaGame,
                          card_index: int, rotation: int):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        result = game.place(interaction.user.id, card_index, rotation)
        if result is None:
            return await interaction.response.send_message("置けませんでした。", ephemeral=True)
        await interaction.response.send_message("配置を受け付けました。", ephemeral=True)


async def setup(bot):
    await bot.add_cog(Yotsuba(bot))
