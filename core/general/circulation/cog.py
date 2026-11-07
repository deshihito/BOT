# -*- coding: utf-8 -*-
"""採掘・宝くじ・盗む: /general のマネージャンルから使う循環モジュールの入口。

本体は core/game/mining.py（採掘）・core/game/lottery.py（宝くじ）・core/general/circulation/steal.py
（盗む）で、ここは Discord 側の表示と、AGO コイン残高の実移動だけを
担う。コインの増減は必ず cogs/wallet.py の安全な経路（CAS 更新
_change_balance と transaction_history への記録）を通す
（cogs/workshop.py と同じ組み立て）。

- 採掘: 原典準拠のセッション式（1〜20回、60秒クールダウン）。
  コインは新規創出ではなく、経済系の損失が還流される共有プール
  （core/general/circulation/economy_pool.py）から支払う。プールが空なら掘れない
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
import random
from datetime import datetime
from typing import Callable

import discord
from discord.ext import commands, tasks

import config
from core.game.clan import clan as clan_core
from core.general.user_names import cached_display_name
from core.game.gacha import gacha as gacha_core
from core.general.circulation import economy_pool as economy_core
from core.general.items import items as items_core
from core.game import lottery as lottery_core
from core.game import mining as mining_core
from core.game.game import prison as prison_core
from core.general.circulation import steal as steal_core
from core.support.messages import (
    ACTION_FAILED_RETRY,
    COIN_UPDATE_FAILED_RETRY,
    COIN_UPDATE_FAILED_UNCHANGED,
    PURCHASE_FAILED_RETRY,
    circulation_action_failed,
)
from core.support.panel_v2 import as_panel_v2, edit_panel_v2, edit_panel_view as _edit_panel, wrap_panel_view as _wrap
from cogs import general as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

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
# コンポーネントV2 統一（core/support/panel_v2.py の流儀）
# ---------------------------------------------------------------------------


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
    # 導線最適化ラウンド4: プールの仕組み説明（フッター）は常時表示をやめた。
    # 残高は上のフィールドで分かり、空の場合は実行結果が明示する。
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

    def embed(self) -> discord.Embed:
        return _mining_embed(self.cog, self.user_id, self.last_result)

    # 導線最適化ラウンド4: 再描画だけの「更新」ボタンは置かない（S9/R2-5
    # と同じ作法）。クールダウン中でも「採掘する」を押せば状態が更新され、
    # 残り時間つきの結果が返るため、更新専用ボタンは不要。

    @discord.ui.button(label="採掘する", style=discord.ButtonStyle.success)
    async def dig(self, interaction: discord.Interaction, button: discord.ui.Button):
        # セッション型なので新規投稿せず、同じメッセージを編集して更新する。
        await interaction.response.defer()
        self.last_result = await self.cog.execute_mining(interaction.user.id)
        await _edit_panel(interaction, self, button=button)


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
            # 当選者は全サーバー横断の抽選結果なので、氏名は通常表記にする
            lines = [
                f"・{cached_display_name(cog.bot, w['user_id'])} — **{w['prize']:,} AGO**（{w['tickets']}枚）"
                for w in last["winners"]
            ]
            value = "\n".join(lines)
        else:
            value = "購入がなかったため、プールは次回へ繰り越しました。"
        if int(last.get("boost") or 0) > 0:
            # 国庫放出の発生だけを伝える（内訳の数値は出さない）。
            value += "\n🪙 国庫からの放出で賞金が上乗せされました。"
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

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="宝くじを買う", description="購入する枚数を選んでください。",
            color=CIRCULATION_COLOR)

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

    def embed(self) -> discord.Embed:
        return _lottery_embed(self.cog, self.user_id)

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.settle_lottery()
        await _edit_panel(interaction, self, button=button)

    @discord.ui.button(label="宝くじを買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.settle_lottery()
        if self.cog.lottery_store.remaining_allowance(str(interaction.user.id)) <= 0:
            return await interaction.response.send_message(
                circulation_action_failed(
                    f"チケットは1人{lottery_core.MAX_TICKETS_PER_USER}枚までです。"),
                ephemeral=True)
        await interaction.response.send_message(
            view=_wrap(BuyLotteryView(self.cog, interaction.user.id)))


# ---------------------------------------------------------------------------
# 盗む
# ---------------------------------------------------------------------------

# ルール文は「ルール」ボタンの裏に隔離する（導線最適化 S9 と同じ方式、
# ラウンド4で盗むにも適用）。パネル本文は状態だけにする。
STEAL_RULES = (
    f"成功すると相手の残高の一部（最大 {steal_core.STEAL_MAX_AMOUNT:,} AGO）"
    "を盗めます。\n"
    f"失敗すると相手に罰金 **{steal_core.FINE_AMOUNT:,} AGO** を払います。"
    f"残高 {steal_core.TARGET_MIN_BALANCE:,} AGO 未満の相手は保護されて盗めません。\n"
    "狙えるのは同じサーバーのメンバーだけです。狙われた相手はしばらく保護されます。")


def _steal_rules_embed() -> discord.Embed:
    return discord.Embed(
        title="盗む のルール", description=STEAL_RULES, color=CIRCULATION_COLOR)


def _steal_embed(cog: "CirculationCog", user_id: int) -> discord.Embed:
    status = cog.steal_store.actor_status(str(user_id))
    embed = discord.Embed(title="盗む", color=CIRCULATION_COLOR)
    if status["cooldown_remaining"] > 0:
        state = f"次に実行できるまで {_fmt_minutes(status['cooldown_remaining'])}"
    else:
        state = "**いま実行できます**"
    embed.add_field(name="状態", value=state, inline=False)
    embed.add_field(
        name="今日の実行",
        value=f"{status['today_count']} / {status['daily_limit']} 回", inline=True)
    return embed


class StealTargetSelect(discord.ui.UserSelect):
    def __init__(self, cog: "CirculationCog"):
        self.cog = cog
        super().__init__(placeholder="盗む相手を選ぶ", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        target = self.values[0]
        guild = interaction.guild
        member = guild.get_member(target.id) if guild is not None else None
        # 結果は本人だけに返す（S4-2）ため ephemeral で defer する。
        await interaction.response.defer(ephemeral=True)
        message = await self.cog.execute_steal(
            interaction.user.id, target.id,
            in_guild=member is not None,
            target_is_bot=bool(getattr(target, "bot", False)),
        )
        # 公開ポリシー（S4-2）: 逮捕の発生を含む結果は本人だけに返す
        # （公開投稿は新規に増やさない）。
        await interaction.followup.send(message, ephemeral=True)


class StealView(discord.ui.View):
    def __init__(self, cog: "CirculationCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        self.add_item(StealTargetSelect(cog))
        rules = discord.ui.Button(
            label="ルール", style=discord.ButtonStyle.secondary, row=1)
        rules.callback = self._rules
        self.add_item(rules)

    async def _rules(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            embed=_steal_rules_embed(), ephemeral=True)

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return _steal_embed(self.cog, self.user_id)


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
                 economy_store: economy_core.EconomyPoolStore | None = None,
                 prison_store: prison_core.PrisonStore | None = None):
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
        # 逮捕状態も経済系で共有する単一インスタンスを使う。
        self.prison_store = (
            prison_store if prison_store is not None
            else prison_core.shared_store())
        self._injected_item_store = item_store
        self._balance_reader = balance_reader
        # 警棒の撃退抽選・泥帽の上乗せ率の抽選用（テストで差し替え可能）。
        self._rng = random.Random()

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
        self.prison_store.flush()

    @tasks.loop(seconds=mining_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.mining_store.maybe_flush()
            self.lottery_store.maybe_flush()
            self.steal_store.maybe_flush()
            self.economy_store.maybe_flush()
            self.prison_store.maybe_flush()
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
        return await wallet_module.read_user_balance(
            user_id, self._balance_reader, missing_balance=0)

    # ------------------------------------------------------------------ 入口
    async def show_mining(self, interaction: discord.Interaction):
        view = MiningView(self, interaction.user.id)
        await interaction.response.send_message(view=_wrap(view))

    async def show_lottery(self, interaction: discord.Interaction):
        # 先にACKする: settle_lottery は締切到来時に当選者への送金（DB更新）
        # を伴い、応答前に行うと panel_recovery に誤判定される。
        await interaction.response.defer()
        await self.settle_lottery()
        view = LotteryView(self, interaction.user.id)
        await interaction.followup.send(view=_wrap(view))

    async def open_lottery_buy(self, interaction: discord.Interaction):
        # 先にACKする（show_lottery と同じ理由）。
        await interaction.response.defer()
        await self.settle_lottery()
        if self.lottery_store.remaining_allowance(str(interaction.user.id)) <= 0:
            return await interaction.followup.send(
                circulation_action_failed(
                    f"チケットは1人{lottery_core.MAX_TICKETS_PER_USER}枚までです。"),
                ephemeral=True)
        await interaction.followup.send(
            view=_wrap(BuyLotteryView(self, interaction.user.id)))

    async def open_steal(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                circulation_action_failed("盗むはサーバーの中でのみ使えます。"),
                ephemeral=True)
        view = StealView(self, interaction.user.id)
        await interaction.response.send_message(view=_wrap(view))

    # ------------------------------------------------------------------ 採掘の実行
    def _party_power(self, uid: str) -> int:
        """編成ボーナス（S3）の編成レアリティ点合計。取得失敗時は0。

        core は gacha ストアを持たない。cog が gacha cog のストアを
        引いて渡す流儀（手数料パスと同じ）に倣い、ここで解決する。
        """
        try:
            gacha_cog = self.bot.get_cog("GachaCog")
            if gacha_cog is not None:
                return int(gacha_cog.store.party_power(uid))
        except Exception:
            pass
        return 0

    async def execute_mining(self, user_id: int, now: datetime | None = None) -> str:
        """採掘を1回分実行する（セッションの開始もここで面倒を見る）。

        産出コインは新規創出ではなく採掘プールから支払う。プールが
        空なら掘れない。採掘ドリンク発動中は通常の抽選を追加で
        もう1回引く（セッション回数は消費しない）。ガチャ編成が
        あれば編成ボーナスの追加抽選が付くことがある（S3）。
        """
        uid = str(user_id)
        try:
            try:
                store = self._item_store()
            except Exception:
                store = None
            blocked = prison_core.block_message(uid, now=now, store=self.prison_store)
            prison_blocked_message = blocked
            prison_miner_pending = False
            if blocked and store is not None:
                # プリズンマイナー（S6-4）: prison ブロックに対する唯一の
                # 例外。所持していれば1枚消費してこの採掘だけ通す。
                # E-8c: 消費はここでは行わない。セッション開始可能性と
                # プール残高の確認が済み、実際に掘れることが確定してから
                # 消費する（掘れない状況でアイテムだけ消えるのを防ぐ）。
                try:
                    if store.count(uid, items_core.PRISON_MINER_ITEM) > 0:
                        prison_miner_pending = True
                        blocked = None
                except Exception:
                    pass
            if blocked:
                return circulation_action_failed(blocked)
            try:
                no_fail = bool(store is not None and store.has_effect(
                    uid, items_core.MINING_NO_FAIL_EFFECT))
            except Exception:
                no_fail = False
            status = self.mining_store.status(uid, now=now)
            if status["session_left"] <= 0:
                # 直下掘り（S6-4）: 効果が残っていれば消費してこの
                # セッションを特殊ダイスで開始する。
                direct = False
                try:
                    if store is not None and store.has_effect(
                            uid, items_core.DIRECT_DIG_EFFECT):
                        store.consume_effect(uid, items_core.DIRECT_DIG_EFFECT)
                        direct = True
                except Exception:
                    direct = False
                granted = self.mining_store.start_session(
                    uid, now=now, direct=direct)
                status = self.mining_store.status(uid, now=now)
                session_note = f"（このセッションは {granted} 回まで掘れます）"
            else:
                session_note = ""
            pool = self.economy_store
            if pool.pool_balance() <= 0:
                return circulation_action_failed(
                    "プールにコインがありません…（経済の損失が還流されると掘れるようになります）")
            if prison_miner_pending:
                # E-8c: セッション開始可能性（上の start_session）とプール
                # 残高の確認が済んだこの時点で初めて消費する。消費できな
                # ければ（同時消費などで消えていた場合）掘らずに弾く。
                try:
                    store.remove(uid, items_core.PRISON_MINER_ITEM, 1)
                except Exception:
                    return circulation_action_failed(
                        prison_blocked_message or "逮捕中は採掘できません。")
            result = self.mining_store.dig(
                uid, pool.pool_balance(), now=now, no_fail=no_fail)
            paid = pool.pay(int(result["coins"]))
            total = paid
            bonus = None
            bonus_paid = 0
            try:
                boosted = bool(store is not None and store.has_effect(
                    uid, items_core.MINING_BOOST_EFFECT))
            except Exception:
                boosted = False
            if boosted:
                bonus = self.mining_store.roll_bonus(
                    pool.pool_balance(), no_fail=no_fail)
                bonus_paid = pool.pay(int(bonus["coins"]))
                total += bonus_paid
            # 編成ボーナス（S3）: 編成のレアリティ点合計に応じた確率で
            # 追加抽選1回。編成が空（power=0）なら従来動作と完全一致
            # （rng も消費しない）。
            party_bonus = None
            party_paid = 0
            power = self._party_power(uid)
            if power > 0 and (
                    self._rng.random()
                    < power * gacha_core.PARTY_BONUS_RATE_PER_POINT):
                party_bonus = self.mining_store.roll_bonus(
                    pool.pool_balance(), no_fail=no_fail)
                party_paid = pool.pay(int(party_bonus["coins"]))
                total += party_paid
            credit = None
            if total > 0:
                # E-1: pool.pay の控除はメモリ主体のバッチ保存なので、
                # wallet へ credit する前に pool ストアを flush する
                # （クラッシュ時に「プール復活＋コイン保持」で二重に
                # 掘れる状態を作らない）。
                pool.flush()
                credit = await self._wallet()._change_balance(
                    uid, total, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    if paid:
                        pool.refund(paid)
                    if bonus_paid:
                        pool.refund(bonus_paid)
                    if party_paid:
                        pool.refund(party_paid)
                    self.mining_store.rollback_dig(uid, result)
                    return circulation_action_failed(
                        "コインの反映に失敗しました。時間をおいて再試行してください。")
                await self._record_history(MINING_ID, uid, total, "mining_reward")
            lines = []
            if total > 0:
                lines.append(f"⛏️ **{total:,} AGO を採掘しました！**")
                if result.get("direct"):
                    lines.append("🕳️ 直下掘りで一気に掘った！")
                if result["jackpot"]:
                    lines.append(
                        f"🎉 **大量採掘ボーナス！** +{int(result['extra']):,} AGO")
                if bonus is not None and bonus_paid > 0:
                    lines.append(
                        f"🥤 採掘ドリンクで追加の一掘り: +{bonus_paid:,} AGO")
                if party_bonus is not None:
                    lines.append(
                        f"⭐ 編成ボーナスで追加でもう1回掘れた！ +{party_paid:,} AGO")
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
            # クラン貢献フック（所属中のみ・失敗しても採掘に影響させない）。
            clan_core.award_points(uid, clan_core.POINTS_MINING, "mining")
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return circulation_action_failed(exc)
        except Exception:
            logger.exception("circulation: 採掘に失敗 user=%s", uid)
            return circulation_action_failed(
                "採掘中にエラーが発生しました。時間をおいて再試行してください。")

    # ------------------------------------------------------------------ 宝くじの実行
    def _apply_treasury_outlets(self, now: datetime | None = None) -> None:
        """国庫の出口（仕様 S1）を lazy に適用する。

        週次還流（国庫→採掘プール）と、閾値超過分の宝くじブースト確保→
        現行ラウンドへの上乗せ。失敗しても宝くじ本体は止めない。
        """
        try:
            self.economy_store.maybe_weekly_release(now=now)
            self.economy_store.lottery_boost_amount(now=now)
            boost = self.economy_store.take_lottery_boost()
            if boost > 0:
                self.lottery_store.add_to_pool(boost, now=now)
        except Exception:
            logger.exception("circulation: 国庫の出口の適用に失敗しました")

    async def settle_lottery(self, now: datetime | None = None) -> dict | None:
        """締切を過ぎた回があれば確定し、当選者へ賞金を払う。"""
        try:
            result = self.lottery_store.settle_if_due(now=now)
        except Exception:
            logger.exception("circulation: 宝くじの抽選確定に失敗しました")
            return None
        # 確定の有無に関わらず、国庫の出口はこの入口で lazy に進める
        # （新ラウンドが始まった直後なら、そのラウンドへ上乗せされる）。
        self._apply_treasury_outlets(now=now)
        if not result:
            return None
        # E-1: 確定結果（と国庫ブーストの上乗せ）はメモリ主体のバッチ
        # 保存なので、当選者へ credit する前に lottery ストアを flush
        # する（クラッシュ後の再確定による二重支払いを防ぐ）。
        self.lottery_store.flush()
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
            blocked = prison_core.block_message(uid, now=now, store=self.prison_store)
            if blocked:
                return circulation_action_failed(blocked)
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
                    COIN_UPDATE_FAILED_RETRY)
            try:
                owned = self.lottery_store.add_tickets(uid, count, now=now)
            except items_core.ItemError as exc:
                # E-5c: debit 済みなので返金する。返金自体の成否（None＝
                # CAS 枯渇）も確認し、失敗したら重大ログ＋運営連絡の
                # 文言を出す（黙って損失を残さない）。
                refund = await wallet._change_balance(uid, total)
                if refund is None:
                    logger.critical(
                        "circulation: 宝くじ購入失敗時の返金に失敗しました。"
                        "手動で返金してください: user=%s amount=%s",
                        uid, total)
                    return circulation_action_failed(
                        f"{exc} コインの返金にも失敗しました。"
                        "運営へ連絡してください。")
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
                PURCHASE_FAILED_RETRY)

    # ------------------------------------------------------------------ 盗むの実行
    async def execute_steal(self, actor_id: int, target_id: int, *,
                            in_guild: bool, target_is_bot: bool = False,
                            now: datetime | None = None) -> str:
        actor = str(actor_id)
        target = str(target_id)
        # E-3: StealStore の予約（reserve→確定/ロールバック）。予約して
        # から先は await を挟んでも同時実行の2件目が必ず弾かれる。
        reservation = None

        def _confirm_reservation() -> None:
            nonlocal reservation
            if reservation is not None:
                try:
                    self.steal_store.commit_reservation(reservation)
                except Exception:
                    logger.exception("circulation: steal 予約の確定に失敗")
                reservation = None

        def _discard_reservation() -> None:
            nonlocal reservation
            if reservation is not None:
                try:
                    self.steal_store.rollback_reservation(reservation)
                except Exception:
                    logger.exception("circulation: steal 予約の取消に失敗")
                reservation = None

        try:
            if not in_guild:
                return circulation_action_failed(
                    "盗むは同じサーバーのメンバー同士でのみ使えます。")
            if actor == target:
                return circulation_action_failed("自分からは盗めません。")
            if target_is_bot:
                return circulation_action_failed("Botからは盗めません。")
            # 逮捕中のユーザーはマネー系の操作自体ができない。
            blocked = prison_core.block_message(actor, now=now, store=self.prison_store)
            if blocked:
                return circulation_action_failed(blocked)
            target_balance = await self._balance(target)
            if steal_core.steal_amount(target_balance) <= 0:
                return circulation_action_failed(
                    f"相手のコインが少ないため盗めません"
                    f"（残高 {steal_core.TARGET_MIN_BALANCE:,} AGO 未満の相手は保護されます）。")
            # 残高保護の判定（同期）と予約（同期）の間に await は無い。
            # ここでクールダウン・1日上限・対象保護を仮記録まで含めて
            # 原子的に押さえる（ItemError は外側で失敗文言になる）。
            reservation = self.steal_store.reserve(actor, target, now=now)
            try:
                item_store = self._item_store()
            except Exception:
                item_store = None

            def _count(user_id: str, item_id: str) -> int:
                if item_store is None:
                    return 0
                try:
                    return item_store.count(user_id, item_id)
                except Exception:
                    return 0

            def _has_effect(user_id: str, effect_id: str) -> bool:
                if item_store is None:
                    return False
                try:
                    return item_store.has_effect(user_id, effect_id)
                except Exception:
                    return False

            wallet = self._wallet()
            # 防犯チャーム発動中の相手は自動で失敗する（対象側への
            # 通知は増やさない。実行者の罰金・クールダウンは通常どおり）。
            # チャームが先に弾くため、その場合は警棒も発動しない。
            guarded = _has_effect(target, items_core.STEAL_GUARD_EFFECT)
            # 警棒系（対象の所持で受動発動）: 大警棒は常時、警棒は確率で
            # 撃退し、発動した1個が消滅して実行者は逮捕される。
            repelled_by: str | None = None
            if not guarded:
                if _count(target, items_core.DAI_BATON_ITEM) > 0:
                    repelled_by = items_core.DAI_BATON_ITEM
                elif (_count(target, items_core.BATON_ITEM) > 0
                        and self._rng.random() < items_core.BATON_REPEL_RATE):
                    repelled_by = items_core.BATON_ITEM
            if repelled_by is not None:
                # 罰金移転が失敗した場合は警棒を消費しない（E-5c:
                # 移転より先に消費すると、エラー時に警棒だけが消えて
                # 逮捕も試行記録も残らないため、消費は移転成功後に行う）。
                fine, fine_error = await self._transfer_fine(actor, target)
                if fine_error is not None:
                    _discard_reservation()
                    return circulation_action_failed(fine_error)
                try:
                    item_store.remove(target, repelled_by, 1)
                except Exception:
                    pass
                minutes = (
                    prison_core.DAI_BATON_PRISON_MINUTES
                    if repelled_by == items_core.DAI_BATON_ITEM
                    else prison_core.BATON_PRISON_MINUTES)
                self.prison_store.imprison(
                    actor, minutes=minutes, reason="baton_counter", now=now)
                _confirm_reservation()
                baton_name = items_core.ITEM_DEFS[repelled_by]["name"]
                lines = [
                    f"🚔 **{baton_name}で撃退されました！**",
                    f"逮捕されました（あと{prison_core.format_remaining(minutes * 60)}"
                    "はマネー系の操作ができません）。",
                ]
                if fine > 0:
                    lines.append(
                        f"罰金として <@{target}> に **{fine:,} AGO** を払いました。")
                return "\n".join(lines)
            # 泥帽系（実行者の所持）: 大泥帽を優先して1個使い、成功時は
            # 上乗せ、失敗時は逮捕。成功・失敗どちらでも消滅する。
            mud_item: str | None = None
            if _count(actor, items_core.DAI_MUD_HAT_ITEM) > 0:
                mud_item = items_core.DAI_MUD_HAT_ITEM
            elif _count(actor, items_core.MUD_HAT_ITEM) > 0:
                mud_item = items_core.MUD_HAT_ITEM
            rate_bonus = (
                items_core.DAI_MUD_HAT_RATE_BONUS
                if mud_item == items_core.DAI_MUD_HAT_ITEM else 0.0)
            amount_multiplier = 1.0
            # 大怪盗（期間効果）: 成功率と奪える額が上がる。
            if _has_effect(actor, items_core.THIEF_EFFECT):
                rate_bonus += items_core.THIEF_RATE_BONUS
                amount_multiplier = items_core.THIEF_AMOUNT_MULTIPLIER
            amount = steal_core.steal_amount(
                target_balance,
                rate_multiplier=amount_multiplier,
                cap_multiplier=amount_multiplier)
            if not guarded and self.steal_store.roll_success(rate_bonus):
                debit = await wallet._change_balance(
                    target, -amount, require_funds=True)
                if debit is wallet_module.INSUFFICIENT:
                    _discard_reservation()
                    return circulation_action_failed(
                        "相手の残高が変わったため、今回は盗めませんでした。")
                if debit is None:
                    _discard_reservation()
                    return circulation_action_failed(
                        COIN_UPDATE_FAILED_UNCHANGED)
                credit = await wallet._change_balance(
                    actor, amount, create_with=wallet_module.NEW_USER_BALANCE)
                if credit is None:
                    await wallet._change_balance(target, amount)
                    _discard_reservation()
                    return circulation_action_failed(
                        COIN_UPDATE_FAILED_UNCHANGED)
                await self._record_history(target, actor, amount, "steal_success")
                bonus = 0
                if mud_item is not None:
                    bonus = await self._steal_bonus(
                        wallet, actor, target, target_balance, mud_item)
                    try:
                        item_store.remove(actor, mud_item, 1)
                    except Exception:
                        pass
                _confirm_reservation()
                lines = [
                    f"🎉 **盗みに成功！** <@{target}> から **{amount:,} AGO** を盗みました。",
                ]
                if bonus > 0:
                    lines.append(
                        f"🎩 **{items_core.ITEM_DEFS[mud_item]['name']}の上乗せ！** "
                        f"追加で **{bonus:,} AGO** を奪いました。")
                lines.append(f"あなたの残高: {credit + bonus:,} AGO")
                return "\n".join(lines)
            fine, fine_error = await self._transfer_fine(actor, target)
            if fine_error is not None:
                _discard_reservation()
                return circulation_action_failed(fine_error)
            prison_note = ""
            if mud_item is not None:
                try:
                    item_store.remove(actor, mud_item, 1)
                except Exception:
                    pass
                minutes = (
                    prison_core.DAI_MUD_HAT_PRISON_MINUTES
                    if mud_item == items_core.DAI_MUD_HAT_ITEM
                    else prison_core.MUD_HAT_PRISON_MINUTES)
                self.prison_store.imprison(
                    actor, minutes=minutes, reason="mud_hat_failure", now=now)
                prison_note = (
                    f"\n🚔 **{items_core.ITEM_DEFS[mud_item]['name']}を使って失敗し、"
                    f"逮捕されました**（あと{prison_core.format_remaining(minutes * 60)}"
                    "はマネー系の操作ができません）。")
            _confirm_reservation()
            if guarded:
                head = "🛡️ **盗みに失敗…** 相手の防犯チャームに弾かれて逃げられました。"
            else:
                head = "🚨 **盗みに失敗…** 警戒されて逃げられました。"
            if fine > 0:
                return (
                    f"{head}"
                    f"罰金として <@{target}> に **{fine:,} AGO** を払いました。"
                    f"{prison_note}")
            return f"{head}（罰金はありませんでした）。{prison_note}"
        except items_core.ItemError as exc:
            _discard_reservation()
            return circulation_action_failed(exc)
        except Exception:
            _discard_reservation()
            logger.exception(
                "circulation: 盗みに失敗 actor=%s target=%s", actor, target)
            return circulation_action_failed(
                ACTION_FAILED_RETRY)

    async def _transfer_fine(self, actor: str, target: str) -> tuple[int, str | None]:
        """失敗時の罰金を actor から target へ移す。(支払額, エラー文) を返す。"""
        wallet = self._wallet()
        actor_balance = await self._balance(actor)
        fine = steal_core.fine_amount(actor_balance)
        if fine <= 0:
            return 0, None
        debit = await wallet._change_balance(actor, -fine, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            return 0, None
        if debit is None:
            return 0, COIN_UPDATE_FAILED_UNCHANGED
        credit = await wallet._change_balance(
            target, fine, create_with=wallet_module.NEW_USER_BALANCE)
        if credit is None:
            await wallet._change_balance(actor, fine)
            return 0, COIN_UPDATE_FAILED_UNCHANGED
        await self._record_history(actor, target, fine, "steal_fine")
        return fine, None

    async def _steal_bonus(self, wallet, actor: str, target: str,
                           target_balance: int, mud_item: str) -> int:
        """泥帽系の成功時上乗せを対象から実行者へ移し、移せた額を返す。

        上乗せ率は実行前の対象残高に対する一様乱数（原典の文法）。
        対象の残高が基本分の引き落としで減っているため、残りから
        払える分までが上限になる（ゼロサムは維持する）。
        """
        if mud_item == items_core.DAI_MUD_HAT_ITEM:
            low, high = (items_core.DAI_MUD_HAT_BONUS_MIN_RATE,
                         items_core.DAI_MUD_HAT_BONUS_MAX_RATE)
        else:
            low, high = (items_core.MUD_HAT_BONUS_MIN_RATE,
                         items_core.MUD_HAT_BONUS_MAX_RATE)
        wanted = int(target_balance * self._rng.uniform(low, high))
        if wanted <= 0:
            return 0
        debit = await wallet._change_balance(target, -wanted, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            wanted = max(0, await self._balance(target))
            if wanted <= 0:
                return 0
            debit = await wallet._change_balance(target, -wanted, require_funds=True)
        if debit is None or debit is wallet_module.INSUFFICIENT:
            return 0
        credit = await wallet._change_balance(
            actor, wanted, create_with=wallet_module.NEW_USER_BALANCE)
        if credit is None:
            await wallet._change_balance(target, wanted)
            logger.critical(
                "circulation: 泥帽の上乗せの支払いに失敗しました actor=%s target=%s amount=%s",
                actor, target, wanted)
            return 0
        await self._record_history(target, actor, wanted, "steal_success")
        return wanted


async def setup(bot: commands.Bot):
    await bot.add_cog(CirculationCog(bot))
