# -*- coding: utf-8 -*-
"""採掘・宝くじ・盗む: /general のマネージャンルから使う循環モジュールの入口。

本体は core/mining.py（採掘）・core/lottery.py（宝くじ）・core/steal.py
（盗む）で、ここは Discord 側の表示と、AGO コイン残高の実移動だけを
担う。コインの増減は必ず cogs/wallet.py の安全な経路（CAS 更新
_change_balance と transaction_history への記録）を通す
（cogs/workshop.py と同じ組み立て）。

- 採掘: 原典準拠のセッション式（1〜20回、60秒クールダウン）。
  コインは新規創出ではなく、経済系の損失が還流される共有プール
  （core/economy_pool.py）から支払う。プールが空なら掘れない
- 宝くじ: 売上の一部が賞金、残りは消却され、消却分は採掘プールと
  国庫へ還流される。抽選は毎日 JST 21:00 で、期限を過ぎた回は
  アクセス／定期チェックのたびに lazy に確定する
- 盗む: 同一ギルド内限定のゼロサム移転。新規創出は一切しない。
  防犯チャーム発動中の相手は自動で失敗する

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:mining / general:lottery / general:lottery_buy /
general:steal）だけ。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Callable

import discord
from discord.ext import commands, tasks

import config
from core import economy_pool as economy_core
from core import items as items_core
from core import lottery as lottery_core
from core import mining as mining_core
from core import steal as steal_core
from core.messages import circulation_action_failed
from cogs import wallet as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

logger = logging.getLogger(__name__)

CIRCULATION_COLOR = 0xE67E22
MINING_ID = "MINING"
LOTTERY_ID = "LOTTERY"


def _item_name(item_id: str) -> str:
    definition = items_core.ITEM_DEFS.get(item_id)
    return definition["name"] if definition else item_id


def _fmt_minutes(seconds: float) -> str:
    minutes = int(seconds // 60) + (1 if seconds % 60 else 0)
    if minutes >= 60:
        return f"約{minutes / 60:.1f}時間"
    return f"約{minutes}分"


# ---------------------------------------------------------------------------
# 採掘
# ---------------------------------------------------------------------------

def _mining_embed(cog: "CirculationCog", user_id: int,
                  result: str | None = None) -> discord.Embed:
    status = cog.mining_store.status(str(user_id))
    pool = cog.economy_store.pool_balance()
    embed = discord.Embed(title="採掘", color=CIRCULATION_COLOR)
    if result:
        embed.add_field(name="結果", value=result, inline=False)
    if status["session_left"] > 0:
        state = f"**掘れます**（このセッションはあと {status['session_left']} 回）"
    elif status["cooldown_remaining"] > 0:
        state = f"次に掘れるまで {_fmt_minutes(status['cooldown_remaining'])}"
    else:
        state = "**いま掘れます**"
    embed.add_field(name="状態", value=state, inline=False)
    embed.add_field(
        name="採掘プール", value=f"**{pool:,} AGO**", inline=True)
    embed.set_footer(
        text="掘ったコインはプールから支払われます。プールが空になると掘れません。")
    return embed


class MiningView(discord.ui.View):
    def __init__(self, cog: "CirculationCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        self.last_result: str | None = None

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(
            embed=_mining_embed(self.cog, self.user_id, self.last_result), view=self)

    @discord.ui.button(label="採掘する", style=discord.ButtonStyle.success)
    async def dig(self, interaction: discord.Interaction, button: discord.ui.Button):
        # セッション型なので新規投稿せず、同じ embed を編集して更新する。
        await interaction.response.defer()
        self.last_result = await self.cog.execute_mining(interaction.user.id)
        await interaction.edit_original_response(
            embed=_mining_embed(self.cog, self.user_id, self.last_result),
            view=self)


# ---------------------------------------------------------------------------
# 宝くじ
# ---------------------------------------------------------------------------

def _lottery_embed(cog: "CirculationCog", user_id: int) -> discord.Embed:
    store = cog.lottery_store
    current = store.current_round()
    closes_at = datetime.fromisoformat(current["closes_at"])
    embed = discord.Embed(title="宝くじ", color=CIRCULATION_COLOR)
    embed.add_field(
        name=f"第{current['id']}回 賞金プール",
        value=f"**{int(current['pool']):,} AGO**", inline=True)
    embed.add_field(
        name="締切", value=closes_at.strftime("%m/%d %H:%M"), inline=True)
    embed.add_field(
        name="あなたのチケット",
        value=f"{store.tickets_of(str(user_id))} / {lottery_core.MAX_TICKETS_PER_USER} 枚",
        inline=True)
    last = store.last_result()
    if last is not None:
        if last["winners"]:
            lines = [
                f"・<@{w['user_id']}> — **{w['prize']:,} AGO**（{w['tickets']}枚）"
                for w in last["winners"]
            ]
            value = "\n".join(lines)
        else:
            value = "購入がなかったため、プールは次回へ繰り越しました。"
        embed.add_field(name=f"前回（第{last['round_id']}回）の結果",
                        value=value, inline=False)
    embed.set_footer(
        text=f"チケットは1枚 {lottery_core.TICKET_PRICE} AGO、1人"
             f"{lottery_core.MAX_TICKETS_PER_USER}枚まで。抽選は毎日"
             f"{lottery_core.DRAW_HOUR}:00 です。")
    return embed


class BuyLotteryView(discord.ui.View):
    def __init__(self, cog: "CirculationCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id
        allowance = cog.lottery_store.remaining_allowance(str(user_id))
        counts = sorted({c for c in (1, 2, 3, 5, 10) if c <= allowance} | {allowance})
        options = [
            discord.SelectOption(
                label=f"{count} 枚（{count * lottery_core.TICKET_PRICE:,} AGO）",
                value=str(count))
            for count in counts if count > 0
        ]
        select = discord.ui.Select(placeholder="購入する枚数を選ぶ", options=options)
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        count = int(interaction.data["values"][0])
        await interaction.response.defer()
        message = await self.cog.execute_lottery_buy(interaction.user.id, count)
        await interaction.followup.send(message)


class LotteryView(discord.ui.View):
    def __init__(self, cog: "CirculationCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.settle_lottery()
        await interaction.response.edit_message(
            embed=_lottery_embed(self.cog, self.user_id), view=self)

    @discord.ui.button(label="宝くじを買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.settle_lottery()
        if self.cog.lottery_store.remaining_allowance(str(interaction.user.id)) <= 0:
            return await interaction.response.send_message(
                circulation_action_failed(
                    f"チケットは1人{lottery_core.MAX_TICKETS_PER_USER}枚までです。"),
                ephemeral=True)
        await interaction.response.send_message(
            "購入する枚数を選んでください。",
            view=BuyLotteryView(self.cog, interaction.user.id))


# ---------------------------------------------------------------------------
# 盗む
# ---------------------------------------------------------------------------

def _steal_embed(cog: "CirculationCog", user_id: int) -> discord.Embed:
    status = cog.steal_store.actor_status(str(user_id))
    embed = discord.Embed(title="盗む", color=CIRCULATION_COLOR)
    embed.description = (
        f"成功すると相手の残高の一部（最大 {steal_core.STEAL_MAX_AMOUNT:,} AGO）"
        "を盗めます。\n"
        f"失敗すると相手に罰金 **{steal_core.FINE_AMOUNT:,} AGO** を払います。"
        f"残高 {steal_core.TARGET_MIN_BALANCE:,} AGO 未満の相手は保護されて盗めません。")
    if status["cooldown_remaining"] > 0:
        state = f"次に実行できるまで {_fmt_minutes(status['cooldown_remaining'])}"
    else:
        state = "**いま実行できます**"
    embed.add_field(name="状態", value=state, inline=False)
    embed.add_field(
        name="今日の実行",
        value=f"{status['today_count']} / {status['daily_limit']} 回", inline=True)
    embed.set_footer(text="狙えるのは同じサーバーのメンバーだけです。狙われた相手はしばらく保護されます。")
    return embed


class StealTargetSelect(discord.ui.UserSelect):
    def __init__(self, cog: "CirculationCog"):
        self.cog = cog
        super().__init__(placeholder="盗む相手を選ぶ", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        target = self.values[0]
        guild = interaction.guild
        member = guild.get_member(target.id) if guild is not None else None
        await interaction.response.defer()
        message = await self.cog.execute_steal(
            interaction.user.id, target.id,
            in_guild=member is not None,
            target_is_bot=bool(getattr(target, "bot", False)),
        )
        await interaction.followup.send(message)


class StealView(discord.ui.View):
    def __init__(self, cog: "CirculationCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id
        self.add_item(StealTargetSelect(cog))


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class CirculationCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 mining_store: mining_core.MiningStore | None = None,
                 lottery_store: lottery_core.LotteryStore | None = None,
                 steal_store: steal_core.StealStore | None = None,
                 item_store: items_core.ItemStore | None = None,
                 balance_reader: Callable[[str], int] | None = None,
                 economy_store: economy_core.EconomyPoolStore | None = None):
        self.bot = bot
        self.mining_store = (
            mining_store if mining_store is not None else mining_core.MiningStore())
        self.lottery_store = (
            lottery_store if lottery_store is not None else lottery_core.LotteryStore())
        self.steal_store = (
            steal_store if steal_store is not None else steal_core.StealStore())
        # 採掘プール＋国庫は経済系で共有する単一インスタンスを使う。
        self.economy_store = (
            economy_store if economy_store is not None
            else economy_core.shared_store())
        self._injected_item_store = item_store
        self._balance_reader = balance_reader

    def _item_store(self) -> items_core.ItemStore:
        """ItemStore は ItemsCog のものを共有する（二重化すると所持が割れる）。"""
        if self._injected_item_store is not None:
            return self._injected_item_store
        items_cog = self.bot.get_cog("ItemsCog")
        if items_cog is None:
            raise items_core.ItemError("アイテム機能が読み込まれていません。")
        return items_cog.store

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.mining_store.flush()
        self.lottery_store.flush()
        self.steal_store.flush()
        self.economy_store.flush()

    @tasks.loop(seconds=mining_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.mining_store.maybe_flush()
            self.lottery_store.maybe_flush()
            self.steal_store.maybe_flush()
            self.economy_store.maybe_flush()
            await self.settle_lottery()
        except Exception:
            logger.exception("circulation: 定期フラッシュ／抽選確定に失敗しました")

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
            logger.exception("circulation: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
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

    # ------------------------------------------------------------------ 入口
    async def show_mining(self, interaction: discord.Interaction):
        view = MiningView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_mining_embed(self, interaction.user.id), view=view)

    async def show_lottery(self, interaction: discord.Interaction):
        await self.settle_lottery()
        view = LotteryView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_lottery_embed(self, interaction.user.id), view=view)

    async def open_lottery_buy(self, interaction: discord.Interaction):
        await self.settle_lottery()
        if self.lottery_store.remaining_allowance(str(interaction.user.id)) <= 0:
            return await interaction.response.send_message(
                circulation_action_failed(
                    f"チケットは1人{lottery_core.MAX_TICKETS_PER_USER}枚までです。"),
                ephemeral=True)
        await interaction.response.send_message(
            "購入する枚数を選んでください。",
            view=BuyLotteryView(self, interaction.user.id))

    async def open_steal(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                circulation_action_failed("盗むはサーバーの中でのみ使えます。"),
                ephemeral=True)
        view = StealView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_steal_embed(self, interaction.user.id), view=view)

    # ------------------------------------------------------------------ 採掘の実行
    async def execute_mining(self, user_id: int, now: datetime | None = None) -> str:
        """採掘を1回分実行する（セッションの開始もここで面倒を見る）。

        産出コインは新規創出ではなく採掘プールから支払う。プールが
        空なら掘れない。採掘ドリンク発動中は通常の抽選を追加で
        もう1回引く（セッション回数は消費しない）。
        """
        uid = str(user_id)
        try:
            status = self.mining_store.status(uid, now=now)
            if status["session_left"] <= 0:
                granted = self.mining_store.start_session(uid, now=now)
                status = self.mining_store.status(uid, now=now)
                session_note = f"（このセッションは {granted} 回まで掘れます）"
            else:
                session_note = ""
            pool = self.economy_store
            if pool.pool_balance() <= 0:
                return circulation_action_failed(
                    "プールにコインがありません…（経済の損失が還流されると掘れるようになります）")
            result = self.mining_store.dig(uid, pool.pool_balance(), now=now)
            paid = pool.pay(int(result["coins"]))
            total = paid
            bonus = None
            bonus_paid = 0
            try:
                boosted = self._item_store().has_effect(
                    uid, items_core.MINING_BOOST_EFFECT)
            except Exception:
                boosted = False
            if boosted:
                bonus = self.mining_store.roll_bonus(pool.pool_balance())
                bonus_paid = pool.pay(int(bonus["coins"]))
                total += bonus_paid
            credit = None
            if total > 0:
                credit = await self._wallet()._change_balance(
                    uid, total, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    if paid:
                        pool.refund(paid)
                    if bonus_paid:
                        pool.refund(bonus_paid)
                    self.mining_store.rollback_dig(uid, result)
                    return circulation_action_failed(
                        "コインの反映に失敗しました。時間をおいて再試行してください。")
                await self._record_history(MINING_ID, uid, total, "mining_reward")
            lines = []
            if total > 0:
                lines.append(f"⛏️ **{total:,} AGO を採掘しました！**")
                if result["jackpot"]:
                    lines.append(
                        f"🎉 **大量採掘ボーナス！** +{int(result['extra']):,} AGO")
                if bonus is not None and bonus_paid > 0:
                    lines.append(
                        f"🥤 採掘ドリンクで追加の一掘り: +{bonus_paid:,} AGO")
            elif result["failed"]:
                lines.append("💨 **採掘失敗…**")
            else:
                lines.append("💨 採掘しましたが、プールから払える分がありませんでした。")
            lines.append(f"残りプール: {pool.pool_balance():,} AGO")
            left = int(result["session_left"])
            if left > 0:
                lines.append(f"このセッションはあと {left} 回掘れます。")
            else:
                lines.append("このセッションは終了しました。")
            if session_note:
                lines.append(session_note)
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return circulation_action_failed(exc)
        except Exception:
            logger.exception("circulation: 採掘に失敗 user=%s", uid)
            return circulation_action_failed(
                "採掘中にエラーが発生しました。時間をおいて再試行してください。")

    # ------------------------------------------------------------------ 宝くじの実行
    async def settle_lottery(self, now: datetime | None = None) -> dict | None:
        """締切を過ぎた回があれば確定し、当選者へ賞金を払う。"""
        try:
            result = self.lottery_store.settle_if_due(now=now)
        except Exception:
            logger.exception("circulation: 宝くじの抽選確定に失敗しました")
            return None
        if not result:
            return None
        wallet = None
        for winner in result["winners"]:
            prize = int(winner["prize"])
            if prize <= 0:
                continue
            try:
                if wallet is None:
                    wallet = self._wallet()
                credit = await wallet._change_balance(
                    winner["user_id"], prize,
                    create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    # プール側は確定済みなので、払えなかった分は重大ログに残す
                    # （wallet の pay が返金失敗時に残すのと同じ扱い）。
                    logger.critical(
                        "circulation: 宝くじ賞金の支払いに失敗しました。手動で払ってください: "
                        "round=%s user=%s prize=%s",
                        result["round_id"], winner["user_id"], prize)
                    continue
                await self._record_history(
                    LOTTERY_ID, winner["user_id"], prize, "lottery_prize")
            except Exception:
                logger.exception(
                    "circulation: 宝くじ賞金の支払いで例外 round=%s user=%s",
                    result["round_id"], winner["user_id"])
        # 消却分は経済の損失として採掘プール／国庫へ還流する。
        burned = int(result.get("burned", 0))
        if burned > 0:
            try:
                self.economy_store.add_loss(burned)
            except Exception:
                logger.exception("circulation: 宝くじ消却分の還流に失敗しました")
        return result

    async def execute_lottery_buy(self, user_id: int, count: int,
                                  now: datetime | None = None) -> str:
        uid = str(user_id)
        try:
            await self.settle_lottery(now=now)
            if count <= 0:
                return circulation_action_failed("購入枚数は1枚以上で指定してください。")
            if count > self.lottery_store.remaining_allowance(uid, now=now):
                return circulation_action_failed(
                    f"チケットは1人{lottery_core.MAX_TICKETS_PER_USER}枚までです"
                    f"（現在 {self.lottery_store.tickets_of(uid, now=now)} 枚購入済み）。")
            total = lottery_core.TICKET_PRICE * count
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -total, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return circulation_action_failed("コインが不足しています。")
            if debit is None:
                return circulation_action_failed(
                    "コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                owned = self.lottery_store.add_tickets(uid, count, now=now)
            except items_core.ItemError as exc:
                await wallet._change_balance(uid, total)
                return circulation_action_failed(exc)
            await self._record_history(uid, LOTTERY_ID, total, "lottery_buy")
            current = self.lottery_store.current_round(now=now)
            return (
                f"🎟️ **チケットを {count} 枚購入しました**（合計 {owned} 枚）\n"
                f"{total:,} AGO ／ 賞金プール: {int(current['pool']):,} AGO\n"
                f"コイン残高: {debit:,} AGO")
        except items_core.ItemError as exc:
            return circulation_action_failed(exc)
        except Exception:
            logger.exception("circulation: 宝くじの購入に失敗 user=%s count=%s", uid, count)
            return circulation_action_failed(
                "購入中にエラーが発生しました。時間をおいて再試行してください。")

    # ------------------------------------------------------------------ 盗むの実行
    async def execute_steal(self, actor_id: int, target_id: int, *,
                            in_guild: bool, target_is_bot: bool = False,
                            now: datetime | None = None) -> str:
        actor = str(actor_id)
        target = str(target_id)
        try:
            if not in_guild:
                return circulation_action_failed(
                    "盗むは同じサーバーのメンバー同士でのみ使えます。")
            if actor == target:
                return circulation_action_failed("自分からは盗めません。")
            if target_is_bot:
                return circulation_action_failed("Botからは盗めません。")
            self.steal_store.check(actor, target, now=now)
            target_balance = await self._balance(target)
            amount = steal_core.steal_amount(target_balance)
            if amount <= 0:
                return circulation_action_failed(
                    f"相手のコインが少ないため盗めません"
                    f"（残高 {steal_core.TARGET_MIN_BALANCE:,} AGO 未満の相手は保護されます）。")
            # 防犯チャーム発動中の相手は自動で失敗する（対象側への
            # 通知は増やさない。実行者の罰金・クールダウンは通常どおり）。
            try:
                guarded = self._item_store().has_effect(
                    target, items_core.STEAL_GUARD_EFFECT)
            except Exception:
                guarded = False
            wallet = self._wallet()
            if not guarded and self.steal_store.roll_success():
                debit = await wallet._change_balance(
                    target, -amount, require_funds=True)
                if debit is wallet_module.INSUFFICIENT:
                    return circulation_action_failed(
                        "相手の残高が変わったため、今回は盗めませんでした。")
                if debit is None:
                    return circulation_action_failed(
                        "コインの更新に失敗しました。残高は変わっていません。")
                credit = await wallet._change_balance(
                    actor, amount, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    await wallet._change_balance(target, amount)
                    return circulation_action_failed(
                        "コインの更新に失敗しました。残高は変わっていません。")
                await self._record_history(target, actor, amount, "steal_success")
                self.steal_store.record_attempt(actor, target, now=now)
                return (
                    f"🎉 **盗みに成功！** <@{target}> から **{amount:,} AGO** を盗みました。\n"
                    f"あなたの残高: {credit:,} AGO")
            actor_balance = await self._balance(actor)
            fine = steal_core.fine_amount(actor_balance)
            if fine > 0:
                debit = await wallet._change_balance(
                    actor, -fine, require_funds=True)
                if debit is wallet_module.INSUFFICIENT:
                    fine = 0
                elif debit is None:
                    return circulation_action_failed(
                        "コインの更新に失敗しました。残高は変わっていません。")
                else:
                    credit = await wallet._change_balance(
                        target, fine, create_with=wallet_module.NEW_USER_BALANCE)
                    if credit is None:
                        await wallet._change_balance(actor, fine)
                        return circulation_action_failed(
                            "コインの更新に失敗しました。残高は変わっていません。")
                    await self._record_history(actor, target, fine, "steal_fine")
            self.steal_store.record_attempt(actor, target, now=now)
            if guarded:
                head = "🛡️ **盗みに失敗…** 相手の防犯チャームに弾かれて逃げられました。"
            else:
                head = "🚨 **盗みに失敗…** 警戒されて逃げられました。"
            if fine > 0:
                return (
                    f"{head}"
                    f"罰金として <@{target}> に **{fine:,} AGO** を払いました。")
            return f"{head}（罰金はありませんでした）。"
        except items_core.ItemError as exc:
            return circulation_action_failed(exc)
        except Exception:
            logger.exception(
                "circulation: 盗みに失敗 actor=%s target=%s", actor, target)
            return circulation_action_failed(
                "実行中にエラーが発生しました。時間をおいて再試行してください。")


async def setup(bot: commands.Bot):
    await bot.add_cog(CirculationCog(bot))
