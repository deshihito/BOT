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

from core.game import game_panels, party_ranking
from core.game.game_v2 import GamePanelView, LobbyView, original_response_or_none, safe_delete, text_panel
from core.game.quiz_bank import default_source
from core.game.quiz_game import QuizSession

logger = logging.getLogger(__name__)

party_ranking.register("quiz")

GAME_ID = "quiz"
QUESTION_COUNT = 10
QUESTION_SECONDS = 20
RECRUIT_SECONDS = 60
MAX_PLAYERS = 99  # 実質無制限（共通ロビーの表示・定員チェック用）


def standings_text(session: QuizSession, limit: int = 10) -> str:
    rows = session.standings()[:limit]
    if not rows:
        return "参加者がいませんでした。"
    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    lines = []
    for i, (uid, score, correct, answered) in enumerate(rows, 1):
        lines.append(f"{medals.get(i, f'{i}.')} <@{uid}> — {score}点（正解 {correct}/{answered}）")
    return "\n".join(lines)


class AnswerPanel(GamePanelView):
    """4択の回答パネル（V2）。選択肢ボタンは choice_buttons に並ぶ。"""

    def __init__(self, cog, session: QuizSession, question, deadline: float,
                 title: str = "", body: str = ""):
        super().__init__(title, body, timeout=QUESTION_SECONDS + 5)
        self.cog = cog
        self.session = session
        self.deadline = deadline
        self.choice_buttons = []
        row = []
        for i, choice in enumerate(question["choices"]):
            btn = discord.ui.Button(label=str(choice)[:80], style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(i)
            self.choice_buttons.append(btn)
            row.append(btn)
            if len(row) == 2:
                self.add_row(*row)
                row = []
        if row:
            self.add_row(*row)

    def _make_callback(self, idx):
        async def callback(interaction: discord.Interaction):
            remaining = max(0.0, self.deadline - time.monotonic())
            ratio = remaining / QUESTION_SECONDS if QUESTION_SECONDS else 0.0
            if self.session.submit(interaction.user.id, idx, ratio):
                await interaction.response.send_message("回答を受け付けました。", ephemeral=True)
            else:
                await interaction.response.send_message("すでに回答済みです（1問につき1回まで）。", ephemeral=True)
        return callback


AnswerView = AnswerPanel  # 互換名


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
        view = LobbyView(
            title="🧠 クイズ大会 参加者募集", host=interaction.user,
            min_players=1, max_players=MAX_PLAYERS,
            note=(f"{QUESTION_COUNT}問の4択クイズで競います。\n"
                  f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します（途中参加もできます）。"),
            timeout=RECRUIT_SECONDS + 10)
        await interaction.response.send_message(view=view)
        lobby_msg = await original_response_or_none(interaction)
        asyncio.create_task(self._run(channel, view, lobby_msg))

    async def _run(self, channel, view: LobbyView, lobby_msg=None):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if view.started or view.cancelled:
                    break
                await asyncio.sleep(0.5)
            view.stop()
            # 募集パネルは開始（または取消）時点で役割を終える。
            await safe_delete(lobby_msg)
            if view.cancelled:
                return
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
            deadline = time.monotonic() + QUESTION_SECONDS
            view = AnswerPanel(
                self, session, q, deadline,
                title=f"第{number}問 / {total}問（{q['category']}）",
                body=f"**{q['q']}**\n制限時間: {QUESTION_SECONDS}秒")
            await game_panels.replace(channel, "party", view=view)
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
            # 答え合わせは次の問題パネルに置き換わるまでの表示（ボタンなし）。
            await game_panels.replace(channel, "party", view=text_panel(f"第{number}問の答え", desc))
            await asyncio.sleep(3)
        await game_panels.clear(channel, "party")
        await channel.send(view=text_panel("🏆 クイズ大会 結果発表", standings_text(session)))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in session.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Quiz(bot))
