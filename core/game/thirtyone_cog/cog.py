# -*- coding: utf-8 -*-
"""31ゲーム（カウントゲーム）。

順番に1〜3ずつ数え進め、31を言った人が脱落する。最後の1人が勝ち。
手番はボタン（+1/+2/+3）で、30秒反応がなければ自動で+1する。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core.game import party_ranking
from core.game import game_panels
from core.game.game_v2 import GamePanelView, LobbyView, text_panel
from core.game.thirtyone import ThirtyOneGame

logger = logging.getLogger(__name__)

GAME_ID = "thirtyone"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 30
MAX_PLAYERS = 8


def state_text(game: ThirtyOneGame, members: dict, note: str = "") -> str:
    alive = "、".join(members[pid].mention for pid in game.alive)
    text = f"現在のカウント: **{game.total}**\n生存: {alive}\n"
    if game.eliminated:
        text += "脱落: " + "、".join(members[pid].mention for pid in game.eliminated) + "\n"
    if note:
        text += note
    return text


class CountPanel(GamePanelView):
    """+1/+2/+3 の手番パネル（V2）。手番の人以外は interaction_check で弾く。"""

    def __init__(self, cog, session, body: str = ""):
        super().__init__("🔢 31ゲーム", body, timeout=None)
        self.cog = cog
        self.session = session
        self.plus1 = discord.ui.Button(label="+1", style=discord.ButtonStyle.primary)
        self.plus1.callback = lambda i: self._apply(i, 1)
        self.plus2 = discord.ui.Button(label="+2", style=discord.ButtonStyle.primary)
        self.plus2.callback = lambda i: self._apply(i, 2)
        self.plus3 = discord.ui.Button(label="+3", style=discord.ButtonStyle.primary)
        self.plus3.callback = lambda i: self._apply(i, 3)
        self.add_row(self.plus1, self.plus2, self.plus3)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        game = self.session["game"]
        if game.finished or interaction.user.id != game.current:
            await interaction.response.send_message("今はあなたの番ではありません。", ephemeral=True)
            return False
        return await super().interaction_check(interaction)

    async def _apply(self, interaction: discord.Interaction, step: int):
        await self.cog.apply_step(interaction, self.session, step)


CountView = CountPanel  # 互換名


class ThirtyOne(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に31ゲームが進行中です。", ephemeral=True)
        session = {"members": {interaction.user.id: interaction.user}, "game": None,
                   "channel": channel, "guild_id": interaction.guild_id, "turn_marker": 0}
        self.sessions[channel.id] = session
        await interaction.response.send_message("31ゲームの募集を開始しました。")
        try:
            lobby = LobbyView(
                title="🔢 31ゲーム 参加者募集", host=interaction.user,
                min_players=2, max_players=MAX_PLAYERS,
                note=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください。",
                timeout=RECRUIT_SECONDS + 30)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            session["members"] = dict(lobby.members)
            if len(session["members"]) < 2:
                await game_panels.clear(channel, "party")
                await channel.send("参加者が2人集まらなかったため、31ゲームを開始できませんでした。")
                return
            game = ThirtyOneGame(list(session["members"].keys()))
            session["game"] = game
            await self._show_turn(session, note="ゲーム開始！")
            await self._watchdog(session)
        finally:
            self.sessions.pop(channel.id, None)

    async def _show_turn(self, session, note: str = ""):
        game: ThirtyOneGame = session["game"]
        members = session["members"]
        if game.finished:
            return
        note = (note + "\n" if note else "") + f"次は {members[game.current].mention} さんの番です。31を言ったら脱落です。"
        await game_panels.replace(session["channel"], "party",
                                  view=CountPanel(self, session, body=state_text(game, members, note)))

    async def _watchdog(self, session):
        """手番が30秒変わらなければ自動で+1する。"""
        game: ThirtyOneGame = session["game"]
        while not game.finished:
            marker = session["turn_marker"]
            await asyncio.sleep(TURN_SECONDS)
            if game.finished or session["turn_marker"] != marker:
                continue
            await self._do_apply(session, 1, auto=True)

    async def apply_step(self, interaction: discord.Interaction, session, step: int):
        await interaction.response.defer()
        await self._do_apply(session, step)

    async def _do_apply(self, session, step: int, auto: bool = False):
        game: ThirtyOneGame = session["game"]
        members = session["members"]
        if game.finished:
            return
        actor = game.current
        result = game.apply(step)
        session["turn_marker"] += 1
        said = "、".join(str(n) for n in result["said"])
        note = f"{members[actor].mention} さんが「{said}」を言いました。"
        if auto:
            note = f"（時間切れで自動）" + note
        if result["hit31"]:
            note += f"\n💥 {members[actor].mention} さんが31を言って脱落…カウントは0に戻ります。"
        if game.finished:
            winner = members[game.winner]
            await party_ranking.shared().record_win(session["guild_id"], game.winner, GAME_ID)
            # 手番パネルを片付け、結果だけを残す。
            await game_panels.clear(session["channel"], "party")
            await session["channel"].send(view=text_panel(
                "🔢 31ゲーム 終了",
                state_text(game, members, note) + f"\n🏆 勝者: {winner.mention}"))
            return
        await self._show_turn(session, note=note)


async def setup(bot):
    await bot.add_cog(ThirtyOne(bot))
