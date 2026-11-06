# -*- coding: utf-8 -*-
"""マネーパネル: マネー系の実行を1つのパネルに集約する統合画面。

/general のマネージャンルには個別アクションが20件以上並んでいて、
1操作ごとにパネルを開き直す必要があった。このパネルは /game の画面の
ように、上部にその場の判断に必要なステータス（コイン残高・トークン
残高とレート・所持アイテム・加工機・宝くじ・採掘）を集約表示し、
カテゴリ切替で各機能をそのまま実行できる入口にする。

実行そのものは各 cog の既存の実行部と dispatch を再利用し、ここでは
二重化しない:
- モーダル系・別ビューを開く系は GeneralCog.dispatch_general 経由で
  既存アクション（general:token_buy 等）をそのまま呼ぶ
- その場で完結する系（採掘・受け取り・宝箱）は各 cog の execute_* を
  呼び、結果表示後にパネルを最新ステータスへ更新する

パネルは他の経済系パネルと同様、core/panel_v2.py の PanelLayoutView
で包んでコンポーネントV2表示にする（embed は非同期に集約するため、
ビルド結果をキャッシュして embed() から返す）。賭け金エスクロー等の
資産保全は各 cog 側の仕組みに任せるため、
パネルが死んでも資産は消えない。入口は新規スラッシュを作らず、
/general の action 経由（general:money_panel）だけ。表示は他のマネー系
パネルと同じく公開で、操作は interaction_check で本人のみに制限する。
パネルを開く自体は読み取り扱いで AI tools の対象外にはしないが、
メッセージ経由ショートカットの候補には入れない
（core/action_registry の MESSAGE_SHORTCUT_BLOCKED_IDS、items /
workshop と同じ扱い）。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from datetime import datetime
from typing import Callable

import discord
from discord.ext import commands

import config
from core.general import market as market_core
from core.game import prison as prison_core
from core.panel_v2 import as_panel_v2, edit_message_v2, edit_panel_v2
from cogs import wallet as wallet_module  # 定数は実行時に引く（テストの cog 再読込対策）

logger = logging.getLogger(__name__)

MONEY_PANEL_COLOR = 0xF39C12


def _wrap(view):
    """View を PanelLayoutView で包み、再描画用に view._v2 へ保持する。"""
    view._v2 = as_panel_v2(view)
    return view._v2

#: カテゴリ定義（value, ラベル）。コンポーネント上限（25）の関係で
#: 操作はカテゴリごとにページングする。
CATEGORIES: tuple[tuple[str, str], ...] = (
    ("home", "概要"),
    ("market", "市場"),
    ("items", "アイテム"),
    ("craft", "合成・工房"),
    ("play", "あそぶ"),
    ("more", "その他"),
)
CATEGORY_LABELS = dict(CATEGORIES)

#: ギャンブルのセッション種別 → 表示名。
_SESSION_LABELS = {
    "slot": "スロット",
    "double": "ダブルアップ",
    "blackjack": "ブラックジャック",
}


def _fmt_tokens(amount: float) -> str:
    return f"{amount:,.2f}"


def _fmt_minutes(seconds: float) -> str:
    minutes = int(seconds // 60) + (1 if seconds % 60 else 0)
    if minutes >= 60:
        return f"約{minutes / 60:.1f}時間"
    return f"約{minutes}分"


def status_embed(status: dict) -> discord.Embed:
    """collect_status の結果をパネル上部のステータス表示にする。"""
    embed = discord.Embed(title="マネーパネル", color=MONEY_PANEL_COLOR)
    if status.get("prison_remaining"):
        embed.add_field(
            name="状態",
            value=(f"🚔 **逮捕中**（釈放まであと"
                   f"{_fmt_minutes(status['prison_remaining'])}）。"
                   "マネー系の操作はできません。"),
            inline=False)
    embed.add_field(
        name="AGOコイン", value=f"**{status['balance']:,} AGO**", inline=True)
    if status.get("rate") is not None:
        embed.add_field(
            name=market_core.TOKEN_NAME,
            value=(f"**{_fmt_tokens(status['tokens'])}**"
                   f"（レート {status['rate']:,.2f} AGO）"),
            inline=True)
    if status.get("items_total") is not None:
        effects = status["effects"]
        value = f"全 **{status['items_total']} 個**（{status['items_kinds']} 種）"
        value += f"／宝箱 **{status['boxes']} 個**"
        if effects:
            value += f"／効果発動中 {effects} 件"
        embed.add_field(name="アイテム", value=value, inline=True)
    if status.get("machines") is not None:
        if status["machines"]:
            value = (
                f"{status['machines']} 台／受け取り待ち "
                f"**{status['pending_cycles']} サイクル分**")
            if status["min_cycles_left"] is not None:
                value += f"／最短の残り寿命 {status['min_cycles_left']} サイクル"
            if status["commissions_total"]:
                value += (
                    f"／委託 {status['commissions_total']} 件"
                    f"（受け取り可能 {status['commissions_ready']} 件）")
        else:
            value = "加工機なし"
        if status["streak_days"]:
            value += (
                f"\nストリーク **{status['streak_days']} 日**"
                "（生産ボーナスあり）")
        embed.add_field(name="工房", value=value, inline=False)
    if status.get("lottery_pool") is not None:
        embed.add_field(
            name="宝くじ",
            value=(f"プール **{status['lottery_pool']:,} AGO**／"
                   f"自分のチケット **{status['lottery_tickets']} 枚**"
                   f"（締切 {status['lottery_closes']}）"),
            inline=True)
    if status.get("mining_session_left") is not None:
        if status["mining_session_left"] > 0:
            mining_value = (
                f"**掘れます**（セッション残り {status['mining_session_left']} 回）")
        elif status["mining_ready"]:
            mining_value = "**いま掘れます**"
        else:
            mining_value = f"次まで {_fmt_minutes(status['mining_remaining'])}"
        mining_value += f"／プール {status['mining_pool']:,} AGO"
        embed.add_field(name="採掘", value=mining_value, inline=True)
    if status.get("session_kind"):
        label = _SESSION_LABELS.get(status["session_kind"], status["session_kind"])
        embed.add_field(
            name="ギャンブル", value=f"{label} のセッション進行中", inline=True)
    return embed


class MoneyPanelView(discord.ui.View):
    """カテゴリ切替つきの統合パネル。ボタンは既存の実行部へ委譲する。"""

    def __init__(self, cog: "MoneyPanelCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.category = "home"
        self.message: discord.Message | None = None
        self._v2 = None
        self._cached_embed: discord.Embed | None = None
        # 逮捕中だけ概要に脱獄ボタンを出す（build_embed で状態が入る）。
        self._prison = False
        self.refresh()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        """V2 ラッパー用の同期的 embed（実体は非同期ビルドのキャッシュ）。"""
        if self._cached_embed is not None:
            return self._cached_embed
        return discord.Embed(title="マネーパネル", color=MONEY_PANEL_COLOR)

    # ------------------------------------------------------------------ 構築
    def refresh(self) -> None:
        self.clear_items()
        select = discord.ui.Select(
            placeholder="カテゴリを選択してください",
            options=[
                discord.SelectOption(
                    label=label, value=value, default=value == self.category)
                for value, label in CATEGORIES
            ],
            row=0,
        )
        select.callback = self._on_category
        self.add_item(select)
        for label, style, handler in self._buttons_for(self.category):
            self._add_button(label, style, handler)
        if self.category == "home" and getattr(self, "_prison", False):
            self._add_button(
                "脱獄を試みる", discord.ButtonStyle.danger, self._jailbreak)

    def _add_button(self, label: str, style: discord.ButtonStyle, handler) -> None:
        # ボタンは最大5個で自動的に次の行へ回す（Select が row 0 を使う）。
        index = len(self.children) - 1  # Select 分を引いたボタン数
        button = discord.ui.Button(
            label=label, style=style, row=1 + index // 5)
        button.callback = handler
        self.add_item(button)

    def _buttons_for(self, category: str):
        """(ラベル, スタイル, ハンドラ) の並び。ハンドラはこのビューのメソッド。"""
        primary = discord.ButtonStyle.primary
        success = discord.ButtonStyle.success
        danger = discord.ButtonStyle.danger
        secondary = discord.ButtonStyle.secondary
        if category == "market":
            return [
                ("買う", success, self._dispatch("token_buy")),
                ("売る", danger, self._dispatch("token_sell")),
                ("市場パネル", primary, self._dispatch("market")),
            ]
        if category == "items":
            return [
                ("買う", success, self._dispatch("item_buy")),
                ("売る", primary, self._item_sell),
                ("使う", primary, self._dispatch("item_use")),
                ("宝箱を開ける", danger, self._open_boxes),
                ("アイテムパネル", secondary, self._dispatch("items")),
                ("ロールショップ", secondary, self._dispatch("role_shop")),
            ]
        if category == "craft":
            return [
                ("合成する", success, self._dispatch("craft")),
                ("生産物を受け取る", primary, self._claim_production),
                ("委託を受け取る", primary, self._claim_commissions),
                ("加工機を買う", success, self._dispatch("machine_buy")),
                ("工房パネル", secondary, self._dispatch("workshop")),
            ]
        if category == "play":
            return [
                ("採掘する", success, self._dig),
                ("宝くじを買う", primary, self._dispatch("lottery_buy")),
                ("宝くじパネル", secondary, self._dispatch("lottery")),
                ("盗む", danger, self._dispatch("steal")),
                ("スロット", primary, self._dispatch("slot")),
                ("ダブルアップ", primary, self._dispatch("double")),
                ("ブラックジャック", primary, self._dispatch("blackjack")),
                ("ダイスベット", primary, self._dispatch("dice")),
            ]
        if category == "more":
            return [
                ("送金", primary, self._dispatch("pay")),
                ("プレイヤー状況", secondary, self._dispatch("status")),
                ("コイン保有ランキング", secondary, self._dispatch("coin_leaderboard")),
                ("日報DMを設定", secondary, self._dispatch("daily_report")),
            ]
        # home: よく使う即時操作をその場で完結させる。
        return [
            ("採掘する", success, self._dig),
            ("生産物を受け取る", primary, self._claim_production),
            ("委託を受け取る", primary, self._claim_commissions),
            ("宝箱を開ける", danger, self._open_boxes),
        ]

    # ------------------------------------------------------------------ 共通動作
    async def build_embed(self) -> discord.Embed:
        status = await self.cog.collect_status(self.user_id)
        self._prison = bool(status.get("prison_remaining"))
        return status_embed(status)

    async def _on_category(self, interaction: discord.Interaction):
        values = getattr(interaction, "data", {}).get("values") or self._select_values()
        if values:
            self.category = values[0]
        self._cached_embed = await self.build_embed()
        self.refresh()
        container = getattr(self, "_v2", None)
        if container is not None:
            container._sync()
            await edit_panel_v2(interaction, container)
        else:
            await interaction.response.edit_message(
                embed=self._cached_embed, view=self)

    def _select_values(self) -> list:
        for child in self.children:
            if isinstance(child, discord.ui.Select):
                return list(child.values)
        return []

    async def refresh_panel(self) -> None:
        """直接実行のあとにパネル本体を最新ステータスへ差し替える。"""
        if self.message is None:
            return
        self._cached_embed = await self.build_embed()
        self.refresh()
        container = getattr(self, "_v2", None)
        try:
            if container is not None:
                container._sync()
                await edit_message_v2(self.message, container)
            else:
                await self.message.edit(embed=self._cached_embed, view=self)
        except Exception:
            logger.exception("money_panel: パネルの更新に失敗しました")

    def _dispatch(self, value: str):
        """既存アクションへ委譲するボタンのコールバックを作る。

        GeneralCog.dispatch_general がモーダル送信・別ビューの表示・
        未読込時の案内まで面倒を見るので、ここでは受け渡すだけにする。
        利用履歴・総量統計の記録も dispatch 側の入口に集約されたまま。
        """
        async def callback(interaction: discord.Interaction):
            general = self.cog.bot.get_cog("GeneralCog")
            if general is None:
                return await interaction.response.send_message(
                    "この機能は現在利用できません。", ephemeral=True)
            await general.dispatch_general(interaction, value)

        return callback

    async def _run_direct(self, interaction: discord.Interaction, factory) -> None:
        """その場で完結する実行部を呼び、結果表示後にパネルを更新する。"""
        await interaction.response.defer()
        try:
            result = factory()
            if inspect.isawaitable(result):
                result = await result
        except Exception:
            logger.exception("money_panel: 直接実行に失敗しました")
            result = "実行中にエラーが発生しました。時間をおいて再試行してください。"
        await interaction.followup.send(result)
        await self.refresh_panel()

    # ------------------------------------------------------------------ 直接実行
    async def _jailbreak(self, interaction: discord.Interaction):
        # 脱獄は逮捕中の本人だけ（interaction_check で本人に限定済み、
        # ストア側でも逮捕中でなければ何も起きない）。
        await self._run_direct(
            interaction, lambda: self.cog.attempt_jailbreak(interaction.user.id))

    async def _dig(self, interaction: discord.Interaction):
        circulation = self.cog.bot.get_cog("CirculationCog")
        if circulation is None:
            return await interaction.response.send_message(
                "採掘機能が読み込まれていません。", ephemeral=True)
        await self._run_direct(
            interaction, lambda: circulation.execute_mining(interaction.user.id))

    async def _item_sell(self, interaction: discord.Interaction):
        # 売却は個別アクションが無く ItemsView のモーダルが正なので、それを流用する。
        items_cog = self.cog.bot.get_cog("ItemsCog")
        if items_cog is None:
            return await interaction.response.send_message(
                "アイテム機能が読み込まれていません。", ephemeral=True)
        from cogs.items import ItemAmountModal

        await interaction.response.send_modal(ItemAmountModal(items_cog, "sell"))

    async def _open_boxes(self, interaction: discord.Interaction):
        items_cog = self.cog.bot.get_cog("ItemsCog")
        if items_cog is None:
            return await interaction.response.send_message(
                "アイテム機能が読み込まれていません。", ephemeral=True)
        await self._run_direct(
            interaction, lambda: items_cog.execute_open_boxes(interaction.user.id))

    async def _claim_production(self, interaction: discord.Interaction):
        workshop = self.cog.bot.get_cog("WorkshopCog")
        if workshop is None:
            return await interaction.response.send_message(
                "工房機能が読み込まれていません。", ephemeral=True)
        await self._run_direct(
            interaction, lambda: workshop.execute_claim(interaction.user.id))

    async def _claim_commissions(self, interaction: discord.Interaction):
        workshop = self.cog.bot.get_cog("WorkshopCog")
        if workshop is None:
            return await interaction.response.send_message(
                "工房機能が読み込まれていません。", ephemeral=True)
        await self._run_direct(
            interaction, lambda: workshop.execute_claim_commissions(interaction.user.id))


class MoneyPanelCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 balance_reader: Callable[[str], int] | None = None):
        self.bot = bot
        self._balance_reader = balance_reader

    # ------------------------------------------------------------------ 残高
    async def _balance(self, user_id: str) -> int:
        """残高の読み取り（行が無いユーザーは新規残高として表示する）。"""
        if self._balance_reader is not None:
            return int(self._balance_reader(str(user_id)))

        def _read() -> int | None:
            response = config.db_api.table("users").select("balance") \
                .eq("user_id", str(user_id)).execute()
            if not response.data:
                return None
            return int(response.data[0].get("balance") or 0)

        balance = await asyncio.to_thread(_read)
        if balance is None:
            return int(wallet_module.NEW_USER_BALANCE)
        return balance

    # ------------------------------------------------------------------ 集約
    async def collect_status(self, user_id: int) -> dict:
        """各ストアからパネル表示用のステータスを集める（読み取りのみ）。

        cog が未読込のセクションは None にして、表示側で省略する。
        1セクションの失敗でパネル全体を落とさない。
        """
        uid = str(user_id)
        now = datetime.now(config.JST)
        status: dict = {"balance": await self._balance(uid)}

        market_cog = self.bot.get_cog("MarketCog")
        if market_cog is not None:
            try:
                store = market_cog.store
                status["rate"] = float(store.snapshot()["rate"])
                status["tokens"] = float(store.token_balance(uid))
            except Exception:
                logger.exception("money_panel: 市場ステータスの取得に失敗 user=%s", uid)
                status["rate"] = None

        items_cog = self.bot.get_cog("ItemsCog")
        if items_cog is not None:
            try:
                store = items_cog.store
                inventory = store.inventory(uid)
                status["items_total"] = sum(inventory.values())
                status["items_kinds"] = len(inventory)
                status["boxes"] = int(inventory.get("treasure_box", 0))
                status["effects"] = len(store.active_effects(uid))
            except Exception:
                logger.exception("money_panel: アイテムステータスの取得に失敗 user=%s", uid)
                status["items_total"] = None

        workshop_cog = self.bot.get_cog("WorkshopCog")
        if workshop_cog is not None:
            try:
                store = workshop_cog.workshop_store
                machines = store.machines(uid)
                status["machines"] = len(machines)
                status["pending_cycles"] = int(store.total_pending(uid, now))
                status["min_cycles_left"] = (
                    min(int(m.get("cycles_left", 0)) for m in machines)
                    if machines else None)
                streak = store.streak_status(uid, now)
                status["streak_days"] = int(streak["days"])
                status["streak_bonus"] = float(streak["bonus_rate"])
                jobs = store.commissions(uid)
                status["commissions_total"] = len(jobs)
                status["commissions_ready"] = sum(
                    1 for job in jobs
                    if datetime.fromisoformat(job["ready_at"]) <= now)
            except Exception:
                logger.exception("money_panel: 工房ステータスの取得に失敗 user=%s", uid)
                status["machines"] = None

        circulation = self.bot.get_cog("CirculationCog")
        if circulation is not None:
            try:
                current = circulation.lottery_store.current_round()
                status["lottery_pool"] = int(current["pool"])
                status["lottery_tickets"] = int(
                    circulation.lottery_store.tickets_of(uid))
                status["lottery_closes"] = datetime.fromisoformat(
                    current["closes_at"]).strftime("%m/%d %H:%M")
            except Exception:
                logger.exception("money_panel: 宝くじステータスの取得に失敗 user=%s", uid)
                status["lottery_pool"] = None
            try:
                mining_status = circulation.mining_store.status(uid)
                status["mining_ready"] = mining_status["cooldown_remaining"] <= 0
                status["mining_remaining"] = float(mining_status["cooldown_remaining"])
                status["mining_session_left"] = int(mining_status["session_left"])
                status["mining_pool"] = int(
                    circulation.economy_store.pool_balance())
            except Exception:
                logger.exception("money_panel: 採掘ステータスの取得に失敗 user=%s", uid)
                status["mining_session_left"] = None

        gambling_cog = self.bot.get_cog("GamblingCog")
        if gambling_cog is not None:
            try:
                session = gambling_cog.store.session(uid)
                status["session_kind"] = session["kind"] if session else None
            except Exception:
                logger.exception("money_panel: ギャンブルステータスの取得に失敗 user=%s", uid)
                status["session_kind"] = None

        try:
            pstatus = self._prison_store().status(uid, now)
            status["prison_remaining"] = (
                float(pstatus["remaining"]) if pstatus["imprisoned"] else None)
        except Exception:
            logger.exception("money_panel: 逮捕ステータスの取得に失敗 user=%s", uid)
            status["prison_remaining"] = None

        return status

    # ------------------------------------------------------------------ 逮捕・脱獄
    def _prison_store(self) -> prison_core.PrisonStore:
        """逮捕ストア（circulation の保持分を優先し、無ければ共有ストア）。"""
        circulation = self.bot.get_cog("CirculationCog")
        store = getattr(circulation, "prison_store", None)
        return store if store is not None else prison_core.shared_store()

    async def attempt_jailbreak(self, user_id: int) -> str:
        """脱獄を試み、結果文を返す（成否の抽選と状態更新はストア側）。"""
        result = self._prison_store().attempt_jailbreak(str(user_id))
        outcome = result.get("outcome")
        if outcome == "success":
            return "🔓 **脱獄成功！** 釈放されました。"
        if outcome == "failure":
            return (
                "🔒 脱獄に失敗しました…"
                f"（釈放まであと{prison_core.format_remaining(result['remaining'])}）")
        if outcome == "cooldown":
            return (
                "まだ脱獄を試みられません"
                f"（あと{prison_core.format_remaining(result['wait_seconds'])}）。")
        return "逮捕されていません。"

    # ------------------------------------------------------------------ 入口
    async def show_panel(self, interaction: discord.Interaction):
        view = MoneyPanelView(self, interaction.user.id)
        view._cached_embed = await view.build_embed()
        view.refresh()
        await interaction.response.send_message(view=_wrap(view))
        try:
            view.message = await interaction.original_response()
        except Exception:
            logger.exception("money_panel: パネルのメッセージ取得に失敗しました")


async def setup(bot: commands.Bot):
    await bot.add_cog(MoneyPanelCog(bot))
