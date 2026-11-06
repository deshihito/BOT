# -*- coding: utf-8 -*-
"""ビンゴ大会（自動抽選・チャンネル単位）。

カードは開始時に全員へ配られ、「手札を確認」ボタンでいつでも
マーク状況が PIL 画像で見られる。抽選は自動で進み、最初にラインを
揃えた人が勝者として party_ranking に記録される。賞金などのコイン
要素は無い。再起動をまたいだ復旧には対応していない（短時間のイベント想定）。

抽選サイクル（レビュー対応 2026-11-06）: 間隔は15秒→10秒に短縮。
1サイクルは1メッセージで完結させ、開始7秒時点で「抽選中…」の
ローディング表示を出し、10秒時点でそのメッセージを編集して番号を
開示する（予告と開示で2通に増やさず、社交性のための演出だけ足す）。
開示メッセージには「手札を確認」ボタンを添える。
"""
import asyncio
import io
import logging

import discord
from discord.ext import commands

from core.support.emojis import POYOPOYO
from core.game import party_ranking
from core.game.bingo import BingoSession, format_card  # noqa: F401  format_card は cogs.bingo シムの再輸出用
from core.game.board_image import render_bingo_card, render_cached

logger = logging.getLogger(__name__)

party_ranking.register("bingo")

GAME_ID = "bingo"
RECRUIT_SECONDS = 60
DRAW_INTERVAL = 10
TEASE_SECONDS = 7  # サイクル開始からローディング表示を出すまでの秒数
MIN_PLAYERS = 2


def card_png(card) -> bytes:
    """自分のカードの PIL 画像（的中マス色付け・残り必要数は表示側で添える）。"""
    key = ("bingo-card",
           tuple(tuple(v for v in row) for row in card.grid),
           tuple(tuple(m for m in row) for row in card.marked))
    return render_cached(key, lambda: render_bingo_card(card.grid, card.marked))


class CardCheckView(discord.ui.View):
    def __init__(self, cog, session: BingoSession):
        super().__init__(timeout=3600)
        self.cog = cog
        self.session = session

    @discord.ui.button(label="手札を確認", style=discord.ButtonStyle.secondary)
    async def check(self, interaction: discord.Interaction, button: discord.ui.Button):
        card = self.session.cards.get(interaction.user.id)
        if card is None:
            return await interaction.response.send_message("あなたは参加していません。", ephemeral=True)
        needed = card.marks_needed()
        if card.has_bingo():
            caption = "🎉 ビンゴ成立！"
        elif needed == 1:
            caption = "🔥 **リーチ！** あと1個でビンゴです。"
        else:
            caption = f"あと **{needed}** 個でビンゴです。"
        embed = discord.Embed(title="あなたのビンゴカード", description=caption, color=0xFFFFFF)
        embed.set_image(url="attachment://bingo_card.png")
        embed.set_footer(text="橙色はマーク済み、★ はフリースポットです。")
        file = discord.File(io.BytesIO(card_png(card)), "bingo_card.png")
        await interaction.response.send_message(embed=embed, file=file, ephemeral=True)


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
                content=f"{mentions}\nビンゴを開始します！カードは「手札を確認」ボタンで見られます。"
                        f"抽選は{DRAW_INTERVAL}秒ごとに自動で進みます。",
                view=CardCheckView(self, session),
            )
            await self._draw_loop(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("Bingo: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    async def _draw_once(self, channel, session: BingoSession):
        """1サイクル分の抽選。ローディング表示→同じメッセージの編集で開示する。

        サイクル開始 TEASE_SECONDS 秒時点で「抽選中…」を送り、
        DRAW_INTERVAL 秒時点でそのメッセージを編集して番号を開示する。
        Returns: (引いた番号, 勝者, 新規リーチ者)。球切れなら番号は None。
        """
        await asyncio.sleep(TEASE_SECONDS)
        tease = await channel.send(
            f"{POYOPOYO} 抽選中… 次の番号は…？（{len(session.drawn) + 1}球目）")
        await asyncio.sleep(DRAW_INTERVAL - TEASE_SECONDS)
        number, winners, reach = session.draw_next()
        if number is None:
            await tease.edit(content="抽選できる番号がなくなりました。")
            return None, [], []
        lines = [f"🎱 **{number}** が出ました。（{len(session.drawn)}球目）"]
        for uid in reach:
            lines.append(f"<@{uid}> さんが **リーチ** です！")
        lines.append("これまで: " + " ".join(str(n) for n in session.drawn))
        await tease.edit(content="\n".join(lines), view=CardCheckView(self, session))
        return number, winners, reach

    async def _draw_loop(self, channel, session: BingoSession):
        while not session.finished:
            number, winners, reach = await self._draw_once(channel, session)
            if number is None:
                break
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
