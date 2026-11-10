# -*- coding: utf-8 -*-
"""にょっきゲーム（元ネタ: たけのこニョッキ）。

宣言はボタンではなく、対戦を開始したチャンネルでの実際の発言で行う。
「数字＋ニョッキ」の全文一致（core/game/nyokki/nyokki.py の
``parse_declaration``）を宣言として拾い、最初の宣言へのリアクションと
状態パネルの編集で進行を表示する。CPU の宣言は Bot がそのチャンネルに
実際に発言する形にする。
"""
import asyncio
import logging
import random
import time

import discord
from discord.ext import commands

from core.game.game import game_panels
from core.game.game.game_v2 import (
    GamePanelView,
    lobby_not_enough_text,
    original_response_or_none,
    safe_delete,
    text_panel,
)
from core.game.nyokki.nyokki import (
    MAX_PLAYERS,
    MAX_ROUNDS,
    MIN_PLAYERS,
    WINDOW_SECONDS,
    NyokkiSession,
    parse_declaration,
)

logger = logging.getLogger(__name__)

GAME_ID = "nyokki"
RECRUIT_SECONDS = 60
POLL_SECONDS = 0.25
ROUND_NOTICE_SECONDS = 4
CPU_ID_BASE = -1000  # CPU の仮ユーザーID（-1001, -1002, ...）

CHANT = "たけのこ、たけのこ、ニョッキッキ！"

REACTION_FIRST = "🌱"
REACTION_COLLISION = "💥"
REACTION_WRONG = "❌"


class _Match:
    """1チャンネル分の対戦状態（Discord 側）。"""

    def __init__(self, channel, session: NyokkiSession):
        self.channel = channel
        self.session = session
        self.lock = asyncio.Lock()
        self.panel_msg = None
        self.pending_message = None  # 最初の宣言のメッセージ（カブり時の💥用）
        self.forced_end = False
        self.eliminated_now: list = []  # このラウンドで脱落した人
        self.over = False


class Nyokki(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: set = set()   # 募集・対戦中のチャンネル
        self.matches: dict = {}      # channel_id -> _Match
        self._now = time.monotonic   # テストで差し替え可能
        self._sleep = asyncio.sleep  # テストで差し替え可能

    # ------------------------------------------------------------------
    # 募集（自前ロビー: CPU 追加ボタンが要るため ito と同じ流儀）
    # ------------------------------------------------------------------
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message(
                "このチャンネルではすでににょっきゲームが開催中です。", ephemeral=True)
        self.channels.add(channel.id)
        host_id = interaction.user.id
        players = [host_id]
        cpu_ids: list = []
        state = {"started": False}

        def lobby_body() -> str:
            entries = [f"<@{uid}>" + ("（ホスト）" if uid == host_id else "")
                       for uid in players]
            entries += [f"🤖 CPU{i + 1}" for i in range(len(cpu_ids))]
            return (f"宣言はボタンではなく、このチャンネルで「1ニョッキ！」のように"
                    f"実際に発言して行います（{MIN_PLAYERS}〜{MAX_PLAYERS}人、CPU追加可）。\n"
                    f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n"
                    f"参加者（{len(players) + len(cpu_ids)}人）: " + "、".join(entries))

        panel = GamePanelView("🌱 にょっきゲーム 参加者募集", lobby_body(),
                              timeout=RECRUIT_SECONDS + 30)

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) + len(cpu_ids) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=lobby_body())
            await inter.response.edit_message(view=panel)

        async def on_add_cpu(inter: discord.Interaction):
            if inter.user.id != host_id:
                return await inter.response.send_message("CPUを追加できるのはホストだけです。", ephemeral=True)
            if len(players) + len(cpu_ids) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            cpu_ids.append(CPU_ID_BASE - (len(cpu_ids) + 1))
            panel.set_content(body=lobby_body())
            await inter.response.edit_message(view=panel)

        async def on_start(inter: discord.Interaction):
            if inter.user.id != host_id:
                return await inter.response.send_message("開始できるのはホストだけです。", ephemeral=True)
            if len(players) + len(cpu_ids) < MIN_PLAYERS:
                return await inter.response.send_message(
                    f"人数不足（{MIN_PLAYERS}名以上必要）です。", ephemeral=True)
            state["started"] = True
            await inter.response.send_message("開始します！", ephemeral=True)

        join_btn = discord.ui.Button(label="参加する", style=discord.ButtonStyle.success)
        join_btn.callback = on_join
        cpu_btn = discord.ui.Button(label="CPUを追加（ホスト）", style=discord.ButtonStyle.secondary)
        cpu_btn.callback = on_add_cpu
        start_btn = discord.ui.Button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
        start_btn.callback = on_start
        panel.add_row(join_btn, cpu_btn, start_btn)
        await interaction.response.send_message(view=panel)
        lobby_msg = await original_response_or_none(interaction)
        asyncio.create_task(self._run_lobby(channel, players, cpu_ids, state, lobby_msg))

    async def _run_lobby(self, channel, players: list, cpu_ids: list, state: dict,
                         lobby_msg=None):
        try:
            for _ in range(RECRUIT_SECONDS * 4):
                if state["started"]:
                    break
                await self._sleep(POLL_SECONDS)
            # 募集パネルは開始（または不成立）時点で役割を終える。
            await safe_delete(lobby_msg)
            everyone = list(dict.fromkeys(players)) + list(cpu_ids)
            if len(everyone) < MIN_PLAYERS:
                await channel.send(view=text_panel(
                    "🌱 にょっきゲーム", lobby_not_enough_text(MIN_PLAYERS)))
                return
            session = NyokkiSession(everyone, cpu_ids=cpu_ids, rng=random.Random())
            match = _Match(channel, session)
            self.matches[channel.id] = match
            await self._run_match(match)
        except Exception:  # noqa: BLE001
            logger.exception("Nyokki: 進行中にエラーが発生しました")
        finally:
            self.matches.pop(channel.id, None)
            self.channels.discard(channel.id)

    # ------------------------------------------------------------------
    # 対戦の進行
    # ------------------------------------------------------------------
    async def _run_match(self, match: _Match):
        session = match.session
        while not session.finished:
            match.forced_end = False
            match.eliminated_now = []
            match.pending_message = None
            session.start_round(self._now())
            await self._show_round_panel(match, opening=True)
            while not session.round_over:
                await self._sleep(POLL_SECONDS)
                async with match.lock:
                    now = self._now()
                    for uid in session.due_cpu(now):
                        cpu_events, cpu_message = await self._cpu_declare(match, uid, now)
                        if cpu_events:
                            await self._apply_events(match, cpu_events,
                                                     source_message=cpu_message)
                    events = session.tick(now)
                if events:
                    await self._apply_events(match, events)
            await self._show_round_result(match)
            if not session.finished:
                await self._sleep(ROUND_NOTICE_SECONDS)
        match.over = True
        await self._show_final(match)

    async def _cpu_declare(self, match: _Match, user_id, now: float):
        """CPU の宣言を Bot の発言としてチャンネルに出す。(イベント, 発言) を返す。"""
        session = match.session
        number = session.cpu_number(user_id)
        message = await match.channel.send(f"🤖 **{self._cpu_name(user_id)}**: {number}ニョッキ！")
        events = session.declare(user_id, number, now)
        return events, message

    # ------------------------------------------------------------------
    # チャット宣言の受付
    # ------------------------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return
        match = self.matches.get(message.channel.id)
        if match is None or match.over:
            return
        number = parse_declaration(message.content)
        if number is None:
            return
        async with match.lock:
            events = match.session.declare(message.author.id, number, self._now())
        if events:
            await self._apply_events(match, events, source_message=message)

    # ------------------------------------------------------------------
    # イベントの反映（リアクション・通知・パネル更新）
    # ------------------------------------------------------------------
    async def _apply_events(self, match: _Match, events: list, source_message=None):
        session = match.session
        refresh = False
        for event in events:
            kind = event["type"]
            if kind == "first":
                refresh = True
                match.pending_message = source_message
                await self._react(source_message, REACTION_FIRST)
            elif kind == "escape":
                refresh = True
                match.pending_message = None
            elif kind == "collision":
                refresh = True
                await self._react(source_message, REACTION_COLLISION)
                await self._react(match.pending_message, REACTION_COLLISION)
                match.pending_message = None
                names = " と ".join(self._label(match, uid) for uid in event["users"])
                await match.channel.send(
                    f"💥 カブり！ {names} が同時に {event['number']}ニョッキ！"
                    f" 両者とも1アウトで、このラウンドは終了です。")
            elif kind == "wrong_number":
                refresh = True
                await self._react(source_message, REACTION_WRONG)
                await match.channel.send(
                    f"❌ {self._label(match, event['user'])} の {event['number']}ニョッキ は番号違い"
                    f"（対象は {event['target']}ニョッキ）。1アウトで、このラウンドは退場です。")
            elif kind == "extended":
                refresh = True
            elif kind == "forced_end":
                match.forced_end = True
            elif kind == "round_end":
                match.eliminated_now = list(event.get("eliminated") or [])
            elif kind == "last_one_out":
                refresh = True
        if refresh and not session.round_over:
            await self._refresh_panel(match)

    async def _react(self, message, emoji: str):
        if message is None:
            return
        try:
            await message.add_reaction(emoji)
        except Exception:  # noqa: BLE001 - リアクション失敗で進行を止めない
            logger.debug("Nyokki: リアクションを付けられませんでした", exc_info=True)

    # ------------------------------------------------------------------
    # 表示
    # ------------------------------------------------------------------
    def _cpu_name(self, user_id) -> str:
        return f"CPU{-user_id + CPU_ID_BASE}"

    def _label(self, match: _Match, user_id) -> str:
        if match.session.is_cpu(user_id):
            return f"🤖 {self._cpu_name(user_id)}"
        return f"<@{user_id}>"

    def _state_lines(self, match: _Match) -> list:
        session = match.session
        lines = []
        for uid in session.active:
            label = self._label(match, uid)
            outs = f"（アウト{session.outs[uid]}）" if session.outs[uid] else ""
            if uid in session.escaped:
                lines.append(f"✅ {label} — 勝ち抜け{outs}")
            elif uid in session.round_out:
                lines.append(f"❌ {label} — ラウンド退場{outs}")
            else:
                lines.append(f"🌱 {label}{outs}")
        fallen = [uid for uid in session.players
                  if uid in session.eliminated and uid not in session.active]
        for uid in fallen:
            lines.append(f"💀 {self._label(match, uid)} — 脱落")
        return lines

    def _round_panel(self, match: _Match, opening: bool = False) -> GamePanelView:
        session = match.session
        lines = []
        if opening:
            lines.append(f"**{CHANT}**")
        if session.pending is not None:
            lines.append(f"⏳ {self._label(match, session.pending[0])} が "
                         f"{session.target}ニョッキ！ カブり判定中…")
        else:
            extend = "（延長中）" if session.extended else ""
            lines.append(f"次の番号: **{session.target}ニョッキ！**"
                         f"（{int(WINDOW_SECONDS)}秒以内にチャットで宣言）{extend}")
        lines += self._state_lines(match)
        return GamePanelView(
            f"🌱 にょっきゲーム 第{session.round_no}ラウンド / {MAX_ROUNDS}",
            "\n".join(lines), timeout=None)

    async def _show_round_panel(self, match: _Match, opening: bool = False):
        message = await game_panels.replace(
            match.channel, "party", view=self._round_panel(match, opening=opening))
        match.panel_msg = message

    async def _refresh_panel(self, match: _Match):
        if match.panel_msg is None:
            return
        try:
            await match.panel_msg.edit(view=self._round_panel(match))
        except Exception:  # noqa: BLE001 - 編集失敗時は次の表示で立て直す
            logger.debug("Nyokki: パネルの更新に失敗しました", exc_info=True)

    async def _show_round_result(self, match: _Match):
        session = match.session
        lines = []
        if match.forced_end:
            lines.append("宣言が無かったため、このラウンドはここで終了します。")
        escaped = [uid for uid in session.active if uid in session.escaped]
        if escaped:
            lines.append("勝ち抜け: " + "、".join(self._label(match, uid) for uid in escaped))
        outed = [uid for uid in session.active if uid in session.round_out]
        if outed:
            lines.append("アウト: " + "、".join(
                f"{self._label(match, uid)}（{session.outs[uid]}つ）" for uid in outed))
        if match.eliminated_now:
            lines.append("💀 脱落: " + "、".join(
                self._label(match, uid) for uid in match.eliminated_now))
        alive = [uid for uid in session.players if uid not in session.eliminated]
        if not session.finished:
            lines.append(f"残り{len(alive)}人で第{session.round_no + 1}ラウンドへ進みます。")
        message = await game_panels.replace(
            match.channel, "party",
            view=text_panel(f"第{session.round_no}ラウンドの結果", "\n".join(lines) or "（記録なし）"))
        match.panel_msg = message

    async def _show_final(self, match: _Match):
        session = match.session
        await game_panels.clear(match.channel, "party")
        medals = {0: "🥇", 1: "🥈", 2: "🥉"}
        lines = []
        for i, (uid, outs, eliminated) in enumerate(session.result_rows()):
            mark = medals.get(i, f"{i + 1}.")
            state = "脱落" if eliminated else f"アウト{outs}"
            lines.append(f"{mark} {self._label(match, uid)} — {state}")
        if session.draw:
            head = "🤝 引き分けです（勝者はいません）"
        else:
            champs = "、".join(self._label(match, uid) for uid in session.champions)
            head = f"🏆 優勝: {champs}"
        await match.channel.send(view=text_panel(
            "🌱 にょっきゲーム 最終結果", head + "\n" + "\n".join(lines)))


async def setup(bot):
    await bot.add_cog(Nyokki(bot))
