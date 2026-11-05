# -*- coding: utf-8 -*-
"""ビンゴ大会（自動抽選・チャンネル単位）。

カードは開始時に全員へ配られ、「自分のカード確認」ボタンでいつでも
マーク状況が見られる。抽選は自動で進み、最初にラインを揃えた人が
勝者として party_ranking に記録される。賞金などのコイン要素は無い。
再起動をまたいだ復旧には対応していない（短時間のイベント想定）。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.bingo import BingoSession, format_card

logger = logging.getLogger(__name__)

party_ranking.register("bingo")

GAME_ID = "bingo"
RECRUIT_SECONDS = 60
DRAW_INTERVAL = 15
MIN_PLAYERS = 2


class CardCheckView(discord.ui.View):
    def __init__(self, cog, session: BingoSession):
        super().__init__(timeout=3600)
        self.cog = cog
        self.session = session

    @discord.ui.button(label="自分のカード確認", style=discord.ButtonStyle.secondary)
    async def check(self, interaction: discord.Interaction, button: discord.ui.Button):
        card = self.session.cards.get(interaction.user.id)
        if card is None:
            return await interaction.response.send_message("あなたは参加していません。", ephemeral=True)
        embed = discord.Embed(title="あなたのビンゴカード", description=f"```\n{format_card(card)}\n```", color=0xFFFFFF)
        embed.set_footer(text="[数字] はマーク済み、★ はフリースポットです。")
        await interaction.response.send_message(embed=embed, ephemeral=True)


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
        await interaction.response.send_message("ビンゴを開始します！")
        self.stop()


class Bingo(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels = set()

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。"""
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでにビンゴが開催中です。", ephemeral=True)
        self.channels.add(channel.id)
        view = RecruitView(interaction.user.id)
        embed = discord.Embed(
            title="🎱 ビンゴ大会 参加者募集",
            description=(f"参加ボタンを押してください（{MIN_PLAYERS}名以上で開始）。"
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
                    description=f"人数不足（{MIN_PLAYERS}名以上必要）のため、ビンゴを開始できませんでした。", color=0xFFFFFF))
                return
            session = BingoSession(players)
            mentions = " ".join(f"<@{uid}>" for uid in players)
            await channel.send(
                content=f"{mentions}\nビンゴを開始します！カードは「自分のカード確認」ボタンで見られます。"
                        f"抽選は{DRAW_INTERVAL}秒ごとに自動で進みます。",
                view=CardCheckView(self, session),
            )
            await self._draw_loop(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("Bingo: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    async def _draw_loop(self, channel, session: BingoSession):
        while not session.finished:
            await asyncio.sleep(DRAW_INTERVAL)
            number, winners, reach = session.draw_next()
            if number is None:
                break
            lines = [f"🎱 **{number}** が出ました。（{len(session.drawn)}球目）"]
            for uid in reach:
                lines.append(f"<@{uid}> さんが **リーチ** です！")
            await channel.send("\n".join(lines))
            if winners:
                names = " ".join(f"<@{uid}>" for uid in winners)
                await channel.send(embed=discord.Embed(
                    title="🎉 ビンゴ！", description=f"{names} さんが最初にラインを揃えました！", color=0xFFFFFF))
                guild = getattr(channel, "guild", None)
                if guild is not None:
                    for uid in winners:
                        await party_ranking.shared().record_win(guild.id, uid, GAME_ID)
                return


async def setup(bot):
    await bot.add_cog(Bingo(bot))
