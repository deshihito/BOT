# -*- coding: utf-8 -*-
"""ギャンブル系: /general のマネージャンルから使うスロット／ダブルアップ／
ブラックジャック／ダイスの入口。

本体は core/gambling.py（内部状態・セッション・抽選と判定）で、ここは
Discord 側の表示と、AGO コイン残高の実移動だけを担う。コインの増減は
必ず cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通す（cogs/circulation.py と同じ組み立て）。

- ベットは開始時に wallet から差し引いてセッションに預ける
  （エスクロー）。セッション状態は core/gambling.py のストアに永続化
  されるため、Bot が再起動してもベットが消えることはない: 起動後の
  定期ループで未完了セッションを reconcile し、ベットを返金する
- 実行部は execute_* メソッドに分離してある（将来の統合パネルからも
  そのまま呼べる形）
- 表示はセッション1メッセージ方式: パネルの embed をその場で編集して
  更新し続け、スピン／GO／ヒット等のたびに新規メッセージを投稿しない
  （結果表示の公開化でログが流れるのを防ぐ）。まとめて回す操作は
  内部で複数回消化してから1回だけ編集する（編集レート制限対策）。
  全額没収・超JACKPOT 等の大きなイベントも同じ embed 内で色と結果欄を
  切り替えて目立たせ、別途の新規投稿はしない

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:slot / general:double / general:blackjack / general:dice）
だけ。いずれも AI tools の代理実行対象外（AI_BLOCKED_IDS）。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable

import discord
from discord.ext import commands, tasks

import config
from core import gambling as gambling_core
from core import items as items_core
from core.messages import GAMBLING_INVALID_AMOUNT, gambling_action_failed
from cogs import wallet as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

logger = logging.getLogger(__name__)

GAMBLING_COLOR = 0x9B59B6
GAMBLING_ID = "GAMBLING"


# ---------------------------------------------------------------------------
# スロット
# ---------------------------------------------------------------------------

_SLOT_EVENT_LINES = {
    "pity": "🔥 天井発動！！",
    "seven_bonus": "🔥 7ボーナス！",
    "kakuhen_start": "⚡ 確変突入！！",
    "six_confiscate": "💀 66666…所持コイン全額没収",
    "six_penalty": "💀 6ペナルティ！",
    "kakuhen_decrease": "💀 確変減少",
    "kakuhen_multiplier": "✨ 確変倍率！",
    "kakuhen_extend": "⚡ 確変延長！",
    "super_jackpot": "💎 超JACKPOT！！！",
    "kakuhen_end": "⚡ 確変終了...",
}


# ルール文は「ルール」ボタンの裏に隔離する（導線最適化 S9）。パネル本文は状態だけ。
GAMBLING_RULES = {
    "slot": (
        f"7リールスロット。1回 **{gambling_core.SLOT_BET:,} AGO** 固定で、"
        f"回数（{gambling_core.SLOT_MIN_SPINS}〜{gambling_core.SLOT_MAX_SPINS}）"
        "分のベットを先払いして回します。\n"
        "同じ数字が揃うほど配当が伸び、7が3つ以上揃うと確変（配当3倍）に"
        "入ります。6が5つ以上揃うと所持コイン全額没収、"
        "連敗が続くと天井もあります。"),
    "double": (
        "ベットして、GOで倍率を伸ばすか、CASHOUTで確定するか選ぶゲーム。"
        f"GO成功で倍率が {gambling_core.DOUBLE_MULTIPLIER_STEP} 倍ずつ伸び、"
        "失敗するとベットは失われます。成功率は内部状態で変動します。"),
    "blackjack": (
        f"ディーラーとの対戦。ベットは {gambling_core.BLACKJACK_MIN_BET} AGO から。"
        "21に近い方が勝ち、超えるとバーストで負けです。"
        "ディーラーは17未満で引き続けます。勝てばベットの2倍が戻ります。"),
    "dice": (
        f"1〜範囲（{gambling_core.DICE_MIN_MAX}〜{gambling_core.DICE_MAX_MAX}）の"
        "数字を1つ予想してベットし、出目が一致すれば ベット×範囲 が賞金です。"
        f"ベットは {gambling_core.DICE_MIN_BET} AGO から。"),
}

_SLOT_RISK_LINE = "⚠️ 6が5つ以上揃うと所持コイン全額没収"


def _rules_embed(game: str, title: str) -> discord.Embed:
    return discord.Embed(title=f"{title}のルール", description=GAMBLING_RULES[game],
                         color=GAMBLING_COLOR)


#: 「まとめて回す」ボタン1回で消化するスピン数。内部でこの回数まで
#: 回してから embed を1回だけ編集する（編集頻度を抑える単位）。
SLOT_BULK_SPINS = 10


def _fit(text: str, limit: int = 1024) -> str:
    """embed のフィールド上限に収める。"""
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def _fetch_balance(cog: "GamblingCog", user_id: int) -> int | None:
    try:
        return await cog._balance(str(user_id))
    except Exception:
        return None


class _SessionPanel:
    """セッションパネル共通部品: 対象メッセージと直近結果を保持し、
    新規投稿せずに対象メッセージの embed を編集して更新する。

    モーダル送信のようにコンポーネントの interaction から直接編集
    できない場面では refresh_message() で対象メッセージを編集する。
    """

    message: discord.Message | None = None
    last_result: str | None = None
    cog: "GamblingCog"
    user_id: int

    def _build_embed(self, balance: int | None) -> discord.Embed:
        raise NotImplementedError

    def _sync_buttons(self) -> None:
        raise NotImplementedError

    async def refresh_message(self) -> None:
        """対象メッセージを最新状態で編集し直す（モーダル送信後用）。"""
        if self.message is None:
            return
        self._sync_buttons()
        balance = await _fetch_balance(self.cog, self.user_id)
        try:
            await self.message.edit(embed=self._build_embed(balance), view=self)
        except Exception:
            logger.exception("gambling: パネルの更新に失敗しました")

    async def render_interaction(self, interaction: discord.Interaction) -> None:
        """ボタンの interaction に対して対象メッセージを編集で更新する。"""
        self._sync_buttons()
        balance = await _fetch_balance(self.cog, self.user_id)
        await interaction.edit_original_response(
            embed=self._build_embed(balance), view=self)

    async def _disable_on_timeout(self) -> None:
        for child in self.children:  # type: ignore[attr-defined]
            if isinstance(child, discord.ui.Button):
                child.disabled = True
        if self.message is not None:
            try:
                await self.message.edit(view=self)  # type: ignore[arg-type]
            except Exception:
                pass


def _slot_embed(cog: "GamblingCog", user_id: int, *, result: str | None = None,
                balance: int | None = None,
                session_pnl: int | None = None) -> discord.Embed:
    store = cog.store
    state = store.user_state(str(user_id))
    session = store.session(str(user_id))
    if session is not None and session["kind"] != "slot":
        session = None
    color = GAMBLING_COLOR
    if result:
        if "全額没収" in result:
            color = 0xE74C3C
        elif "超JACKPOT" in result:
            color = 0xF1C40F
    embed = discord.Embed(title="スロット", color=color)
    embed.set_footer(text=_SLOT_RISK_LINE)
    if result:
        embed.add_field(name="結果", value=_fit(result), inline=False)
    if session is not None:
        embed.add_field(
            name="セッション",
            value=(f"消化 **{session['total'] - session['remaining']}** 回"
                   f"／残り **{session['remaining']} / {session['total']}** 回"),
            inline=True)
    if session_pnl is not None:
        embed.add_field(
            name="セッション収支", value=f"**{session_pnl:+,} AGO**", inline=True)
    state_lines = []
    if state["kakuhen"] > 0:
        state_lines.append(f"⚡ 確変残り **{state['kakuhen']}** 回")
    if state["internal_mode"] != "NORMAL":
        state_lines.append(f"モード: **{state['internal_mode']}**")
    state_lines.append(f"連勝 {state['win_streak']}／連敗 {state['lose_streak']}")
    state_lines.append(f"6カウンタ: {state['six_counter']}")
    embed.add_field(name="内部状態", value="\n".join(state_lines), inline=False)
    if balance is not None:
        embed.add_field(name="残高", value=f"**{balance:,} AGO**", inline=True)
    return embed


class SlotStartModal(discord.ui.Modal, title="スロットを始める"):
    spins = discord.ui.TextInput(
        label="回数", placeholder="例: 10（半角数字）", max_length=6)

    def __init__(self, cog: "GamblingCog", panel: "SlotView | None" = None):
        super().__init__()
        self.cog = cog
        self.panel = panel
        self.spins.label = (
            f"回数（{gambling_core.SLOT_MIN_SPINS}〜{gambling_core.SLOT_MAX_SPINS}）")

    async def on_submit(self, interaction: discord.Interaction):
        raw = str(self.spins.value).replace(",", "").strip()
        try:
            spins = int(raw)
        except ValueError:
            return await interaction.response.send_message(
                GAMBLING_INVALID_AMOUNT, ephemeral=True)
        await interaction.response.defer()
        message = await self.cog.execute_slot_start(interaction.user.id, spins)
        if self.panel is not None and self.panel.message is not None:
            self.panel.last_result = message
            session = self.cog.store.session(str(interaction.user.id))
            if session is not None and session["kind"] == "slot":
                # 先払い分をマイナスとしてセッション収支の集計を開始する。
                self.panel.session_pnl = (
                    -gambling_core.SLOT_BET * int(session["total"]))
            await self.panel.refresh_message()
            return
        await interaction.followup.send(message)


class SlotView(_SessionPanel, discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.message = None
        self.last_result = None
        self.session_pnl: int | None = None
        self._sync_buttons()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    async def on_timeout(self) -> None:
        await self._disable_on_timeout()

    def _session(self) -> dict | None:
        session = self.cog.store.session(str(self.user_id))
        return session if session is not None and session["kind"] == "slot" else None

    def _sync_buttons(self) -> None:
        active = self._session() is not None
        for child in self.children:
            if not isinstance(child, discord.ui.Button):
                continue
            if child.label == "始める":
                child.disabled = active
            elif child.label in ("🎰 回す", "🎰 まとめて10回"):
                child.disabled = not active

    def _build_embed(self, balance: int | None) -> discord.Embed:
        return _slot_embed(
            self.cog, self.user_id, result=self.last_result,
            balance=balance, session_pnl=self.session_pnl)

    @discord.ui.button(label="始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(SlotStartModal(self.cog, panel=self))

    @discord.ui.button(label="🎰 回す", style=discord.ButtonStyle.success)
    async def spin(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message, info = await self.cog._spin_slot_once(interaction.user.id)
        self.last_result = message
        if info is not None:
            self.session_pnl = (self.session_pnl or 0) + info["delta"]
        await self.render_interaction(interaction)

    @discord.ui.button(label="🎰 まとめて10回", style=discord.ButtonStyle.success)
    async def spin_bulk(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message, info = await self.cog.execute_slot_spin_bulk(
            interaction.user.id, SLOT_BULK_SPINS)
        self.last_result = message
        if info is not None:
            self.session_pnl = (self.session_pnl or 0) + info["delta"]
        await self.render_interaction(interaction)

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("slot", "スロット"), ephemeral=True)


# ---------------------------------------------------------------------------
# ダブルアップ
# ---------------------------------------------------------------------------

def _double_status_text(cog: "GamblingCog", user_id: int) -> str:
    session = cog.store.session(str(user_id))
    if session is None or session["kind"] != "double":
        return "セッションはありません。ベットして始められます。"
    current = int(session["bet"] * session["multiplier"])
    return (f"BET: **{session['bet']:,} AGO**／倍率: **{session['multiplier']:.2f}**"
            f"／現在価値: **{current:,} AGO**／GO成功: **{session['streak']} 回**")


def _double_embed(cog: "GamblingCog", user_id: int, *, result: str | None = None,
                  balance: int | None = None) -> discord.Embed:
    embed = discord.Embed(title="ダブルアップ", color=GAMBLING_COLOR)
    if result:
        embed.add_field(name="結果", value=_fit(result), inline=False)
    embed.add_field(name="状態", value=_double_status_text(cog, user_id), inline=False)
    state = cog.store.user_state(str(user_id))
    rate = cog.store.internal_rate(str(user_id))
    embed.add_field(
        name="内部状態",
        value=(f"モード: **{state['internal_mode']}**"
               f"／次のGO成功率: **{rate * 100:.0f}%**\n"
               f"連勝 {state['win_streak']}／連敗 {state['lose_streak']}"),
        inline=False)
    if balance is not None:
        embed.add_field(name="残高", value=f"**{balance:,} AGO**", inline=True)
    return embed


class BetModal(discord.ui.Modal):
    amount = discord.ui.TextInput(
        label="ベット額（AGO）", placeholder="例: 1000（半角数字）", max_length=16)

    def __init__(self, cog: "GamblingCog", game: str, panel=None):
        self.cog = cog
        self.game = game
        self.panel = panel
        title = "ダブルアップを始める" if game == "double" else "ブラックジャックを始める"
        super().__init__(title=title)

    async def on_submit(self, interaction: discord.Interaction):
        raw = str(self.amount.value).replace(",", "").strip()
        try:
            bet = int(raw)
        except ValueError:
            return await interaction.response.send_message(
                GAMBLING_INVALID_AMOUNT, ephemeral=True)
        await interaction.response.defer()
        if self.game == "double":
            message = await self.cog.execute_double_start(interaction.user.id, bet)
        else:
            message = await self.cog.execute_blackjack_start(interaction.user.id, bet)
        if self.panel is not None and self.panel.message is not None:
            self.panel.last_result = message
            await self.panel.refresh_message()
            return
        await interaction.followup.send(message)


class DoubleView(_SessionPanel, discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.message = None
        self.last_result = None
        self._sync_buttons()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    async def on_timeout(self) -> None:
        await self._disable_on_timeout()

    def _session(self) -> dict | None:
        session = self.cog.store.session(str(self.user_id))
        return session if session is not None and session["kind"] == "double" else None

    def _sync_buttons(self) -> None:
        active = self._session() is not None
        for child in self.children:
            if not isinstance(child, discord.ui.Button):
                continue
            if child.label == "ベットして始める":
                child.disabled = active
            elif child.label in ("GO", "CASHOUT"):
                child.disabled = not active

    def _build_embed(self, balance: int | None) -> discord.Embed:
        return _double_embed(
            self.cog, self.user_id, result=self.last_result, balance=balance)

    @discord.ui.button(label="ベットして始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BetModal(self.cog, "double", panel=self))

    @discord.ui.button(label="GO", style=discord.ButtonStyle.success)
    async def go(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        self.last_result = await self.cog.execute_double_go(interaction.user.id)
        await self.render_interaction(interaction)

    @discord.ui.button(label="CASHOUT", style=discord.ButtonStyle.danger)
    async def cashout(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        self.last_result = await self.cog.execute_double_cashout(interaction.user.id)
        await self.render_interaction(interaction)

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("double", "ダブルアップ"), ephemeral=True)


# ---------------------------------------------------------------------------
# ブラックジャック
# ---------------------------------------------------------------------------

def _blackjack_embed(cog: "GamblingCog", user_id: int, *, result: str | None = None,
                     balance: int | None = None) -> discord.Embed:
    embed = discord.Embed(title="ブラックジャック", color=GAMBLING_COLOR)
    if result:
        embed.add_field(name="結果", value=_fit(result), inline=False)
    session = cog.store.session(str(user_id))
    if session is not None and session["kind"] == "blackjack":
        total = gambling_core.calc_total(session["player"])
        embed.add_field(
            name="あなたの手札",
            value=f"{session['player']}（{total}）", inline=True)
        embed.add_field(
            name="ディーラー", value=f"{session['dealer'][0]} ?", inline=True)
        embed.add_field(
            name="ベット", value=f"**{session['bet']:,} AGO**", inline=True)
    if balance is not None:
        embed.add_field(name="残高", value=f"**{balance:,} AGO**", inline=True)
    return embed


class BlackjackView(_SessionPanel, discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.message = None
        self.last_result = None
        self._sync_buttons()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    async def on_timeout(self) -> None:
        await self._disable_on_timeout()

    def _session(self) -> dict | None:
        session = self.cog.store.session(str(self.user_id))
        return session if session is not None and session["kind"] == "blackjack" else None

    def _sync_buttons(self) -> None:
        active = self._session() is not None
        for child in self.children:
            if not isinstance(child, discord.ui.Button):
                continue
            if child.label == "ベットして始める":
                child.disabled = active
            elif child.label in ("ヒット", "スタンド"):
                child.disabled = not active

    def _build_embed(self, balance: int | None) -> discord.Embed:
        return _blackjack_embed(
            self.cog, self.user_id, result=self.last_result, balance=balance)

    @discord.ui.button(label="ベットして始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BetModal(self.cog, "blackjack", panel=self))

    @discord.ui.button(label="ヒット", style=discord.ButtonStyle.success)
    async def hit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message, _finished = await self.cog.execute_blackjack_hit(interaction.user.id)
        self.last_result = message
        await self.render_interaction(interaction)

    @discord.ui.button(label="スタンド", style=discord.ButtonStyle.danger)
    async def stand(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        self.last_result = await self.cog.execute_blackjack_stand(interaction.user.id)
        await self.render_interaction(interaction)

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("blackjack", "ブラックジャック"), ephemeral=True)


# ---------------------------------------------------------------------------
# ダイス（数字当て）
# ---------------------------------------------------------------------------

def _dice_embed(cog: "GamblingCog", user_id: int, *, result: str | None = None,
                balance: int | None = None) -> discord.Embed:
    embed = discord.Embed(title="ダイス（数字当て）", color=GAMBLING_COLOR)
    if result:
        embed.add_field(name="結果", value=_fit(result), inline=False)
    if balance is not None:
        embed.add_field(name="残高", value=f"**{balance:,} AGO**", inline=True)
    return embed


class DiceModal(discord.ui.Modal, title="ダイス（数字当て）"):
    max_value = discord.ui.TextInput(
        label="範囲（最大値）", placeholder="例: 100（半角数字）", max_length=6)
    number = discord.ui.TextInput(
        label="予想する数字", placeholder="例: 7（半角数字）", max_length=6)
    bet = discord.ui.TextInput(
        label="ベット額（AGO）", placeholder="例: 100（半角数字）", max_length=16)

    def __init__(self, cog: "GamblingCog", panel: "DiceView | None" = None):
        super().__init__()
        self.cog = cog
        self.panel = panel

    async def on_submit(self, interaction: discord.Interaction):
        try:
            max_value = int(str(self.max_value.value).replace(",", "").strip())
            number = int(str(self.number.value).replace(",", "").strip())
            bet = int(str(self.bet.value).replace(",", "").strip())
        except ValueError:
            return await interaction.response.send_message(
                GAMBLING_INVALID_AMOUNT, ephemeral=True)
        await interaction.response.defer()
        message = await self.cog.execute_dice(
            interaction.user.id, max_value, number, bet)
        if self.panel is not None and self.panel.message is not None:
            # 繰り返し振る前提のゲームなので、結果はパネルの embed に
            # 残して新規メッセージは投稿しない。
            self.panel.last_result = message
            await self.panel.refresh_message()
            return
        await interaction.followup.send(message)


class DiceView(_SessionPanel, discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.message = None
        self.last_result = None

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    async def on_timeout(self) -> None:
        await self._disable_on_timeout()

    def _sync_buttons(self) -> None:
        return None

    def _build_embed(self, balance: int | None) -> discord.Embed:
        return _dice_embed(
            self.cog, self.user_id, result=self.last_result, balance=balance)

    @discord.ui.button(label="ダイスを振る", style=discord.ButtonStyle.primary)
    async def roll(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(DiceModal(self.cog, panel=self))

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("dice", "ダイス（数字当て）"), ephemeral=True)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class GamblingCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 store: gambling_core.GamblingStore | None = None,
                 balance_reader: Callable[[str], int] | None = None):
        self.bot = bot
        self.store = store if store is not None else gambling_core.GamblingStore()
        self._balance_reader = balance_reader
        self._refunded = False

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.store.flush()

    @tasks.loop(seconds=gambling_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.store.maybe_flush()
            await self._refund_orphaned()
        except Exception:
            logger.exception("gambling: 定期フラッシュ／返金に失敗しました")

    @flush_loop.before_loop
    async def _before_flush_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------ 共通
    def _wallet(self):
        wallet = self.bot.get_cog("WalletCog")
        if wallet is None:
            raise items_core.ItemError("コイン機能が読み込まれていません。")
        return wallet

    async def _record_history(self, sender_id: str, receiver_id: str, amount: int, reason: str) -> None:
        try:
            await asyncio.to_thread(lambda: config.db_api.table("transaction_history").insert({
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "amount": amount,
                "reason": reason,
            }).execute())
        except Exception:
            logger.exception("gambling: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                             sender_id, receiver_id, amount)

    async def _balance(self, user_id: str) -> int:
        """残高の読み取り（行が無いユーザーは0。行は作らない）。"""
        if self._balance_reader is not None:
            return int(self._balance_reader(str(user_id)))

        def _read() -> int:
            response = config.db_api.table("users").select("balance") \
                .eq("user_id", str(user_id)).execute()
            if not response.data:
                return 0
            return int(response.data[0].get("balance") or 0)

        return await asyncio.to_thread(_read)

    async def _refund_orphaned(self) -> None:
        """再起動で失われた未完了セッションのベットを返金する（初回のみ）。

        ストアから取り出すとセッションは消えるため、wallet が使える
        状態でのみ取り出す。返金に失敗した分は重大ログに残す
        （宝くじ賞金の支払い失敗と同じ扱い）。
        """
        if self._refunded:
            return
        if self.bot.get_cog("WalletCog") is None:
            return
        refunds = self.store.orphaned_refunds()
        self._refunded = True
        wallet = self._wallet()
        for refund in refunds:
            uid = refund["user_id"]
            amount = int(refund["amount"])
            try:
                credit = await wallet._change_balance(
                    uid, amount, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    logger.critical(
                        "gambling: 未完了セッションの返金に失敗しました。手動で返金してください: "
                        "user=%s kind=%s amount=%s", uid, refund["kind"], amount)
                    continue
                reason = {
                    "slot": "gamble_slot", "double": "gamble_double",
                    "blackjack": "gamble_blackjack",
                }[refund["kind"]]
                await self._record_history(GAMBLING_ID, uid, amount, reason)
                logger.info(
                    "gambling: 未完了セッションを返金しました user=%s kind=%s amount=%s",
                    uid, refund["kind"], amount)
            except Exception:
                logger.exception(
                    "gambling: 未完了セッションの返金で例外 user=%s kind=%s",
                    uid, refund["kind"])

    async def _confiscate_all(self, uid: str) -> int:
        """残高を全額没収し、没収できた額を返す（原典 66666 の全没収）。"""
        wallet = self._wallet()
        first = await self._balance(uid)
        if first <= 0:
            return 0
        for _ in range(3):
            balance = await self._balance(uid)
            if balance <= 0:
                break
            result = await wallet._change_balance(uid, -balance, require_funds=True)
            if result is wallet_module.INSUFFICIENT:
                continue  # 残高が動いた。読み直してやり直す
            if result is None:
                logger.critical(
                    "gambling: 全額没収の更新に失敗しました user=%s", uid)
                break
            return balance
        return max(0, first - await self._balance(uid))

    # ------------------------------------------------------------------ 入口
    async def show_slot(self, interaction: discord.Interaction):
        view = SlotView(self, interaction.user.id)
        balance = await _fetch_balance(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_slot_embed(self, interaction.user.id, balance=balance), view=view)
        view.message = await interaction.original_response()

    async def show_double(self, interaction: discord.Interaction):
        view = DoubleView(self, interaction.user.id)
        balance = await _fetch_balance(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_double_embed(self, interaction.user.id, balance=balance), view=view)
        view.message = await interaction.original_response()

    async def show_blackjack(self, interaction: discord.Interaction):
        view = BlackjackView(self, interaction.user.id)
        balance = await _fetch_balance(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_blackjack_embed(self, interaction.user.id, balance=balance), view=view)
        view.message = await interaction.original_response()

    async def show_dice(self, interaction: discord.Interaction):
        view = DiceView(self, interaction.user.id)
        balance = await _fetch_balance(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_dice_embed(self, interaction.user.id, balance=balance), view=view)
        view.message = await interaction.original_response()

    # ------------------------------------------------------------------ スロットの実行
    async def execute_slot_start(self, user_id: int, spins: int) -> str:
        uid = str(user_id)
        try:
            if not gambling_core.SLOT_MIN_SPINS <= spins <= gambling_core.SLOT_MAX_SPINS:
                return gambling_action_failed(
                    f"回数は{gambling_core.SLOT_MIN_SPINS}〜"
                    f"{gambling_core.SLOT_MAX_SPINS}回で指定してください。")
            if self.store.session(uid) is not None:
                return gambling_action_failed(
                    "進行中のゲームがあります。先にそちらを終えてください。")
            total = gambling_core.SLOT_BET * spins
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -total, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return gambling_action_failed(
                    f"コインが不足しています（必要: {total:,} AGO）。")
            if debit is None:
                return gambling_action_failed(
                    "コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                self.store.start_slot(uid, spins)
            except items_core.ItemError as exc:
                await wallet._change_balance(uid, total)
                return gambling_action_failed(exc)
            await self._record_history(uid, GAMBLING_ID, total, "gamble_slot")
            return (f"🎰 **スロット開始！** {spins} 回分 {total:,} AGO を先払いしました。\n"
                    f"コイン残高: {debit:,} AGO")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: スロット開始に失敗 user=%s", uid)
            return gambling_action_failed(
                "開始中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_slot_spin(self, user_id: int) -> str:
        message, _info = await self._spin_slot_once(user_id)
        return message

    async def _spin_slot_once(self, user_id: int) -> tuple[str, dict | None]:
        """1スピン実行し、表示文と収支情報（delta / finished）を返す。

        失敗（セッションなし等）では info は None。経済処理は従来どおりで、
        info は表示層がセッション収支を集計するための付随情報。
        """
        uid = str(user_id)
        try:
            result = self.store.spin_slot(uid)
            wallet = self._wallet()
            delta = 0
            lines = [f"🎰 {''.join(map(str, result['reels']))}"]
            for event in result["events"]:
                lines.append(_SLOT_EVENT_LINES[event])
            if result["confiscate"]:
                taken = await self._confiscate_all(uid)
                delta = -taken
                if taken > 0:
                    await self._record_history(uid, GAMBLING_ID, taken, "gamble_slot")
            elif result["reward"] > 0:
                credit = await wallet._change_balance(
                    uid, result["reward"], create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    logger.critical(
                        "gambling: スロット配当の支払いに失敗しました。手動で払ってください: "
                        "user=%s reward=%s", uid, result["reward"])
                else:
                    delta = result["reward"]
                    await self._record_history(
                        GAMBLING_ID, uid, result["reward"], "gamble_slot")
                if "pity" not in result["events"]:
                    lines.append(
                        f"{result['max_match']}揃い！ **{result['reward']:+,} AGO**")
            elif result["reward"] < 0:
                debit = await wallet._change_balance(uid, result["reward"])
                if debit is None:
                    logger.critical(
                        "gambling: スロットペナルティの引き落としに失敗しました: "
                        "user=%s amount=%s", uid, result["reward"])
                else:
                    delta = result["reward"]
                    await self._record_history(
                        uid, GAMBLING_ID, -result["reward"], "gamble_slot")
                lines.append(f"**{result['reward']:+,} AGO**")
            if result["kakuhen"] > 0:
                lines.append(f"⚡ 確変残り {result['kakuhen']} 回")
            lines.append(f"残り回数: {result['remaining']} / {result['total']}")
            if result["finished"]:
                lines.append("セッション終了。おつかれさまでした。")
            return "\n".join(lines), {
                "delta": delta, "finished": bool(result["finished"])}
        except items_core.ItemError as exc:
            return gambling_action_failed(exc), None
        except Exception:
            logger.exception("gambling: スロットのスピンに失敗 user=%s", uid)
            return gambling_action_failed(
                "スピン中にエラーが発生しました。時間をおいて再試行してください。"), None

    async def execute_slot_spin_bulk(
            self, user_id: int, count: int) -> tuple[str, dict | None]:
        """最大 count 回まとめて回し、集約した1件分の表示文を返す。

        呼び出し側はこの結果で embed を1回だけ編集する（スピンごとに
        編集すると Discord の編集レート制限に当たるため）。経済処理は
        _spin_slot_once の繰り返しで、1回分と完全に同じ。
        """
        uid = str(user_id)
        spun = 0
        delta_total = 0
        last_reels = ""
        event_counts: dict[str, int] = {}
        finished = False
        for _ in range(max(1, int(count))):
            message, info = await self._spin_slot_once(user_id)
            if info is None:
                if spun == 0:
                    return message, None
                break
            spun += 1
            delta_total += info["delta"]
            message_lines = message.split("\n")
            last_reels = message_lines[0]
            for line in message_lines[1:]:
                if line in _SLOT_EVENT_LINES.values():
                    event_counts[line] = event_counts.get(line, 0) + 1
            finished = info["finished"]
            if finished:
                break
        lines = [f"🎰 **{spun} 回まとめて回しました**", last_reels]
        for line, times in event_counts.items():
            lines.append(f"{line} ×{times}" if times > 1 else line)
        lines.append(f"収支: **{delta_total:+,} AGO**")
        session = self.store.session(uid)
        if session is not None and session["kind"] == "slot":
            lines.append(
                f"残り回数: {session['remaining']} / {session['total']}")
        if finished:
            lines.append("セッション終了。おつかれさまでした。")
        return "\n".join(lines), {"delta": delta_total, "finished": finished}

    # ------------------------------------------------------------------ ダブルアップの実行
    async def execute_double_start(self, user_id: int, bet: int) -> str:
        uid = str(user_id)
        try:
            if bet < gambling_core.DOUBLE_MIN_BET:
                return gambling_action_failed(
                    f"ベットは{gambling_core.DOUBLE_MIN_BET} AGO以上で指定してください。")
            if self.store.session(uid) is not None:
                return gambling_action_failed(
                    "進行中のゲームがあります。先にそちらを終えてください。")
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -bet, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return gambling_action_failed("コインが不足しています。")
            if debit is None:
                return gambling_action_failed(
                    "コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                self.store.start_double(uid, bet)
            except items_core.ItemError as exc:
                await wallet._change_balance(uid, bet)
                return gambling_action_failed(exc)
            await self._record_history(uid, GAMBLING_ID, bet, "gamble_double")
            return (f"🎲 **ダブルアップ開始！** BET: {bet:,} AGO\n"
                    "GOで倍率を伸ばすか、CASHOUTで確定してください。")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ダブルアップ開始に失敗 user=%s", uid)
            return gambling_action_failed(
                "開始中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_double_go(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            result = self.store.double_go(uid)
            if result["win"]:
                return (f"✅ **成功！** 倍率 {result['multiplier']:.2f} 倍"
                        f"（現在価値 {result['current_value']:,} AGO）\n"
                        "GOで続けるか、CASHOUTで確定してください。")
            return (f"💀 **失敗…** ベット {result['bet']:,} AGO は失われました。")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ダブルアップのGOに失敗 user=%s", uid)
            return gambling_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_double_cashout(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            result = self.store.double_cashout(uid)
            wallet = self._wallet()
            credit = await wallet._change_balance(
                uid, result["payout"], create_with=wallet_module.NEW_USER_BALANCE)
            if credit is None:
                logger.critical(
                    "gambling: ダブルアップ配当の支払いに失敗しました。手動で払ってください: "
                    "user=%s payout=%s", uid, result["payout"])
                return gambling_action_failed(
                    "配当の支払いに失敗しました。Botの運営に連絡してください。")
            await self._record_history(GAMBLING_ID, uid, result["payout"], "gamble_double")
            return (f"💰 **確定！ {result['payout']:,} AGO 獲得！**\n"
                    f"コイン残高: {credit:,} AGO")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ダブルアップの確定に失敗 user=%s", uid)
            return gambling_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。")

    # ------------------------------------------------------------------ ブラックジャックの実行
    async def execute_blackjack_start(self, user_id: int, bet: int) -> str:
        uid = str(user_id)
        try:
            if bet < gambling_core.BLACKJACK_MIN_BET:
                return gambling_action_failed(
                    f"ベットは{gambling_core.BLACKJACK_MIN_BET} AGO以上で指定してください。")
            if self.store.session(uid) is not None:
                return gambling_action_failed(
                    "進行中のゲームがあります。先にそちらを終えてください。")
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -bet, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return gambling_action_failed("コインが不足しています。")
            if debit is None:
                return gambling_action_failed(
                    "コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                session = self.store.start_blackjack(uid, bet)
            except items_core.ItemError as exc:
                await wallet._change_balance(uid, bet)
                return gambling_action_failed(exc)
            await self._record_history(uid, GAMBLING_ID, bet, "gamble_blackjack")
            total = gambling_core.calc_total(session["player"])
            return (f"🃏 **ブラックジャック開始！** BET: {bet:,} AGO\n"
                    f"あなた: {session['player']}（{total}）\n"
                    f"ディーラー: {session['dealer'][0]} ?\n"
                    "ヒットかスタンドを選んでください。")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ブラックジャック開始に失敗 user=%s", uid)
            return gambling_action_failed(
                "開始中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_blackjack_hit(self, user_id: int) -> tuple[str, bool]:
        uid = str(user_id)
        try:
            result = self.store.blackjack_hit(uid)
            if result["bust"]:
                return (f"💥 **バースト！** あなた: {result['player']}"
                        f"（{result['total']}）\n"
                        f"負け -{result['bet']:,} AGO", True)
            return (f"あなた: {result['player']}（{result['total']}）\n"
                    f"ディーラー: {result['dealer_first']} ?\n"
                    "ヒットかスタンドを選んでください。", False)
        except items_core.ItemError as exc:
            return gambling_action_failed(exc), True
        except Exception:
            logger.exception("gambling: ブラックジャックのヒットに失敗 user=%s", uid)
            return gambling_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。"), True

    async def execute_blackjack_stand(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            result = self.store.blackjack_stand(uid)
            if result["payout"] > 0:
                wallet = self._wallet()
                credit = await wallet._change_balance(
                    uid, result["payout"], create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    logger.critical(
                        "gambling: ブラックジャック配当の支払いに失敗しました。"
                        "手動で払ってください: user=%s payout=%s",
                        uid, result["payout"])
                    return gambling_action_failed(
                        "配当の支払いに失敗しました。Botの運営に連絡してください。")
                await self._record_history(
                    GAMBLING_ID, uid, result["payout"], "gamble_blackjack")
            if result["outcome"] == "win":
                headline = f"🎉 **勝ち！ +{result['bet']:,} AGO**"
            elif result["outcome"] == "push":
                headline = "🤝 **引き分け**（ベットが戻りました）"
            else:
                headline = f"💀 **負け -{result['bet']:,} AGO**"
            return (f"{headline}\n"
                    f"あなた: {result['player']}（{result['player_total']}）\n"
                    f"ディーラー: {result['dealer']}（{result['dealer_total']}）")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ブラックジャックのスタンドに失敗 user=%s", uid)
            return gambling_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。")

    # ------------------------------------------------------------------ ダイスの実行
    async def execute_dice(self, user_id: int, max_value: int, number: int, bet: int) -> str:
        uid = str(user_id)
        try:
            if bet < gambling_core.DICE_MIN_BET:
                return gambling_action_failed(
                    f"ベットは{gambling_core.DICE_MIN_BET} AGO以上で指定してください。")
            if not gambling_core.DICE_MIN_MAX <= max_value <= gambling_core.DICE_MAX_MAX:
                return gambling_action_failed(
                    f"範囲は{gambling_core.DICE_MIN_MAX}〜"
                    f"{gambling_core.DICE_MAX_MAX}で指定してください。")
            if not 1 <= number <= max_value:
                return gambling_action_failed("予想は範囲内の数字で指定してください。")
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -bet, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return gambling_action_failed("コインが不足しています。")
            if debit is None:
                return gambling_action_failed(
                    "コインの更新に失敗しました。時間をおいて再試行してください。")
            await self._record_history(uid, GAMBLING_ID, bet, "gamble_dice")
            result = self.store.play_dice(max_value, number)
            if result["hit"]:
                prize = bet * max_value
                credit = await wallet._change_balance(
                    uid, prize, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    logger.critical(
                        "gambling: ダイス賞金の支払いに失敗しました。手動で払ってください: "
                        "user=%s prize=%s", uid, prize)
                    return gambling_action_failed(
                        "賞金の支払いに失敗しました。Botの運営に連絡してください。")
                await self._record_history(GAMBLING_ID, uid, prize, "gamble_dice")
                return (f"🎲 予想: {number}／結果: **{result['rolled']}**\n"
                        f"🎉 **当たり！ {prize:,} AGO 獲得！**\n"
                        f"コイン残高: {credit:,} AGO")
            return (f"🎲 予想: {number}／結果: **{result['rolled']}**\n"
                    "はずれ…ベットは失われました。")
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: ダイスに失敗 user=%s", uid)
            return gambling_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。")


async def setup(bot: commands.Bot):
    await bot.add_cog(GamblingCog(bot))
