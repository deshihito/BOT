# -*- coding: utf-8 -*-
"""アゴトークン市場: /general の通貨系パネルから使う市場・売買の入口。

レート生成・プール・売買計算の本体は core/general/market/market.py（MarketStore）。
ここは Discord 側の表示と、AGO コイン残高の実移動だけを担う。コインの
増減は必ず cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通し、この cog 独自の残高更新は作らない。

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:market / general:token_buy / general:token_sell）だけ。
tick は tasks.loop で5分ごとに回し、チャートは tick のたびに生成して
キャッシュ（data/market_chart.png）を全員で共有する。
"""
from __future__ import annotations
from core.support.emojis import SUCCESS

import asyncio
import logging
import math
from datetime import datetime, timedelta
from pathlib import Path

import discord
from discord.ext import commands, tasks

import config
from core.general import economy_helpers
from core.economy_image import render_market_chart_png
from core.general.circulation import economy_pool as economy_core
from core.general.items import items as items_core
from core.general.market import market as market_core
from core.game.game import prison as prison_core
from core.support.messages import COIN_UPDATE_FAILED_RETRY, MARKET_INVALID_AMOUNT, market_trade_failed
from core.support.panel_v2 import as_panel_v2, edit_panel_v2, edit_panel_with_files as _edit_panel, wrap_panel_view as _wrap
from cogs.general import INSUFFICIENT

logger = logging.getLogger(__name__)

CHART_FILENAME = "market_chart.png"
MARKET_COLOR = 0x2ECC71


#: チャート画像の保存先と同梱フォント。定義はこの実装モジュールが持ち、
#: 集約入口 cogs/general.py からは遅延再エクスポートされる。旧 cogs/market.py
#: 入口に定義があった頃は入口へのパッチで差し替えられたが、集約後は
#: discord.py の拡張ローダが集約モジュールのインスタンスを二重化し、
#: 入口側のパッチが実装に届かない場合があるため、実装側の所有に統一した
#: （nation / wordle と同じ流儀。テストもこちらをパッチする）。
CHART_PATH = Path(__file__).resolve().parents[3] / "data" / "market_chart.png"
CHART_FONT_PATH = (Path(__file__).resolve().parents[3]
                   / "assets" / "fonts" / "MPLUSRounded1c-Regular.ttf")


def _chart_path():
    return CHART_PATH


def _chart_font_path():
    return CHART_FONT_PATH
#: チャート描画に使う同梱の日本語フォント。描画基盤（core/economy_image
#: → core/leaderboard_image）も同じフォントを最優先で使うため、
#: タイトル等の日本語が豆腐化しない。


# ---------------------------------------------------------------------------
# コンポーネントV2 統一（core/support/panel_v2.py の流儀）
# ---------------------------------------------------------------------------

_fmt_tokens = economy_helpers.fmt_tokens


def _market_changes(state: dict) -> tuple[float, float]:
    """(1時間変動, 本日変動) を snapshot から計算する（表示専用）。"""
    now = datetime.now(config.JST)
    rate = float(state["rate"])
    change_day = rate / float(state["day_open_rate"]) - 1 if state["day_open_rate"] else 0.0
    change_1h = 0.0
    for entry in reversed(state["history"]):
        try:
            at = datetime.fromisoformat(entry["t"])
        except (ValueError, TypeError):
            continue
        if at <= now - timedelta(hours=1):
            change_1h = rate / float(entry["rate"]) - 1
            break
    return change_1h, change_day


def _chart_stats(store: market_core.MarketStore) -> dict:
    """チャート画像のヘッダに出す全体ステータス（表示専用の値）。

    プール額はユーザー向けに出さない方針（_market_embed と同じ）。
    流通量は全ユーザーの保有合計で、総供給量は定数から出す。
    """
    state = store.snapshot()
    change_1h, change_day = _market_changes(state)
    return {
        "rate": float(state["rate"]),
        "change_1h": change_1h,
        "change_day": change_day,
        "supply": int(market_core.TOTAL_TOKEN_SUPPLY),
        "circulating": int(sum(
            float(v) for v in (state.get("balances") or {}).values())),
    }


def _market_embed(store: market_core.MarketStore, user_id: int,
                  *, with_chart: bool = False) -> discord.Embed:
    state = store.snapshot()
    now = datetime.now(config.JST)
    rate = float(state["rate"])
    halted, reason = store.halt_status(now)
    embed = discord.Embed(title=f"{market_core.TOKEN_NAME}市場", color=MARKET_COLOR)
    if not with_chart:
        # チャート画像がまだ無い間だけ、レートと変動をテキストで出す
        # （チャートのヘッダに同じ値が載るため、画像がある時は二重にしない）。
        change_1h, change_day = _market_changes(state)
        embed.add_field(name="現在レート", value=f"**{rate:,.2f} AGO** / 1 {market_core.TOKEN_NAME}", inline=False)
        embed.add_field(name="変動（1時間）", value=f"{change_1h:+.2%}", inline=True)
        embed.add_field(name="変動（本日）", value=f"{change_day:+.2%}", inline=True)
    embed.add_field(name="あなたの保有量", value=f"{_fmt_tokens(store.token_balance(str(user_id)))} {market_core.TOKEN_NAME}", inline=True)
    # プール額はユーザー向けに出さない（取引可否の判定は内部で従来どおり）。
    embed.add_field(name="1回の取引上限", value=f"{store.trade_cap_aga():,} AGO", inline=True)
    if state.get("last_news"):
        embed.add_field(name="最近のニュース", value=str(state["last_news"]), inline=False)
    if halted:
        embed.add_field(name="⚠️ 取引停止中", value=reason, inline=False)
    if with_chart:
        # チャートは遷移させず、パネルを開いた時点で embed 内に出す。
        embed.set_image(url=f"attachment://{CHART_FILENAME}")
    embed.set_footer(text="レートは5分ごとに更新されます。売買には手数料がかかります。")
    return embed


def _render_chart(history: list[dict], stats: dict | None = None) -> bytes | None:
    """過去5時間の価格チャート（OHLC＋20期間移動平均）を描く。

    出来高の下段グラフは廃止し、価格チャートだけにした（ユーザー指示）。
    描画は白基調の共通基盤（core/economy_image.py、PIL）へ移し、
    ヘッダに現在レート・変動・総供給量/流通量も載せる。系列の整形
    （ohlc_buckets / moving_average）は従来どおり市場ロジック側の
    純関数を使い、表示層ではデータを加工しない。呼び出しは
    to_thread 前提。バケットが無ければ None。
    """
    buckets = market_core.ohlc_buckets(history, hours=5)
    if not buckets:
        return None
    closes = [b["close"] for b in buckets]
    ma = market_core.moving_average(closes, window=20)
    try:
        return render_market_chart_png(
            buckets=buckets, ma=ma, token_name=market_core.TOKEN_NAME,
            stats=stats)
    except Exception:
        logger.exception("market: チャート描画に失敗しました")
        return None


class TradeModal(discord.ui.Modal):
    amount = discord.ui.TextInput(label="数量", max_length=16)

    def __init__(self, cog: "MarketCog", side: str):
        self.cog = cog
        self.side = side
        if side == "buy":
            title = f"{market_core.TOKEN_NAME}を買う"
            label = "使う AGO コイン"
        else:
            title = f"{market_core.TOKEN_NAME}を売る"
            label = f"売る {market_core.TOKEN_NAME}"
        super().__init__(title=title)
        self.amount.label = label
        # 金額入力はミスが起きやすい場所なので、形式と例を常に見せる（監査 #7）。
        self.amount.placeholder = (
            "例: 1000（半角数字）" if side == "buy" else "例: 10.5（半角数字、小数可）"
        )

    async def on_submit(self, interaction: discord.Interaction):
        raw = str(self.amount.value).replace(",", "").strip()
        try:
            value = float(raw)
        except ValueError:
            return await interaction.response.send_message(MARKET_INVALID_AMOUNT, ephemeral=True)
        # E-5b: NaN/inf は float() を通過し、後段の int() 変換で
        # 未捕捉例外になるため、状態変更なしでここで弾く。
        if not math.isfinite(value):
            return await interaction.response.send_message(MARKET_INVALID_AMOUNT, ephemeral=True)
        await interaction.response.defer()
        if self.side == "buy":
            if value != int(value):
                return await interaction.followup.send(MARKET_INVALID_AMOUNT, ephemeral=True)
            message = await self.cog.execute_buy(interaction.user.id, int(value))
        else:
            message = await self.cog.execute_sell(interaction.user.id, value)
        await interaction.followup.send(message)


class MarketView(discord.ui.View):
    def __init__(self, cog: "MarketCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return _market_embed(
            self.cog.store, self.user_id,
            with_chart=self.cog.chart_path() is not None)

    def panel_files(self) -> list[discord.File] | None:
        path = self.cog.chart_path()
        if path is None:
            return None
        return [discord.File(str(path), filename=CHART_FILENAME)]

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await _edit_panel(interaction, self, button=button)

    @discord.ui.button(label="買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(TradeModal(self.cog, "buy"))

    @discord.ui.button(label="売る", style=discord.ButtonStyle.danger)
    async def sell(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(TradeModal(self.cog, "sell"))


class MarketCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: market_core.MarketStore | None = None,
                 economy_store: economy_core.EconomyPoolStore | None = None):
        self.bot = bot
        self.store = store if store is not None else market_core.MarketStore()
        # 手数料の消却分は経済系の損失として採掘プール／国庫へ還流する。
        self.economy_store = (
            economy_store if economy_store is not None
            else economy_core.shared_store())

    def _recycle_fee_burn(self, result: dict) -> None:
        """手数料のうち消却された分を還流する（best-effort）。"""
        burned = int(result.get("burned", 0))
        if burned <= 0:
            return
        try:
            self.economy_store.add_loss(burned)
        except Exception:
            logger.exception("market: 手数料消却分の還流に失敗しました")

    async def cog_load(self) -> None:
        if not self.tick_loop.is_running():
            self.tick_loop.start()

    async def cog_unload(self) -> None:
        if self.tick_loop.is_running():
            self.tick_loop.cancel()
        self.store.flush()

    @tasks.loop(seconds=market_core.TICK_SECONDS)
    async def tick_loop(self) -> None:
        try:
            self.store.tick()
            self.store.maybe_flush()
            self.economy_store.maybe_flush()
            await self._refresh_chart_cache()
        except Exception:
            logger.exception("market: tick の処理に失敗しました")

    @tick_loop.before_loop
    async def _before_tick_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def _refresh_chart_cache(self) -> None:
        data = await asyncio.to_thread(
            _render_chart, self.store.snapshot()["history"],
            _chart_stats(self.store))
        if data:
            try:
                _chart_path().parent.mkdir(parents=True, exist_ok=True)
                _chart_path().write_bytes(data)
            except Exception:
                logger.exception("market: チャートキャッシュの保存に失敗しました")

    def chart_path(self) -> Path | None:
        return _chart_path() if _chart_path().exists() else None

    # ------------------------------------------------------------------ 入口
    async def show_market(self, interaction: discord.Interaction):
        view = MarketView(self, interaction.user.id)
        wrapped = _wrap(view)
        files = view.panel_files()
        if files:
            await interaction.response.send_message(view=wrapped, files=files)
        else:
            await interaction.response.send_message(view=wrapped)

    async def open_buy(self, interaction: discord.Interaction):
        await interaction.response.send_modal(TradeModal(self, "buy"))

    async def open_sell(self, interaction: discord.Interaction):
        await interaction.response.send_modal(TradeModal(self, "sell"))

    # ------------------------------------------------------------------ 売買
    def _effective_fee_rate(self, user_id: str) -> float:
        """手数料率を決める。手数料パス（core/general/items/items.py の受動効果）が
        発動中なら半額にする。アイテム基盤が未読込なら通常率。"""
        items_cog = self.bot.get_cog("ItemsCog")
        store = getattr(items_cog, "store", None) if items_cog is not None else None
        if store is not None:
            try:
                if store.has_effect(user_id, items_core.FEE_DISCOUNT_EFFECT):
                    return market_core.FEE_RATE * items_core.FEE_DISCOUNT_MULTIPLIER
            except Exception:
                logger.exception("market: 手数料パスの確認に失敗 user=%s", user_id)
        return market_core.FEE_RATE

    def _effective_cap_ratio(self, user_id: str) -> float:
        """1回取引上限の比率を決める。優待パス（core/general/items/items.py の
        受動効果）が発動中なら上限を引き上げる。fee_rate と同じ流儀。
        アイテム基盤が未読込なら通常の比率。"""
        items_cog = self.bot.get_cog("ItemsCog")
        store = getattr(items_cog, "store", None) if items_cog is not None else None
        if store is not None:
            try:
                if store.has_effect(user_id, items_core.TRADE_VIP_EFFECT):
                    return items_core.TRADE_VIP_CAP_RATIO
            except Exception:
                logger.exception("market: 優待パスの確認に失敗 user=%s", user_id)
        return market_core.TRADE_CAP_POOL_RATIO

    def _wallet(self):
        return economy_helpers.wallet_cog(self.bot, market_core.TradeError)

    async def _record_history(self, sender_id: str, receiver_id: str, amount: int, reason: str) -> None:
        await economy_helpers.record_transaction_history(
            sender_id, receiver_id, amount, reason, log_label="market")

    async def execute_buy(self, user_id: int, aga_amount: int) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return market_trade_failed(blocked)
            fee_rate = self._effective_fee_rate(uid)
            cap_ratio = self._effective_cap_ratio(uid)
            self.store.validate_buy(aga_amount, fee_rate=fee_rate, cap_ratio=cap_ratio)
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -aga_amount, require_funds=True)
            if debit is INSUFFICIENT:
                return market_trade_failed("コインが不足しています。")
            if debit is None:
                return market_trade_failed(COIN_UPDATE_FAILED_RETRY)
            try:
                result = self.store.apply_buy(uid, aga_amount, fee_rate=fee_rate)
            except market_core.TradeError as exc:
                await wallet._change_balance(uid, aga_amount)
                return market_trade_failed(exc)
            self._recycle_fee_burn(result)
            await self._record_history(uid, "MARKET_POOL", aga_amount, "token_buy")
            return (
                f"{SUCCESS} **{market_core.TOKEN_NAME}を買いました**\n"
                f"{aga_amount:,} AGO → **{result['tokens']:,.2f} {market_core.TOKEN_NAME}**"
                f"（レート {result['rate']:,.2f}、手数料 {result['fee']:,} AGO）\n"
                f"保有量: {result['balance']:,.2f} {market_core.TOKEN_NAME} / コイン残高: {debit:,} AGO"
            )
        except market_core.TradeError as exc:
            return market_trade_failed(exc)
        except Exception:
            logger.exception("market: 買い処理に失敗 user=%s amount=%s", uid, aga_amount)
            return market_trade_failed("取引中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_sell(self, user_id: int, token_amount: float) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return market_trade_failed(blocked)
            fee_rate = self._effective_fee_rate(uid)
            cap_ratio = self._effective_cap_ratio(uid)
            self.store.validate_sell(uid, token_amount, fee_rate=fee_rate, cap_ratio=cap_ratio)
            wallet = self._wallet()
            result = self.store.apply_sell(uid, token_amount, fee_rate=fee_rate)
            # E-1: wallet の DB 即時コミット前に市場ストアを flush する。
            # クラッシュ時に「トークン復活＋コイン保持」で再売却できる
            # 窓を塞ぐ（アイテム売却と同型）。
            self.store.flush()
            credit = await wallet._change_balance(uid, result["net_aga"], create_with=0)
            if credit is None or credit is INSUFFICIENT:
                self.store.rollback_sell(uid, token_amount, result)
                return market_trade_failed("コインの更新に失敗したため、売却を取り消しました。")
            self._recycle_fee_burn(result)
            await self._record_history("MARKET_POOL", uid, result["net_aga"], "token_sell")
            return (
                f"{SUCCESS} **{market_core.TOKEN_NAME}を売りました**\n"
                f"{token_amount:,.2f} {market_core.TOKEN_NAME} → **{result['net_aga']:,} AGO**"
                f"（レート {result['rate']:,.2f}、手数料 {result['fee']:,} AGO）\n"
                f"保有量: {result['balance']:,.2f} {market_core.TOKEN_NAME} / コイン残高: {credit:,} AGO"
            )
        except market_core.TradeError as exc:
            return market_trade_failed(exc)
        except Exception:
            logger.exception("market: 売り処理に失敗 user=%s amount=%s", uid, token_amount)
            return market_trade_failed("取引中にエラーが発生しました。時間をおいて再試行してください。")


async def setup(bot: commands.Bot):
    await bot.add_cog(MarketCog(bot))
