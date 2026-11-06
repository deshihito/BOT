# -*- coding: utf-8 -*-
"""クイズ大会（4択ボタン・全員同時回答）。

問題は core/game/quiz_bank.py の同梱バンクから供給する（供給インターフェース
越しなので、将来 AI 生成に差し替え可能）。進行と採点は
core/game/quiz_game.py。優勝者は party_ranking に記録される。
"""
import asyncio
import logging
import time

import discord
from discord.ext import commands

from core import party_ranking
from core.game.quiz_bank import default_source
from core.game.quiz_game import QuizSession

logger = logging.getLogger(__name__)

party_ranking.register("quiz")

GAME_ID = "quiz"
QUESTION_COUNT = 10
QUESTION_SECONDS = 20
RECRUIT_SECONDS = 60


def standings_text(session: QuizSession, limit: int = 10) -> str:
    rows = session.standings()[:limit]
    if not rows:
        return "参加者がいませんでした。"
    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    lines = []
    for i, (uid, score, correct, answered) in enumerate(rows, 1):
        lines.append(f"{medals.get(i, f'{i}.')} <@{uid}> — {score}点（正解 {correct}/{answered}）")
    return "\n".join(lines)


class AnswerView(discord.ui.View):
    def __init__(self, cog, session: QuizSession, question, deadline: float):
        super().__init__(timeout=QUESTION_SECONDS + 5)
        self.cog = cog
        self.session = session
        self.deadline = deadline
        for i, choice in enumerate(question["choices"]):
            btn = discord.ui.Button(label=str(choice)[:80], style=discord.ButtonStyle.primary, row=i // 2)
            btn.callback = self._make_callback(i)
            self.add_item(btn)

    def _make_callback(self, idx):
        async def callback(interaction: discord.Interaction):
            remaining = max(0.0, self.deadline - time.monotonic())
            ratio = remaining / QUESTION_SECONDS if QUESTION_SECONDS else 0.0
            if self.session.submit(interaction.user.id, idx, ratio):
                await interaction.response.send_message("回答を受け付けました。", ephemeral=True)
            else:
                await interaction.response.send_message("すでに回答済みです（1問につき1回まで）。", ephemeral=True)
        return callback


class RecruitView(discord.ui.View):
    def __init__(self, cog, host_id):
        super().__init__(timeout=RECRUIT_SECONDS + 10)
        self.cog = cog
        self.host_id = host_id
        self.players = [host_id]
        self.started = False

    @discord.ui.button(label="参加する", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id in self.players:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        self.players.append(interaction.user.id)
        await interaction.response.send_message(f"参加しました（現在 {len(self.players)}名）。")

    @discord.ui.button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message("開始できるのはホストだけです。", ephemeral=True)
        if self.started:
            return await interaction.response.send_message("すでに開始しています。", ephemeral=True)
        self.started = True
        await interaction.response.send_message("クイズ大会を開始します！")
        self.stop()


class Quiz(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels = set()  # 開催中のチャンネル

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。"""
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでにクイズ大会が開催中です。", ephemeral=True)
        self.channels.add(channel.id)
        view = RecruitView(self, interaction.user.id)
        embed = discord.Embed(
            title="🧠 クイズ大会 参加者募集",
            description=(f"{QUESTION_COUNT}問の4択クイズで競います。参加ボタンを押してください。\n"
                         f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します（途中参加もできます）。"),
            color=0xFFFFFF,
        )
        await interaction.response.send_message(embed=embed, view=view)
        asyncio.create_task(self._run(channel, view))

    async def _run(self, channel, view: RecruitView):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if view.started:
                    break
                await asyncio.sleep(0.5)
            if not view.started:
                view.started = True
                view.stop()
            session = QuizSession(default_source().get_questions(QUESTION_COUNT))
            for uid in view.players:
                session.add_player(uid)
            await self._play(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("Quiz: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    async def _play(self, channel, session: QuizSession):
        total = len(session.questions)
        while True:
            q = session.next_question()
            if q is None:
                break
            number = session.index + 1
            embed = discord.Embed(
                title=f"第{number}問 / {total}問（{q['category']}）",
                description=f"**{q['q']}**\n制限時間: {QUESTION_SECONDS}秒",
                color=0xFFFFFF,
            )
            deadline = time.monotonic() + QUESTION_SECONDS
            view = AnswerView(self, session, q, deadline)
            await channel.send(embed=embed, view=view)
            for _ in range(QUESTION_SECONDS * 2):
                if session.all_answered():
                    break
                await asyncio.sleep(0.5)
            view.stop()
            gained = session.close_question()
            correct_label = q["choices"][q["answer"]]
            best = max(gained.items(), key=lambda kv: kv[1]) if gained else (None, 0)
            desc = f"正解は **{correct_label}** でした。"
            if best[0] is not None and best[1] > 0:
                desc += f"\n最高得点: <@{best[0]}>（+{best[1]}点）"
            await channel.send(embed=discord.Embed(title=f"第{number}問の答え", description=desc, color=0xFFFFFF))
            await asyncio.sleep(3)
        embed = discord.Embed(title="🏆 クイズ大会 結果発表", description=standings_text(session), color=0xFFFFFF)
        await channel.send(embed=embed)
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in session.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Quiz(bot))
