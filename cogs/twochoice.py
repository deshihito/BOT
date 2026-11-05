# -*- coding: utf-8 -*-
"""究極の二択（投票パーティー）。

お題を5題出し、各題20秒間ボタンで投票する。全員が投票でき、結果は
割合と少数派とあわせて表示される。勝敗はなく、参加記録だけが
core/game_records.py の twochoice に残る。
"""
import asyncio
import random

import discord
from discord.ext import commands

from core import game_panels, game_records
from core.twochoice import QUESTIONS_PER_SESSION, minority_side, pick_questions, tally

GAME_ID = "twochoice"
VOTE_SECONDS = 20
COLOR = 0xFFFFFF


class VoteView(discord.ui.View):
    def __init__(self, cog, session):
        super().__init__(timeout=VOTE_SECONDS + 30)
        self.cog = cog
        self.session = session

    @discord.ui.button(label="A", style=discord.ButtonStyle.primary)
    async def vote_a(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._vote(interaction, "A")

    @discord.ui.button(label="B", style=discord.ButtonStyle.primary)
    async def vote_b(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._vote(interaction, "B")

    async def _vote(self, interaction: discord.Interaction, side: str):
        votes = self.session["votes"]
        votes[interaction.user.id] = side
        await interaction.response.send_message(
            f"{side} に投票しました（現在 {len(votes)} 票）。締め切りまでに変更もできます。", ephemeral=True)


class TwoChoice(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.active = set()

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。押したチャンネルでそのままセッションが始まる。"""
        channel = interaction.channel
        if channel.id in self.active:
            return await interaction.response.send_message("このチャンネルでは既に二択が進行中です。", ephemeral=True)
        self.active.add(channel.id)
        await interaction.response.send_message("究極の二択を始めます。")
        try:
            await self._run_session(channel)
        finally:
            self.active.discard(channel.id)

    async def _run_session(self, channel):
        questions = pick_questions(random.Random(), QUESTIONS_PER_SESSION)
        per_user_votes: dict = {}
        per_user_minority: dict = {}
        for idx, (opt_a, opt_b) in enumerate(questions, 1):
            session = {"votes": {}}
            embed = discord.Embed(
                title=f"⚖ 究極の二択（{idx}/{len(questions)}）",
                description=f"**A: {opt_a}**\n**B: {opt_b}**\n\n{VOTE_SECONDS}秒で締め切ります。どちらか押してください。",
                color=COLOR)
            await game_panels.replace(channel, "party", embed=embed, view=VoteView(self, session))
            await asyncio.sleep(VOTE_SECONDS)
            votes = session["votes"]
            a, b = tally(votes)
            total = a + b
            if total == 0:
                result = "投票がありませんでした。"
            else:
                pa = a * 100 // total
                pb = 100 - pa
                minority = minority_side(votes)
                lines = [f"A: {opt_a} — {a}票（{pa}%）", f"B: {opt_b} — {b}票（{pb}%）"]
                if minority:
                    lines.append(f"少数派は **{minority}** でした。")
                else:
                    lines.append("ちょうど同数でした。")
                result = "\n".join(lines)
                for uid, side in votes.items():
                    per_user_votes[uid] = per_user_votes.get(uid, 0) + 1
                    if minority and side == minority:
                        per_user_minority[uid] = per_user_minority.get(uid, 0) + 1
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title=f"⚖ 結果（{idx}/{len(questions)}）", description=result, color=COLOR))
            await asyncio.sleep(3)
        for uid, count in per_user_votes.items():
            game_records.record_twochoice_safely(uid, count, per_user_minority.get(uid, 0))
        await channel.send(embed=discord.Embed(
            title="⚖ 究極の二択 終了",
            description=f"{len(questions)}題が終わりました。参加してくれた {len(per_user_votes)} 人、ありがとうございました。",
            color=COLOR))


async def setup(bot):
    await bot.add_cog(TwoChoice(bot))
