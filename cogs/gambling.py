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


def _slot_embed(cog: "GamblingCog", user_id: int) -> discord.Embed:
    store = cog.store
    state = store.user_state(str(user_id))
    session = store.session(str(user_id))
    embed = discord.Embed(title="スロット", color=GAMBLING_COLOR)
    embed.set_footer(text=_SLOT_RISK_LINE)
    if session is not None and session["kind"] == "slot":
        embed.add_field(
            name="セッション",
            value=f"残り **{session['remaining']} / {session['total']}** 回",
            inline=True)
    if state["kakuhen"] > 0:
        embed.add_field(name="確変", value=f"残り **{state['kakuhen']}** 回", inline=True)
    return embed


class SlotStartModal(discord.ui.Modal, title="スロットを始める"):
    spins = discord.ui.TextInput(
        label="回数", placeholder="例: 10（半角数字）", max_length=6)

    def __init__(self, cog: "GamblingCog"):
        super().__init__()
        self.cog = cog
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
        await interaction.followup.send(message)


class SlotView(discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(SlotStartModal(self.cog))

    @discord.ui.button(label="🎰 回す", style=discord.ButtonStyle.success)
    async def spin(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = await self.cog.execute_slot_spin(interaction.user.id)
        await interaction.followup.send(message)

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
            f"／現在価値: **{current:,} AGO**")


def _double_embed(cog: "GamblingCog", user_id: int) -> discord.Embed:
    embed = discord.Embed(title="ダブルアップ", color=GAMBLING_COLOR)
    embed.add_field(name="状態", value=_double_status_text(cog, user_id), inline=False)
    return embed


class BetModal(discord.ui.Modal):
    amount = discord.ui.TextInput(
        label="ベット額（AGO）", placeholder="例: 1000（半角数字）", max_length=16)

    def __init__(self, cog: "GamblingCog", game: str):
        self.cog = cog
        self.game = game
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
        await interaction.followup.send(message)


class DoubleView(discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="ベットして始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BetModal(self.cog, "double"))

    @discord.ui.button(label="GO", style=discord.ButtonStyle.success)
    async def go(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = await self.cog.execute_double_go(interaction.user.id)
        await interaction.followup.send(message)

    @discord.ui.button(label="CASHOUT", style=discord.ButtonStyle.danger)
    async def cashout(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = await self.cog.execute_double_cashout(interaction.user.id)
        await interaction.followup.send(message)

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("double", "ダブルアップ"), ephemeral=True)


# ---------------------------------------------------------------------------
# ブラックジャック
# ---------------------------------------------------------------------------

def _blackjack_embed(cog: "GamblingCog", user_id: int) -> discord.Embed:
    embed = discord.Embed(title="ブラックジャック", color=GAMBLING_COLOR)
    session = cog.store.session(str(user_id))
    if session is not None and session["kind"] == "blackjack":
        total = gambling_core.calc_total(session["player"])
        embed.add_field(
            name="あなたの手札",
            value=f"{session['player']}（{total}）", inline=True)
        embed.add_field(
            name="ディーラー", value=f"{session['dealer'][0]} ?", inline=True)
    return embed


class BlackjackView(discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="ベットして始める", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BetModal(self.cog, "blackjack"))

    @discord.ui.button(label="ヒット", style=discord.ButtonStyle.success)
    async def hit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message, _finished = await self.cog.execute_blackjack_hit(interaction.user.id)
        await interaction.followup.send(message)

    @discord.ui.button(label="スタンド", style=discord.ButtonStyle.danger)
    async def stand(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = await self.cog.execute_blackjack_stand(interaction.user.id)
        await interaction.followup.send(message)

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            embed=_rules_embed("blackjack", "ブラックジャック"), ephemeral=True)


# ---------------------------------------------------------------------------
# ダイス（数字当て）
# ---------------------------------------------------------------------------

def _dice_embed(cog: "GamblingCog", user_id: int) -> discord.Embed:
    embed = discord.Embed(title="ダイス（数字当て）", color=GAMBLING_COLOR)
    return embed


class DiceModal(discord.ui.Modal, title="ダイス（数字当て）"):
    max_value = discord.ui.TextInput(
        label="範囲（最大値）", placeholder="例: 100（半角数字）", max_length=6)
    number = discord.ui.TextInput(
        label="予想する数字", placeholder="例: 7（半角数字）", max_length=6)
    bet = discord.ui.TextInput(
        label="ベット額（AGO）", placeholder="例: 100（半角数字）", max_length=16)

    def __init__(self, cog: "GamblingCog"):
        super().__init__()
        self.cog = cog

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
        await interaction.followup.send(message)


class DiceView(discord.ui.View):
    def __init__(self, cog: "GamblingCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="ダイスを振る", style=discord.ButtonStyle.primary)
    async def roll(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(DiceModal(self.cog))

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
        await interaction.response.send_message(
            embed=_slot_embed(self, interaction.user.id), view=view)

    async def show_double(self, interaction: discord.Interaction):
        view = DoubleView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_double_embed(self, interaction.user.id), view=view)

    async def show_blackjack(self, interaction: discord.Interaction):
        view = BlackjackView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_blackjack_embed(self, interaction.user.id), view=view)

    async def show_dice(self, interaction: discord.Interaction):
        view = DiceView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_dice_embed(self, interaction.user.id), view=view)

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
        uid = str(user_id)
        try:
            result = self.store.spin_slot(uid)
            wallet = self._wallet()
            lines = [f"🎰 {''.join(map(str, result['reels']))}"]
            for event in result["events"]:
                lines.append(_SLOT_EVENT_LINES[event])
            if result["confiscate"]:
                taken = await self._confiscate_all(uid)
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
                    await self._record_history(
                        uid, GAMBLING_ID, -result["reward"], "gamble_slot")
                lines.append(f"**{result['reward']:+,} AGO**")
            if result["kakuhen"] > 0:
                lines.append(f"⚡ 確変残り {result['kakuhen']} 回")
            lines.append(f"残り回数: {result['remaining']} / {result['total']}")
            if result["finished"]:
                lines.append("セッション終了。おつかれさまでした。")
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return gambling_action_failed(exc)
        except Exception:
            logger.exception("gambling: スロットのスピンに失敗 user=%s", uid)
            return gambling_action_failed(
                "スピン中にエラーが発生しました。時間をおいて再試行してください。")

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
