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
from core.game.game import game_panels, party_ranking
from core.game.bingo.bingo import BingoSession, format_card  # noqa: F401  format_card は cogs.bingo シムの再輸出用
from core.game.game.board_image import render_bingo_card, render_cached
from core.game.game.game_v2 import GamePanelView, LobbyView, original_response_or_none, safe_delete, text_panel

logger = logging.getLogger(__name__)

party_ranking.register("bingo")

GAME_ID = "bingo"
RECRUIT_SECONDS = 60
DRAW_INTERVAL = 10
TEASE_SECONDS = 7  # サイクル開始からローディング表示を出すまでの秒数
MIN_PLAYERS = 2
MAX_PLAYERS = 99  # 実質無制限（共通ロビーの表示・定員チェック用）


def card_png(card) -> bytes:
    """自分のカードの PIL 画像（的中マス色付け・残り必要数は表示側で添える）。"""
    key = ("bingo-card",
           tuple(tuple(v for v in row) for row in card.grid),
           tuple(tuple(m for m in row) for row in card.marked))
    return render_cached(key, lambda: render_bingo_card(card.grid, card.marked))


class CardCheckPanel(GamePanelView):
    """進行表示＋「手札を確認」ボタンのパネル（V2）。

    開始アナウンスと各抽選の開示メッセージに付く。カード自体は
    本人にだけ見える ephemeral で返す（従来どおり）。
    """

    def __init__(self, cog, session: BingoSession, body: str = ""):
        super().__init__("", body, timeout=3600)
        self.cog = cog
        self.session = session
        self.check = discord.ui.Button(label="手札を確認", style=discord.ButtonStyle.secondary)
        self.check.callback = self._check
        self.add_row(self.check)

    async def _check(self, interaction: discord.Interaction):
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


CardCheckView = CardCheckPanel  # 互換名


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
        view = LobbyView(
            title="🎱 ビンゴ大会 参加者募集", host=interaction.user,
            min_players=MIN_PLAYERS, max_players=MAX_PLAYERS,
            note=(f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。"),
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
            # 募集パネルは開始（または不成立）時点で役割を終える。
            await safe_delete(lobby_msg)
            if view.cancelled:
                return
            players = list(dict.fromkeys(view.players))
            if len(players) < MIN_PLAYERS:
                await channel.send(view=text_panel(
                    "", f"人数不足（{MIN_PLAYERS}名以上必要）のため、ビンゴを開始できませんでした。"))
                return
            session = BingoSession(players)
            mentions = " ".join(f"<@{uid}>" for uid in players)
            # 開始アナウンスは最初の開示が出た時点で消える（last_draw_msg 経由）。
            session.last_draw_msg = await channel.send(view=CardCheckPanel(
                self, session,
                body=f"{mentions}\nビンゴを開始します！カードは「手札を確認」ボタンで見られます。"
                     f"抽選は{DRAW_INTERVAL}秒ごとに自動で進みます。"))
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
        tease = await channel.send(view=text_panel(
            "", f"{POYOPOYO} 抽選中… 次の番号は…？（{len(session.drawn) + 1}球目）"))
        await asyncio.sleep(DRAW_INTERVAL - TEASE_SECONDS)
        number, winners, reach = session.draw_next()
        if number is None:
            await tease.edit(view=text_panel("", "抽選できる番号がなくなりました。"))
            return None, [], []
        lines = [f"🎱 **{number}** が出ました。（{len(session.drawn)}球目）"]
        for uid in reach:
            lines.append(f"<@{uid}> さんが **リーチ** です！")
        lines.append("これまで: " + " ".join(str(n) for n in session.drawn))
        await tease.edit(view=CardCheckPanel(self, session, body="\n".join(lines)))
        # 前回の開示（または開始アナウンス）は新しい開示で役割を終える。
        previous = getattr(session, "last_draw_msg", None)
        if previous is not None and previous is not tease:
            await safe_delete(previous)
        session.last_draw_msg = tease
        return number, winners, reach

    async def _draw_loop(self, channel, session: BingoSession):
        while not session.finished:
            number, winners, reach = await self._draw_once(channel, session)
            if number is None:
                break
            if winners:
                names = " ".join(f"<@{uid}>" for uid in winners)
                # 最後の開示パネルを片付け、結果だけを残す。
                last = getattr(session, "last_draw_msg", None)
                if last is not None:
                    session.last_draw_msg = None
                    await safe_delete(last)
                await channel.send(view=text_panel(
                    "🎉 ビンゴ！", f"{names} さんが最初にラインを揃えました！"))
                guild = getattr(channel, "guild", None)
                if guild is not None:
                    for uid in winners:
                        await party_ranking.shared().record_win(guild.id, uid, GAME_ID)
                return


async def setup(bot):
    await bot.add_cog(Bingo(bot))
