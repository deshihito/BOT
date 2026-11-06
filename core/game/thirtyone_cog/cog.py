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


class CountView(discord.ui.View):
    def __init__(self, cog, session):
        super().__init__(timeout=None)
        self.cog = cog
        self.session = session

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        game = self.session["game"]
        if game.finished or interaction.user.id != game.current:
            await interaction.response.send_message("今はあなたの番ではありません。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="+1", style=discord.ButtonStyle.primary)
    async def plus1(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._apply(interaction, 1)

    @discord.ui.button(label="+2", style=discord.ButtonStyle.primary)
    async def plus2(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._apply(interaction, 2)

    @discord.ui.button(label="+3", style=discord.ButtonStyle.primary)
    async def plus3(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._apply(interaction, 3)

    async def _apply(self, interaction: discord.Interaction, step: int):
        await self.cog.apply_step(interaction, self.session, step)


class JoinView(discord.ui.View):
    def __init__(self, session):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.session = session

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        members = self.session["members"]
        if interaction.user.id in members:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(members) >= MAX_PLAYERS:
            return await interaction.response.send_message("定員です。", ephemeral=True)
        members[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました。")


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
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="🔢 31ゲーム 参加者募集",
                description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2〜{MAX_PLAYERS}人）。",
                color=COLOR), view=JoinView(session))
            await asyncio.sleep(RECRUIT_SECONDS)
            if len(session["members"]) < 2:
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
        await game_panels.replace(session["channel"], "party", embed=discord.Embed(
            title="🔢 31ゲーム", description=state_text(game, members, note), color=COLOR),
            view=CountView(self, session))

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
            await game_panels.replace(session["channel"], "party", embed=discord.Embed(
                title="🔢 31ゲーム 終了",
                description=state_text(game, members, note) + f"\n🏆 勝者: {winner.mention}",
                color=COLOR))
            return
        await self._show_turn(session, note=note)


async def setup(bot):
    await bot.add_cog(ThirtyOne(bot))
