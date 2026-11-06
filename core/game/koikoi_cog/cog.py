# -*- coding: utf-8 -*-
"""花札こいこい（2人・3局戦、対人 / CPU）。

場札と取り札は公開、手札だけは本人の ephemeral ビューで見て出す。
進行は core/game/koikoi.py の状態機械に従い、手番は120秒で自動プレイする。
勝者は core/party_ranking.py の koikoi に記録する。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core import party_ranking
from core.game import game_panels
from core.game.koikoi import CARDS, KoikoiMatch, card_label, cpu_choose_capture, cpu_choose_play, cpu_decide, evaluate

logger = logging.getLogger(__name__)

GAME_ID = "koikoi"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 120
CPU_ID = 0


def _cards_text(cards) -> str:
    return "、".join(card_label(c) for c in cards) or "なし"


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


class PanelView(discord.ui.View):
    """公開パネル: 手札ボタンと、判断フェーズの こいこい／勝負。"""

    def __init__(self, cog, session):
        super().__init__(timeout=TURN_SECONDS + 30)
        self.cog = cog
        self.session = session
        match: KoikoiMatch = session["match"]
        if match.phase == "decision":
            koikoi = discord.ui.Button(label="こいこい（続行）", style=discord.ButtonStyle.primary)
            koikoi.callback = self._make_decide_callback(True)
            self.add_item(koikoi)
            shoubu = discord.ui.Button(label="勝負（ここで確定）", style=discord.ButtonStyle.success)
            shoubu.callback = self._make_decide_callback(False)
            self.add_item(shoubu)
        else:
            hand = discord.ui.Button(label="手札を見て出す", style=discord.ButtonStyle.primary)
            hand.callback = self._hand_callback
            self.add_item(hand)

    async def _hand_callback(self, interaction: discord.Interaction):
        match: KoikoiMatch = self.session["match"]
        if match.phase != "play" or match.current != interaction.user.id:
            return await interaction.response.send_message("今はあなたの番ではありません。", ephemeral=True)
        await interaction.response.send_message("出す札を選んでください。",
                                                view=HandView(self.cog, self.session), ephemeral=True)

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


class JoinView(discord.ui.View):
    def __init__(self, session):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.session = session

    @discord.ui.button(label="参加（最大2人）", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        members = self.session["members"]
        if interaction.user.id in members:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(members) >= 2:
            return await interaction.response.send_message("定員です。", ephemeral=True)
        members[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました。")


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
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="🎴 こいこい 参加者募集",
                description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦・3局戦）。",
                color=COLOR), view=JoinView(session))
            await asyncio.sleep(RECRUIT_SECONDS)
            if len(session["members"]) < 2:
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
                await channel.send(embed=discord.Embed(title="🎴 局終了", description=text, color=COLOR))
                await asyncio.sleep(3)
                match.start_round()
                continue
            await self._run_turn(session)
        # 対局終了
        scores = "・".join(f"{members[pid].mention} {match.scores[pid]}点" for pid in match.players)
        if match.match_winner is None:
            text = f"引き分けです。\n{scores}"
        else:
            text = f"🏆 勝者: {members[match.match_winner].mention}\n{scores}"
            if session["mode"] != "cpu":
                await party_ranking.shared().record_win(session["guild_id"], match.match_winner, GAME_ID)
        if session["mode"] == "cpu":
            text += "\n（CPU戦はランキングに記録されません）"
        await channel.send(embed=discord.Embed(title="🎴 こいこい 終了", description=text, color=COLOR))

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
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="🎴 こいこい", description=public_state_text(match, members, turn_note), color=COLOR),
                view=PanelView(self, session))
            try:
                await asyncio.wait_for(session["acted"].wait(), timeout=TURN_SECONDS)
            except asyncio.TimeoutError:
                await channel.send(f"{members[current].mention} さんは時間切れのため、自動でプレイしました。")
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
