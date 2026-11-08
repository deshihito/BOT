# -*- coding: utf-8 -*-
"""マジョリティ連想ゲーム（みんなの答えを合わせるゲーム）。

お題に全員が答えを出し、同じ答えを書いた人数が多いほど得点になる。
進行と集計は core/game/majority/majority.py。最終の最上位は party_ranking に記録。
"""
import asyncio
import io
import logging
import random

import discord
from discord.ext import commands

from core.game.game import game_panels, party_ranking
from core.game.game.board_image import render_bars, render_cached
from core.game.game.game_v2 import GamePanelView, LobbyView, original_response_or_none, safe_delete, text_panel
from core.game.majority.majority import TOPICS, MajoritySession

logger = logging.getLogger(__name__)

party_ranking.register("majority")

GAME_ID = "majority"
ROUNDS = 5
ANSWER_SECONDS = 45
RECRUIT_SECONDS = 60
MIN_PLAYERS = 3
MAX_PLAYERS = 99  # 実質無制限（共通ロビーの表示・定員チェック用に大きな値）


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


class AnswerPanel(GamePanelView):
    """お題への回答ボタン（モーダル起動）のパネル（V2）。"""

    def __init__(self, cog, session: MajoritySession, title: str, body: str):
        super().__init__(title, body, timeout=ANSWER_SECONDS + 10)
        self.cog = cog
        self.session = session
        self.answer = discord.ui.Button(label="答えを出す", style=discord.ButtonStyle.primary)
        self.answer.callback = self._answer
        self.add_row(self.answer)

    async def _answer(self, interaction: discord.Interaction):
        if interaction.user.id in self.session.answers:
            return await interaction.response.send_message("すでに答え済みです。", ephemeral=True)
        await interaction.response.send_modal(AnswerModal(self.cog, self.session))


AnswerView = AnswerPanel  # 互換名


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
        view = LobbyView(
            title="👥 マジョリティ連想 参加者募集", host=interaction.user,
            min_players=MIN_PLAYERS, max_players=MAX_PLAYERS,
            note=(f"お題に「みんなが書きそうな答え」を出すゲームです。"
                  f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。"),
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
                    "", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            topics = random.sample(TOPICS, ROUNDS)
            session = MajoritySession(topics)
            for uid in players:
                session.add_player(uid)
            names = {uid: getattr(m, "display_name", None) or f"プレイヤー{uid}"
                     for uid, m in view.members.items()}
            await self._play(channel, session, names)
        except Exception:  # noqa: BLE001
            logger.exception("Majority: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    def _bars_file(self, rows, filename: str) -> discord.File:
        key = ("majority-bars", filename, tuple(rows))
        data = render_cached(key, lambda: render_bars(rows))
        return discord.File(io.BytesIO(data), filename)

    async def _play(self, channel, session: MajoritySession, names: dict | None = None):
        names = names or {}
        while True:
            topic = session.next_round()
            if topic is None:
                break
            number = session.index + 1
            view = AnswerPanel(
                self, session,
                title=f"第{number}ラウンド / {ROUNDS}",
                body=f"お題: **{topic}**\n「答えを出す」ボタンから、みんなが書きそうな答えを1つ出してください（{ANSWER_SECONDS}秒）。")
            await game_panels.replace(channel, "party", view=view)
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
            # 結果は次のお題パネルに置き換わるまでの表示（ボタンなし）。
            # 回答の分布はバー画像でも示す（人数の差が一目で分かるように）。
            bar_rows = [(answer, len(uids)) for answer, uids in
                        sorted(result["groups"].items(), key=lambda kv: -len(kv[1]))]
            result_file = self._bars_file(bar_rows, "majority_round.png") if bar_rows else None
            await game_panels.replace(channel, "party", view=text_panel(
                f"第{number}ラウンドの結果", "\n".join(lines)[:4000]), file=result_file)
            await asyncio.sleep(3)
        rows = session.standings()
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        text = "\n".join(f"{medals.get(i, f'{i}.')} <@{uid}> — {score}点" for i, (uid, score) in enumerate(rows, 1)) or "参加者がいませんでした。"
        await game_panels.clear(channel, "party")
        final_file = None
        if rows:
            final_file = self._bars_file(
                [(names.get(uid, f"プレイヤー{uid}"), score) for uid, score in rows],
                "majority_final.png")
        await channel.send(view=text_panel("🏆 マジョリティ連想 最終結果", text),
                           file=final_file)
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in session.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Majority(bot))
