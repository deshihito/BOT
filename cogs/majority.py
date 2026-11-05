# -*- coding: utf-8 -*-
"""マジョリティ連想ゲーム（みんなの答えを合わせるゲーム）。

お題に全員が答えを出し、同じ答えを書いた人数が多いほど得点になる。
進行と集計は core/majority.py。最終の最上位は party_ranking に記録。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core import party_ranking
from core.majority import TOPICS, MajoritySession

logger = logging.getLogger(__name__)

party_ranking.register("majority")

GAME_ID = "majority"
ROUNDS = 5
ANSWER_SECONDS = 45
RECRUIT_SECONDS = 60
MIN_PLAYERS = 3


class AnswerModal(discord.ui.Modal, title="答えを出す"):
    answer = discord.ui.TextInput(label="答え（みんなが書きそうなものを1つ）", max_length=50)

    def __init__(self, cog, session: MajoritySession):
        super().__init__()
        self.cog = cog
        self.session = session

    async def on_submit(self, interaction: discord.Interaction):
        if self.session.submit(interaction.user.id, str(self.answer.value)):
            await interaction.response.send_message("答えを受け付けました。", ephemeral=True)
        else:
            await interaction.response.send_message("すでに答え済みか、受付が終わっています。", ephemeral=True)


class AnswerView(discord.ui.View):
    def __init__(self, cog, session: MajoritySession):
        super().__init__(timeout=ANSWER_SECONDS + 10)
        self.cog = cog
        self.session = session

    @discord.ui.button(label="答えを出す", style=discord.ButtonStyle.primary)
    async def answer(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id in self.session.answers:
            return await interaction.response.send_message("すでに答え済みです。", ephemeral=True)
        await interaction.response.send_modal(AnswerModal(self.cog, self.session))


class RecruitView(discord.ui.View):
    def __init__(self, host_id):
        super().__init__(timeout=RECRUIT_SECONDS + 10)
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
        await interaction.response.send_message("マジョリティ連想を開始します！")
        self.stop()


class Majority(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels = set()

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。"""
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでにマジョリティ連想が開催中です。", ephemeral=True)
        self.channels.add(channel.id)
        view = RecruitView(interaction.user.id)
        embed = discord.Embed(
            title="👥 マジョリティ連想 参加者募集",
            description=(f"お題に「みんなが書きそうな答え」を出すゲームです（{MIN_PLAYERS}名以上で開始）。"
                         f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。"),
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
            players = list(dict.fromkeys(view.players))
            if len(players) < MIN_PLAYERS:
                await channel.send(embed=discord.Embed(
                    description=f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。", color=0xFFFFFF))
                return
            topics = random.sample(TOPICS, ROUNDS)
            session = MajoritySession(topics)
            for uid in players:
                session.add_player(uid)
            await self._play(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("Majority: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    async def _play(self, channel, session: MajoritySession):
        while True:
            topic = session.next_round()
            if topic is None:
                break
            number = session.index + 1
            embed = discord.Embed(
                title=f"第{number}ラウンド / {ROUNDS}",
                description=f"お題: **{topic}**\n「答えを出す」ボタンから、みんなが書きそうな答えを1つ出してください（{ANSWER_SECONDS}秒）。",
                color=0xFFFFFF,
            )
            view = AnswerView(self, session)
            await channel.send(embed=embed, view=view)
            for _ in range(ANSWER_SECONDS * 2):
                if session.all_answered():
                    break
                await asyncio.sleep(0.5)
            view.stop()
            result = session.tally()
            lines = []
            for answer, uids in sorted(result["groups"].items(), key=lambda kv: -len(kv[1])):
                names = " ".join(f"<@{u}>" for u in uids)
                pts = len(uids) if len(uids) >= 2 else 0
                lines.append(f"「{answer}」× {len(uids)}人（+{pts}点）: {names}")
            if not lines:
                lines.append("回答がありませんでした。")
            await channel.send(embed=discord.Embed(
                title=f"第{number}ラウンドの結果", description="\n".join(lines)[:4000], color=0xFFFFFF))
            await asyncio.sleep(3)
        rows = session.standings()
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        text = "\n".join(f"{medals.get(i, f'{i}.')} <@{uid}> — {score}点" for i, (uid, score) in enumerate(rows, 1)) or "参加者がいませんでした。"
        await channel.send(embed=discord.Embed(title="🏆 マジョリティ連想 最終結果", description=text, color=0xFFFFFF))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in session.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Majority(bot))
