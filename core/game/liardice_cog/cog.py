# -*- coding: utf-8 -*-
"""「ライアーズダイス」（Perudo 系の伝統ダイスブラフゲーム）。

盤面表現: 状態は「各人の残りダイス数・現在の宣言・手番」だけで空間性が
ないため V2 構造化テキスト（判断は実装ログ参照）。自分のダイスは
ephemeral でのみ表示する。宣言は個数/値のセレクト、判定はボタン。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core.game import party_ranking
from core.game.game_v2 import GamePanelView, preview_notice_line, text_panel
from core.game.liardice import LiarDiceGame, is_legal_raise

logger = logging.getLogger(__name__)

party_ranking.register("liardice")

GAME_ID = "liardice"
RECRUIT_SECONDS = 60
MIN_PLAYERS = 2
MAX_PLAYERS = 6
FACE_EMOJI = {1: "⚀", 2: "⚁", 3: "⚂", 4: "⚃", 5: "⚄", 6: "⚅"}


def dice_text(dice: list[int]) -> str:
    return " ".join(f"{FACE_EMOJI[d]}" for d in sorted(dice))


def status_text(game: LiarDiceGame) -> str:
    lines = []
    for uid in game.players:
        count = game.dice_count[uid]
        mark = "💀脱落" if count <= 0 else f"🎲×{count}"
        lines.append(f"<@{uid}>: {mark}")
    if game.bid is not None:
        count, face = game.bid
        lines.append(f"\n現在の宣言: <@{game.bidder}> が「{face}の目が{count}個」")
    else:
        lines.append("\nまだ宣言がありません。")
    if not game.finished:
        lines.append(f"手番は <@{game.current}> です。")
    return "\n".join(lines)


class BidView(discord.ui.View):
    """宣言の個数と値を選ぶ（本人 ephemeral）。"""

    def __init__(self, cog, game: LiarDiceGame):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.count: int | None = None
        self.face: int | None = None
        count_options = [discord.SelectOption(label=f"{n}個", value=str(n))
                         for n in range(1, game.total_dice + 1)]
        count_select = discord.ui.Select(placeholder="個数", options=count_options)
        face_options = [discord.SelectOption(label=f"{FACE_EMOJI[f]} {f}の目" + ("（ワイルド）" if f == 1 else ""),
                                             value=str(f)) for f in range(1, 7)]
        face_select = discord.ui.Select(placeholder="値", options=face_options)

        async def on_count(inter: discord.Interaction):
            self.count = int(count_select.values[0])
            await inter.response.send_message(f"個数 {self.count} を選びました。", ephemeral=True)

        async def on_face(inter: discord.Interaction):
            self.face = int(face_select.values[0])
            await inter.response.send_message(f"値 {self.face} を選びました。", ephemeral=True)

        count_select.callback = on_count
        face_select.callback = on_face
        self.add_item(count_select)
        self.add_item(face_select)
        confirm = discord.ui.Button(label="宣言する", style=discord.ButtonStyle.success)

        async def on_confirm(inter: discord.Interaction):
            if self.count is None or self.face is None:
                return await inter.response.send_message("個数と値を選んでください。", ephemeral=True)
            if not is_legal_raise(game.bid, (self.count, self.face)):
                return await inter.response.send_message(
                    "その宣言は前の宣言より強くなっていません（上げるルールはガイド参照）。", ephemeral=True)
            await cog.apply_bid(inter, game, self.count, self.face)

        confirm.callback = on_confirm
        self.add_item(confirm)


class LiarDice(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, LiarDiceGame | None] = {}
        self.messages: dict[int, discord.Message] = {}

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}

        panel = GamePanelView("🎲 ライアーズダイス 参加者募集",
                              f"場全体の出目を読み合うブラフゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>",
                              notice=preview_notice_line(GAME_ID))

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"場全体の出目を読み合うブラフゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("ライアーズダイス", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = LiarDiceGame(players)
            self.channels[channel.id] = game
            self.messages[channel.id] = await channel.send(view=self._panel(game))
            while not game.finished:
                await asyncio.sleep(1.0)
            await self._refresh(channel, game)
            await channel.send(view=text_panel(
                "🏆 ライアーズダイス 結果", f"勝者は <@{game.winner}> です！\n" + status_text(game)))
            guild = getattr(channel, "guild", None)
            if guild is not None and game.winner is not None:
                await party_ranking.shared().record_win(guild.id, game.winner, GAME_ID)
        except Exception:  # noqa: BLE001
            logger.exception("LiarDice: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    # ------------------------------------------------------------------ パネル
    def _panel(self, game: LiarDiceGame) -> GamePanelView:
        panel = GamePanelView("🎲 ライアーズダイス", status_text(game),
                              notice=preview_notice_line(GAME_ID))

        async def on_mine(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.players or game.dice_count.get(uid, 0) <= 0:
                return await inter.response.send_message("あなたのダイスはありません。", ephemeral=True)
            await inter.response.send_message(
                view=GamePanelView("あなたのダイス", dice_text(game.hands[uid])), ephemeral=True)

        async def on_bid(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            await inter.response.send_message(view=BidView(self, game), ephemeral=True)

        async def on_challenge(inter: discord.Interaction):
            if inter.user.id != game.current:
                return await inter.response.send_message("あなたの手番ではありません。", ephemeral=True)
            if game.bid is None:
                return await inter.response.send_message("まだ宣言がありません。", ephemeral=True)
            await self.apply_challenge(inter, game)

        mine_btn = discord.ui.Button(label="自分のダイス", style=discord.ButtonStyle.secondary)
        mine_btn.callback = on_mine
        bid_btn = discord.ui.Button(label="宣言する", style=discord.ButtonStyle.primary)
        bid_btn.callback = on_bid
        challenge_btn = discord.ui.Button(label="嘘だ！", style=discord.ButtonStyle.danger)
        challenge_btn.callback = on_challenge
        panel.add_row(mine_btn, bid_btn, challenge_btn)
        return panel

    async def _refresh(self, channel, game: LiarDiceGame):
        msg = self.messages.get(channel.id)
        if msg is not None:
            try:
                await msg.edit(view=self._panel(game))
            except Exception:  # noqa: BLE001
                logger.debug("LiarDice: パネル更新に失敗", exc_info=True)

    # ------------------------------------------------------------------ 行動適用
    async def apply_bid(self, interaction: discord.Interaction, game: LiarDiceGame, count: int, face: int):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        if not game.place_bid(interaction.user.id, count, face):
            return await interaction.response.send_message("宣言できませんでした。", ephemeral=True)
        await interaction.response.send_message("宣言を受け付けました。", ephemeral=True)
        await self._refresh(interaction.channel, game)

    async def apply_challenge(self, interaction: discord.Interaction, game: LiarDiceGame):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return
        result = game.challenge(interaction.user.id)
        if result is None:
            return await interaction.response.send_message("判定できませんでした。", ephemeral=True)
        await interaction.response.send_message("判定します！", ephemeral=True)
        count, face = result["bid"]
        reveal_lines = [f"<@{uid}>: {dice_text(dice)}" for uid, dice in result["revealed"].items()]
        verdict = (f"宣言は「{face}の目が{count}個」、実際は **{result['actual']}個** でした。"
                   + ("宣言は本当でした！" if result["bid_true"] else "宣言は嘘でした！"))
        loser_text = f"<@{result['loser']}> がダイスを1個失いました。"
        if result["eliminated"]:
            loser_text += " ダイスが無くなり脱落です。"
        body = verdict + "\n" + loser_text + "\n\n" + "\n".join(reveal_lines)
        if not game.finished:
            body += f"\n\n次の親は <@{game.round_starter}> です。ダイスを振り直しました。"
        await interaction.channel.send(view=text_panel("🎲 判定結果", body))
        await self._refresh(interaction.channel, game)


async def setup(bot):
    await bot.add_cog(LiarDice(bot))
