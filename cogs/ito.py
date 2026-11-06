# -*- coding: utf-8 -*-
"""「たとえナンバー」（ito 系の協力ゲーム）。

盤面表現: 数字そのものが秘匿情報で、公開されるのは「出された順と数字」だけ。
V2 Container にテーマと公開済みカードをタイル状テキストで構造化する
（画像化する盤面ではない。判断は実装ログ参照）。
会話はチャット前提で、bot は配布・出す順の管理・成否判定に徹する。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core import game_records
from core.game_v2 import GamePanelView, text_panel
from core.ito import ROUNDS_DEFAULT, THEMES, ItoSession

logger = logging.getLogger(__name__)

GAME_ID = "ito"
RECRUIT_SECONDS = 60
ROUND_SECONDS = 180
MIN_PLAYERS = 2
MAX_PLAYERS = 10


class Ito(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, ItoSession | None] = {}
        self.messages: dict[int, discord.Message] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🔢 たとえナンバー 参加者募集",
                              f"数字を言葉で例え合い、小さい順に出す協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"数字を言葉で例え合い、小さい順に出す協力ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("たとえナンバー", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            themes = random.sample(THEMES, ROUNDS_DEFAULT)
            session = ItoSession(players, themes)
            self.channels[channel.id] = session
            await self._play(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("Ito: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    async def _play(self, channel, session: ItoSession):
        while True:
            theme = session.next_round()
            if theme is None:
                break
            await self._round_panel(channel, session)
            for _ in range(ROUND_SECONDS * 2):
                if session.round_done:
                    break
                await asyncio.sleep(0.5)
            revealed = " → ".join(f"<@{uid}>:{num}" for uid, num in session.revealed()) or "（誰も出せませんでした）"
            if session.round_done:
                head = "🎉 成功！ 全て昇順でした" if session.round_success else "💦 失敗… 順番が合いませんでした"
            else:
                head = "⏰ 時間切れで打ち切りです"
            await channel.send(view=text_panel(
                f"テーマ「{theme}」の結果", f"{head}\n出された順: {revealed}"))
            await asyncio.sleep(2)
        await channel.send(view=text_panel(
            "🏆 たとえナンバー 結果",
            f"チームの成績: **{session.successes} / {len(session.themes)} テーマ成功**\n"
            + "参加者: " + " ".join(f"<@{p}>" for p in session.players)))
        for uid in session.players:
            game_records.record_ito_safely(uid, session.successes, len(session.themes))

    async def _round_panel(self, channel, session: ItoSession):
        number = session.round_index + 1
        panel = GamePanelView(
            f"テーマ{number}「{session.theme}」",
            "「数字を見る」で自分の数字を本人だけ確認してください。\n"
            "数字そのものは言わず、テーマに沿って大きさを例えて話し合い、"
            f"小さいと思う人から「カードを出す」を押してください（話し合い {ROUND_SECONDS // 60}分）。\n"
            "出されたカードは数字つきで公開されます。")

        async def on_show(inter: discord.Interaction):
            if inter.user.id not in session.numbers:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            await inter.response.send_message(
                view=GamePanelView("あなたの数字", f"テーマ「{session.theme}」\nあなたの数字は **{session.numbers[inter.user.id]}** です。"),
                ephemeral=True)

        async def on_play(inter: discord.Interaction):
            if not session.play(inter.user.id):
                return await inter.response.send_message("出せませんでした（参加者でない・提出済み・終了）。", ephemeral=True)
            await inter.response.send_message("カードを出しました。", ephemeral=True)
            await self._refresh_panel(channel, session)

        show_btn = discord.ui.Button(label="数字を見る", style=discord.ButtonStyle.secondary)
        show_btn.callback = on_show
        play_btn = discord.ui.Button(label="カードを出す", style=discord.ButtonStyle.primary)
        play_btn.callback = on_play
        panel.add_row(show_btn, play_btn)
        msg = await channel.send(view=panel)
        self.messages[channel.id] = msg

    async def _refresh_panel(self, channel, session: ItoSession):
        msg = self.messages.get(channel.id)
        if msg is None:
            return
        revealed = session.revealed()
        tiles = " ".join(f"[{num}]" for _, num in revealed) or "（まだ出ていません）"
        remaining = [uid for uid in session.players if uid not in session.played]
        panel = GamePanelView(
            f"テーマ{session.round_index + 1}「{session.theme}」",
            f"出されたカード: {tiles}\n"
            f"出した人: " + ("、".join(f"<@{uid}>" for uid, _ in revealed) or "なし") + "\n"
            f"残り: " + ("、".join(f"<@{uid}>" for uid in remaining) or "なし"))
        # 操作ボタンは元のパネルと同じものを付け直す
        async def on_show(inter: discord.Interaction):
            if inter.user.id not in session.numbers:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            await inter.response.send_message(
                view=GamePanelView("あなたの数字", f"あなたの数字は **{session.numbers[inter.user.id]}** です。"),
                ephemeral=True)

        async def on_play(inter: discord.Interaction):
            if not session.play(inter.user.id):
                return await inter.response.send_message("出せませんでした。", ephemeral=True)
            await inter.response.send_message("カードを出しました。", ephemeral=True)
            await self._refresh_panel(channel, session)

        show_btn = discord.ui.Button(label="数字を見る", style=discord.ButtonStyle.secondary)
        show_btn.callback = on_show
        play_btn = discord.ui.Button(label="カードを出す", style=discord.ButtonStyle.primary)
        play_btn.callback = on_play
        panel.add_row(show_btn, play_btn)
        await msg.edit(view=panel)


async def setup(bot):
    await bot.add_cog(Ito(bot))
