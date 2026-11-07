# -*- coding: utf-8 -*-
"""花札こいこい（2人・3局戦、対人 / CPU）。

場札と取り札は公開パネルに札の画像で表示し、手札だけは本人の
ephemeral ビューで画像＋セレクトで見て出す。
進行は core/game/koikoi/koikoi.py の状態機械に従い、手番は120秒で自動プレイする。
勝者は core/game/game/party_ranking.py の koikoi に記録する。
"""
import asyncio
import io
import logging
import random

import discord
from discord.ext import commands

from core.game.game import board_image, party_ranking
from core.game.game import game_panels
from core.game.game.board_image import render_cached
from core.game.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.game.koikoi.koikoi import CARDS, KoikoiMatch, card_label, cpu_choose_capture, cpu_choose_play, cpu_decide, evaluate

logger = logging.getLogger(__name__)

GAME_ID = "koikoi"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 120
CPU_ID = 0

BOARD_IMAGE_NAME = "koikoi_board.png"
HAND_IMAGE_NAME = "koikoi_hand.png"
_KIND_ORDER = ("hikari", "tane", "tanzaku", "kasu")
_KIND_LABELS = {"hikari": "光", "tane": "種", "tanzaku": "短冊", "kasu": "カス"}


def _cards_text(cards) -> str:
    return "、".join(card_label(c) for c in cards) or "なし"


# --- 札の画像（花札描画基盤） -------------------------------------------------
def public_board_rows(match: KoikoiMatch, members: dict) -> list:
    """公開画像の行構成 [(ラベル, [札id...]), ...] を返す。

    場札と取り札（種別ごとにグループ化）だけから作り、手札は一切含めない
    （秘匿の担保。テストで構造的に検証する）。
    """
    rows = []
    if match.field:
        rows.append(("場の札", list(match.field)))
    for pid in match.players:
        name = members[pid].display_name
        for kind in _KIND_ORDER:
            group = sorted((c for c in match.captured[pid]
                            if CARDS[c]["kind"] == kind),
                           key=lambda c: (CARDS[c]["month"], c))
            if group:
                rows.append((f"{name} の{_KIND_LABELS[kind]}（{len(group)}枚）",
                             group))
    return rows


def public_board_file(match: KoikoiMatch, members: dict):
    """公開パネル用の盤面画像ファイル。表示する札が無ければ None。"""
    rows = public_board_rows(match, members)
    if not rows:
        return None
    key = ("koikoi-board", tuple(match.field),
           tuple(sorted(match.captured[match.players[0]])),
           tuple(sorted(match.captured[match.players[1]])))
    data = render_cached(key, lambda: board_image.render_hanafuda_rows(rows))
    return discord.File(io.BytesIO(data), filename=BOARD_IMAGE_NAME)


def hand_image_data(hand, field_months) -> bytes:
    """自分の手札だけから手札画像を作る（場と合う札は金の枠で示す）。"""
    hand = list(hand)
    months = set(field_months)
    highlight = frozenset(i for i, c in enumerate(hand)
                          if CARDS[c]["month"] in months)
    key = ("koikoi-hand", tuple(hand), tuple(sorted(months)))
    return render_cached(key, lambda: board_image.render_hanafuda_hand(
        hand, title="あなたの手札", highlight=highlight))


def hand_file(match: KoikoiMatch, pid):
    """本人の ephemeral ビューに付ける手札画像ファイル。"""
    field_months = {CARDS[c]["month"] for c in match.field}
    data = hand_image_data(match.hands[pid], field_months)
    return discord.File(io.BytesIO(data), filename=HAND_IMAGE_NAME)


def public_state_text(match: KoikoiMatch, members: dict, note: str = "") -> str:
    lines = [f"第{match.round_no}局／スコア: " +
             "・".join(f"{members[pid].mention} {match.scores[pid]}点" for pid in match.players)]
    lines.append("場: " + _cards_text(match.field))
    for pid in match.players:
        points, yaku = evaluate(match.captured[pid])
        yaku_text = f"／役: {'・'.join(yaku)}（{points}点）" if yaku else ""
        koikoi_text = f"／こいこい×{match.koikoi_counts[pid]}" if match.koikoi_counts[pid] else ""
        lines.append(f"{members[pid].mention} の取り札（{len(match.captured[pid])}枚）: "
                     f"{_cards_text(match.captured[pid])}{yaku_text}{koikoi_text}")
    if note:
        lines.append(note)
    return "\n".join(lines)


class CaptureSelectView(discord.ui.View):
    """取り札を2枚から選ぶ ephemeral ビュー。"""

    def __init__(self, cog, session, stage: str):
        super().__init__(timeout=55)
        self.cog = cog
        self.session = session
        self.stage = stage
        match: KoikoiMatch = session["match"]
        options = [discord.SelectOption(label=card_label(c), value=str(c)) for c in match.pending["candidates"]]
        select = discord.ui.Select(placeholder="どちらの札を取る？", options=options)
        select.callback = self._callback
        self.add_item(select)

    async def _callback(self, interaction: discord.Interaction):
        session = self.session
        match: KoikoiMatch = session["match"]
        pid = interaction.user.id
        chosen = None
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.values:
                chosen = int(item.values[0])
        if chosen is None or match.current != pid:
            return await interaction.response.send_message("この選択は無効です。", ephemeral=True)
        event = match.choose_capture(pid, chosen)
        session["turn_events"].append(event)
        if match.phase == "choose_draw_capture":
            await interaction.response.edit_message(
                content="山からめくった札でも、取る札を選んでください。",
                view=CaptureSelectView(self.cog, session, "draw"))
            return
        await interaction.response.edit_message(content="取りました。", view=None)
        session["acted"].set()
        self.stop()


class HandView(discord.ui.View):
    """手札を本人だけに示し、出す札を選ばせる ephemeral ビュー。"""

    def __init__(self, cog, session):
        super().__init__(timeout=55)
        self.cog = cog
        self.session = session
        match: KoikoiMatch = session["match"]
        pid = match.current
        options = []
        for c in match.hands[pid]:
            matches = [f for f in match.field if CARDS[f]["month"] == CARDS[c]["month"]]
            desc = f"場の {card_label(matches[0])} と取れます" if matches else "場に出します"
            options.append(discord.SelectOption(label=card_label(c), value=str(c), description=desc))
        select = discord.ui.Select(placeholder="出す札を選んでください", options=options)
        select.callback = self._callback
        self.add_item(select)

    async def _callback(self, interaction: discord.Interaction):
        session = self.session
        match: KoikoiMatch = session["match"]
        pid = interaction.user.id
        if match.current != pid or match.phase != "play":
            return await interaction.response.send_message("今は出せません。", ephemeral=True)
        chosen = None
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.values:
                chosen = int(item.values[0])
        event = match.play_hand(pid, chosen)
        session["turn_events"].append(event)
        if match.phase == "choose_hand_capture":
            await interaction.response.edit_message(
                content="同じ月の札が2枚あります。取る札を選んでください。",
                view=CaptureSelectView(self.cog, session, "hand"))
            return
        if match.phase == "choose_draw_capture":
            await interaction.response.edit_message(
                content="山からめくった札で、取る札を選んでください。",
                view=CaptureSelectView(self.cog, session, "draw"))
            return
        await interaction.response.edit_message(content="出しました。", view=None)
        session["acted"].set()
        self.stop()


class KoikoiPanel(GamePanelView):
    """公開パネル（V2）: 盤面画像＋手札ボタン、判断フェーズでは こいこい／勝負。"""

    def __init__(self, cog, session, body: str = "", board_file=None):
        super().__init__("🎴 こいこい", body, timeout=TURN_SECONDS + 30)
        self.cog = cog
        self.session = session
        if board_file is not None:
            gallery = discord.ui.MediaGallery()
            gallery.add_item(media=f"attachment://{BOARD_IMAGE_NAME}")
            self.add_extra(gallery)
        match: KoikoiMatch = session["match"]
        self.koikoi = self.shoubu = self.hand_button = None
        if match.phase == "decision":
            self.koikoi = discord.ui.Button(label="こいこい（続行）", style=discord.ButtonStyle.primary)
            self.koikoi.callback = self._make_decide_callback(True)
            self.shoubu = discord.ui.Button(label="勝負（ここで確定）", style=discord.ButtonStyle.success)
            self.shoubu.callback = self._make_decide_callback(False)
            self.add_row(self.koikoi, self.shoubu)
        else:
            self.hand_button = discord.ui.Button(label="手札を見て出す", style=discord.ButtonStyle.primary)
            self.hand_button.callback = self._hand_callback
            self.add_row(self.hand_button)

    async def _hand_callback(self, interaction: discord.Interaction):
        match: KoikoiMatch = self.session["match"]
        if match.phase != "play" or match.current != interaction.user.id:
            return await interaction.response.send_message("今はあなたの番ではありません。", ephemeral=True)
        await interaction.response.send_message(
            "出す札を選んでください。（金の枠は場と合う札です）",
            view=HandView(self.cog, self.session), ephemeral=True,
            file=hand_file(match, interaction.user.id))

    def _make_decide_callback(self, koikoi: bool):
        async def callback(interaction: discord.Interaction):
            match: KoikoiMatch = self.session["match"]
            if match.phase != "decision" or match.current != interaction.user.id:
                return await interaction.response.send_message("今はあなたが判断する番ではありません。", ephemeral=True)
            event = match.decide(interaction.user.id, koikoi)
            self.session["turn_events"].append(event)
            await interaction.response.defer()
            self.session["acted"].set()
            self.stop()
        return callback


PanelView = KoikoiPanel  # 互換名


class Koikoi(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions = {}

    async def start_recruit(self, interaction: discord.Interaction, mode="human", difficulty=5):
        channel = interaction.channel
        if channel.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に進行中です。", ephemeral=True)
        session = {"members": {}, "channel": channel, "guild_id": interaction.guild_id,
                   "mode": mode, "match": None, "acted": asyncio.Event(), "turn_events": []}
        self.sessions[channel.id] = session
        try:
            if mode == "cpu":
                session["members"] = {interaction.user.id: interaction.user, CPU_ID: None}
                await interaction.response.send_message("こいこいCPU対戦を開始します。")
                session["match"] = KoikoiMatch([interaction.user.id, CPU_ID], rng=random.Random())
                await self._run_match(session)
                return
            session["members"] = {interaction.user.id: interaction.user}
            await interaction.response.send_message("こいこいの募集を開始しました。")
            lobby = LobbyView(
                title="🎴 こいこい 参加者募集", host=interaction.user,
                min_players=2, max_players=2,
                note=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦・3局戦）。",
                timeout=RECRUIT_SECONDS + 30)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            session["members"] = dict(lobby.members)
            if len(session["members"]) < 2:
                await game_panels.clear(channel, "party")
                await channel.send("参加者が2人集まらなかったため、開始できませんでした。")
                return
            session["match"] = KoikoiMatch(list(session["members"].keys()), rng=random.Random())
            await self._run_match(session)
        finally:
            self.sessions.pop(channel.id, None)

    # ------------------------------------------------------------------
    def _members_for_text(self, session) -> dict:
        members = dict(session["members"])
        if CPU_ID in members and members[CPU_ID] is None:
            class _Cpu:
                id = CPU_ID
                mention = "CPU"
                display_name = "CPU"
            members[CPU_ID] = _Cpu()
        return members

    async def _run_match(self, session):
        channel = session["channel"]
        match: KoikoiMatch = session["match"]
        members = self._members_for_text(session)
        while match.phase != "match_end":
            if match.phase == "round_end":
                result = match.round_result
                if result["winner"] is None:
                    text = f"第{match.round_no}局は流局でした。"
                else:
                    text = (f"第{match.round_no}局: {members[result['winner']].mention} が "
                            f"{result['base_points']}点×{result['multiplier']}＝{result['gained']}点を取りました。")
                await channel.send(view=text_panel("🎴 局終了", text))
                await asyncio.sleep(3)
                match.start_round()
                continue
            await self._run_turn(session)
        # 対局終了: 進行パネルと残っている通知を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        notice = session.pop("last_notice", None)
        if notice is not None:
            await safe_delete(notice)
        scores = "・".join(f"{members[pid].mention} {match.scores[pid]}点" for pid in match.players)
        if match.match_winner is None:
            text = f"引き分けです。\n{scores}"
        else:
            text = f"🏆 勝者: {members[match.match_winner].mention}\n{scores}"
            if session["mode"] != "cpu":
                await party_ranking.shared().record_win(session["guild_id"], match.match_winner, GAME_ID)
        if session["mode"] == "cpu":
            text += "\n（CPU戦はランキングに記録されません）"
        await channel.send(view=text_panel("🎴 こいこい 終了", text))

    async def _run_turn(self, session):
        channel = session["channel"]
        match: KoikoiMatch = session["match"]
        members = self._members_for_text(session)
        session["turn_events"] = []
        current = match.current
        is_cpu_turn = session["mode"] == "cpu" and current == CPU_ID
        note = ""
        while True:
            phase = match.phase
            if phase in ("round_end", "match_end"):
                break
            if is_cpu_turn:
                await asyncio.sleep(1)
                self._auto_action(session)
                if match.phase not in ("choose_hand_capture", "choose_draw_capture", "decision"):
                    break
                continue
            turn_note = note
            if phase == "decision":
                points = match.pending["points"]
                turn_note = (f"{members[current].mention} さんに役ができました（{points}点）。"
                             "「こいこい（続行）」か「勝負（確定）」を選んでください。")
            else:
                turn_note = (turn_note + "\n" if turn_note else "") + \
                    f"{members[current].mention} さんの番です。「手札を見て出す」から札を選んでください。"
            session["acted"].clear()
            # 前ターンの時間切れ通知は、新しい手番パネルが出た時点で片付ける。
            old_notice = session.pop("last_notice", None)
            if old_notice is not None:
                await safe_delete(old_notice)
            board = public_board_file(match, members)
            panel_kwargs = {}
            if board is not None:
                panel_kwargs["file"] = board
            await game_panels.replace(
                channel, "party",
                view=KoikoiPanel(self, session,
                                 body=public_state_text(match, members, turn_note),
                                 board_file=board),
                **panel_kwargs)
            try:
                await asyncio.wait_for(session["acted"].wait(), timeout=TURN_SECONDS)
            except asyncio.TimeoutError:
                session["last_notice"] = await channel.send(
                    f"{members[current].mention} さんは時間切れのため、自動でプレイしました。")
                self._auto_action(session)
            if match.phase == "decision":
                note = ""
                continue
            break
        await self._announce_turn(session)

    def _auto_action(self, session):
        """現在のフェーズを CPU ロジックで1手進める（CPU手番・時間切れ共用）。"""
        match: KoikoiMatch = session["match"]
        pid = match.current
        if match.phase == "play":
            event = match.play_hand(pid, cpu_choose_play(match, pid))
            session["turn_events"].append(event)
        if match.phase in ("choose_hand_capture", "choose_draw_capture"):
            event = match.choose_capture(pid, cpu_choose_capture(match, pid, match.pending["candidates"]))
            session["turn_events"].append(event)
        if match.phase == "decision":
            event = match.decide(pid, cpu_decide(match, pid, match.pending["points"]))
            session["turn_events"].append(event)

    async def _announce_turn(self, session):
        events = session["turn_events"]
        if not events:
            return
        match: KoikoiMatch = session["match"]
        members = self._members_for_text(session)
        first = events[0]
        parts = []
        played = first.get("played")
        # 手番の主体は秘匿しない札の動きだけを簡潔に知らせる
        if played is not None:
            parts.append(f"手札から **{card_label(played)}** が出ました。")
        for ev in events:
            if ev.get("drawn") is not None:
                parts.append(f"山からは **{card_label(ev['drawn'])}**。")
            if "koikoi" in ev:
                parts.append("**こいこい！**" if ev["koikoi"] else "**勝負！**")
        if parts:
            await session["channel"].send(" ".join(parts))


async def setup(bot):
    await bot.add_cog(Koikoi(bot))
