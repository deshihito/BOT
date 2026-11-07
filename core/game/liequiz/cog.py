# -*- coding: utf-8 -*-
"""「うそ答えクイズ」（Fibbage 系）。

盤面表現: 盤面を持たない文章ゲームのため V2 構造化テキストのみ（画像化対象外。
判断は実装ログ参照）。嘘の提出はモーダル、投票はボタン式の選択肢
（選択肢ボタンは最大8人+本物=9個まで＝2行に収まるよう上限人数で担保）。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core.game.game import party_ranking
from core.game.game.game_v2 import GamePanelView, text_panel
from core.game.liequiz.liequiz import QUESTIONS, ROUNDS_DEFAULT, LieQuizSession

logger = logging.getLogger(__name__)

party_ranking.register("liequiz")

GAME_ID = "liequiz"
RECRUIT_SECONDS = 60
LIE_SECONDS = 45
VOTE_SECONDS = 30
MIN_PLAYERS = 3
MAX_PLAYERS = 8


class LieModal(discord.ui.Modal, title="嘘の答えを書く"):
    lie = discord.ui.TextInput(label="本物っぽい嘘の答え", max_length=60)

    def __init__(self, cog, session: LieQuizSession):
        super().__init__()
        self.cog = cog
        self.session = session

    async def on_submit(self, interaction: discord.Interaction):
        result = self.session.submit_lie(interaction.user.id, str(self.lie.value))
        if result == "ok":
            await interaction.response.send_message("嘘を受け付けました。", ephemeral=True)
        elif result == "is_truth":
            await interaction.response.send_message("それは本物の答えです。嘘を書いてください（もう一度開いて書き直せます）。", ephemeral=True)
        elif result == "duplicate":
            await interaction.response.send_message("他の人の嘘と被りました。別の嘘に書き直してください。", ephemeral=True)
        else:
            await interaction.response.send_message("受け付けできませんでした（提出済み・締切）。", ephemeral=True)


class LieQuiz(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, LieQuizSession | None] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🤥 うそ答えクイズ 参加者募集",
                              f"本物そっくりの嘘を作って騙し合うクイズです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"本物そっくりの嘘を作って騙し合うクイズです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("うそ答えクイズ", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            questions = random.sample(QUESTIONS, ROUNDS_DEFAULT)
            session = LieQuizSession(players, questions)
            self.channels[channel.id] = session
            await self._play(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("LieQuiz: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)

    async def _play(self, channel, session: LieQuizSession):
        while True:
            question = session.next_round()
            if question is None:
                break
            number = session.round_index + 1
            panel = GamePanelView(
                f"第{number}問 / {len(session.questions)}",
                f"お題: **{question}**\n「嘘を書く」から本物っぽい嘘の答えを入力してください（{LIE_SECONDS}秒）。\n"
                "本物と同じ答えや、他の人と被った嘘は書き直しになります。")

            async def on_lie(inter: discord.Interaction):
                if inter.user.id not in session.players:
                    return await inter.response.send_message("参加者だけが書けます。", ephemeral=True)
                if inter.user.id in session.lies:
                    return await inter.response.send_message("すでに提出済みです。", ephemeral=True)
                await inter.response.send_modal(LieModal(self, session))

            lie_btn = discord.ui.Button(label="嘘を書く", style=discord.ButtonStyle.primary)
            lie_btn.callback = on_lie
            panel.add_row(lie_btn)
            await channel.send(view=panel)
            for _ in range(LIE_SECONDS * 2):
                if len(session.lies) >= len(session.players):
                    break
                await asyncio.sleep(0.5)
            await self._vote_phase(channel, session, number)
            await asyncio.sleep(2)
        rows = session.standings()
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        text = "\n".join(f"{medals.get(i, f'{i}.')} <@{uid}> — {score}点" for i, (uid, score) in enumerate(rows, 1))
        await channel.send(view=text_panel("🏆 うそ答えクイズ 最終結果", text))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in session.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)

    async def _vote_phase(self, channel, session: LieQuizSession, number: int):
        choices = session.build_choices()
        panel = GamePanelView(
            f"第{number}問 投票",
            "本物だと思う答えを選んでください（自分の嘘には投票できません）。\n"
            + "\n".join(f"{i + 1}. {c['text']}" for i, c in enumerate(choices)))

        def make_vote(idx: int):
            async def on_vote(inter: discord.Interaction):
                if session.vote(inter.user.id, idx):
                    await inter.response.send_message("投票しました。", ephemeral=True)
                else:
                    await inter.response.send_message("投票できませんでした（自分の嘘・投票済み・参加者でない）。", ephemeral=True)
            return on_vote

        buttons = []
        for idx in range(len(choices)):
            btn = discord.ui.Button(label=f"{idx + 1}番", style=discord.ButtonStyle.primary)
            btn.callback = make_vote(idx)
            buttons.append(btn)
        for i in range(0, len(buttons), 5):
            panel.add_row(*buttons[i:i + 5])
        await channel.send(view=panel)
        for _ in range(VOTE_SECONDS * 2):
            if len(session.votes) >= len([p for p in session.players]):
                break
            await asyncio.sleep(0.5)
        result = session.tally()
        lines = []
        truth = session.current_q[1]
        lines.append(f"本物の答えは **{truth}** でした。")
        for idx, choice in enumerate(choices):
            voters = [uid for uid, v in session.votes.items() if v == idx]
            if choice["author"] is None:
                lines.append(f"{idx + 1}. {choice['text']}（本物）← " + ("、".join(f"<@{u}>" for u in voters) or "誰も選ばず"))
            else:
                lines.append(f"{idx + 1}. {choice['text']}（<@{choice['author']}> の嘘）← " + ("、".join(f"<@{u}>" for u in voters) or "誰も釣れず"))
        gained = "、".join(f"<@{uid}>:+{pts}" for uid, pts in result["gained"].items() if pts)
        lines.append(f"今回の得点: {gained or 'なし'}")
        await channel.send(view=text_panel(f"第{number}問 結果", "\n".join(lines)))


async def setup(bot):
    await bot.add_cog(LieQuiz(bot))
