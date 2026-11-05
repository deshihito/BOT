# -*- coding: utf-8 -*-
"""アゴトークン市場: /general の通貨系パネルから使う市場・売買の入口。

レート生成・プール・売買計算の本体は core/market.py（MarketStore）。
ここは Discord 側の表示と、AGO コイン残高の実移動だけを担う。コインの
増減は必ず cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通し、この cog 独自の残高更新は作らない。

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:market / general:token_buy / general:token_sell）だけ。
tick は tasks.loop で5分ごとに回し、チャートは tick のたびに生成して
キャッシュ（data/market_chart.png）を全員で共有する。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime, timedelta
from pathlib import Path

import discord
from discord.ext import commands, tasks

import config
from core import items as items_core
from core import market as market_core
from core.messages import MARKET_INVALID_AMOUNT, market_trade_failed
from cogs.wallet import INSUFFICIENT

logger = logging.getLogger(__name__)

CHART_PATH = Path(__file__).resolve().parent.parent / "data" / "market_chart.png"
MARKET_COLOR = 0x2ECC71


def _fmt_tokens(amount: float) -> str:
    return f"{amount:,.2f}"


def _market_embed(store: market_core.MarketStore, user_id: int) -> discord.Embed:
    state = store.snapshot()
    now = datetime.now(config.JST)
    rate = float(state["rate"])
    history = state["history"]
    change_day = rate / float(state["day_open_rate"]) - 1 if state["day_open_rate"] else 0.0
    change_1h = 0.0
    for entry in reversed(history):
        try:
            at = datetime.fromisoformat(entry["t"])
        except (ValueError, TypeError):
            continue
        if at <= now - timedelta(hours=1):
            change_1h = rate / float(entry["rate"]) - 1
            break
    halted, reason = store.halt_status(now)
    embed = discord.Embed(title=f"{market_core.TOKEN_NAME}市場", color=MARKET_COLOR)
    embed.add_field(name="現在レート", value=f"**{rate:,.2f} AGO** / 1 {market_core.TOKEN_NAME}", inline=False)
    embed.add_field(name="変動（1時間）", value=f"{change_1h:+.2%}", inline=True)
    embed.add_field(name="変動（本日）", value=f"{change_day:+.2%}", inline=True)
    embed.add_field(name="あなたの保有量", value=f"{_fmt_tokens(store.token_balance(str(user_id)))} {market_core.TOKEN_NAME}", inline=True)
    embed.add_field(name="市場プール（コイン）", value=f"{int(state['pool_aga']):,} AGO", inline=True)
    embed.add_field(name="市場プール（トークン）", value=f"{_fmt_tokens(float(state['pool_token']))}", inline=True)
    embed.add_field(name="1回の取引上限", value=f"{store.trade_cap_aga():,} AGO", inline=True)
    if state.get("last_news"):
        embed.add_field(name="最近のニュース", value=str(state["last_news"]), inline=False)
    if halted:
        embed.add_field(name="⚠️ 取引停止中", value=reason, inline=False)
    embed.set_footer(text="レートは5分ごとに更新されます。売買には1%の手数料がかかります。")
    return embed


def _render_chart(history: list[dict]) -> bytes | None:
    """過去5時間の OHLC チャートを描く（matplotlib は遅延 import、呼び出しは to_thread 前提）。"""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        logger.exception("market: matplotlib を読み込めませんでした")
        return None
    buckets = market_core.ohlc_buckets(history, hours=5)
    if not buckets:
        return None
    closes = [b["close"] for b in buckets]
    ma = market_core.moving_average(closes, window=20)
    fig, (ax, ax2) = plt.subplots(
        2, 1, figsize=(9, 5), gridspec_kw={"height_ratios": [4, 1]}, facecolor="#2b2d31")
    ax.set_facecolor("#2b2d31")
    ax2.set_facecolor("#2b2d31")
    for i, b in enumerate(buckets):
        color = "#00ff88" if b["close"] >= b["open"] else "#ff4444"
        ax.plot([i, i], [b["low"], b["high"]], color=color)
        ax.add_patch(plt.Rectangle((i - 0.3, min(b["open"], b["close"])), 0.6,
                                   max(abs(b["close"] - b["open"]), 0.01), color=color))
    ma_x = [i for i, v in enumerate(ma) if v is not None]
    ax.plot(ma_x, [ma[i] for i in ma_x], color="#ffaa00", linewidth=2)
    ax2.bar(range(len(buckets)), [b["volume"] for b in buckets], color="#888888")
    labels = [b["t"].strftime("%H:%M") for b in buckets]
    step = max(1, len(labels) // 10)
    ax.set_xticks(range(0, len(labels), step))
    ax.set_xticklabels(labels[::step], rotation=45, color="white")
    ax.tick_params(colors="white")
    ax2.tick_params(colors="white")
    ax.set_title(f"{market_core.TOKEN_NAME}市場（過去5時間）", color="white")
    buf = io.BytesIO()
    try:
        plt.savefig(buf, format="png", bbox_inches="tight", facecolor="#2b2d31")
        return buf.getvalue()
    except Exception:
        logger.exception("market: チャート描画に失敗しました")
        return None
    finally:
        plt.close(fig)


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

    async def on_submit(self, interaction: discord.Interaction):
        raw = str(self.amount.value).replace(",", "").strip()
        try:
            value = float(raw)
        except ValueError:
            return await interaction.response.send_message(MARKET_INVALID_AMOUNT, ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        if self.side == "buy":
            if value != int(value):
                return await interaction.followup.send(MARKET_INVALID_AMOUNT, ephemeral=True)
            message = await self.cog.execute_buy(interaction.user.id, int(value))
        else:
            message = await self.cog.execute_sell(interaction.user.id, value)
        await interaction.followup.send(message, ephemeral=True)


class MarketView(discord.ui.View):
    def __init__(self, cog: "MarketCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def _refresh(self, interaction: discord.Interaction):
        await interaction.response.edit_message(
            embed=_market_embed(self.cog.store, self.user_id), view=self)

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._refresh(interaction)

    @discord.ui.button(label="買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(TradeModal(self.cog, "buy"))

    @discord.ui.button(label="売る", style=discord.ButtonStyle.danger)
    async def sell(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(TradeModal(self.cog, "sell"))

    @discord.ui.button(label="チャート", style=discord.ButtonStyle.primary)
    async def chart(self, interaction: discord.Interaction, button: discord.ui.Button):
        path = self.cog.chart_path()
        if path is None:
            return await interaction.response.send_message(
                "チャートはまだ準備中です。少し待ってから開いてください。", ephemeral=True)
        await interaction.response.send_message(
            file=discord.File(str(path), filename="market_chart.png"))


class MarketCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: market_core.MarketStore | None = None):
        self.bot = bot
        self.store = store if store is not None else market_core.MarketStore()

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
            await self._refresh_chart_cache()
        except Exception:
            logger.exception("market: tick の処理に失敗しました")

    @tick_loop.before_loop
    async def _before_tick_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def _refresh_chart_cache(self) -> None:
        data = await asyncio.to_thread(_render_chart, self.store.snapshot()["history"])
        if data:
            try:
                CHART_PATH.parent.mkdir(parents=True, exist_ok=True)
                CHART_PATH.write_bytes(data)
            except Exception:
                logger.exception("market: チャートキャッシュの保存に失敗しました")

    def chart_path(self) -> Path | None:
        return CHART_PATH if CHART_PATH.exists() else None

    # ------------------------------------------------------------------ 入口
    async def show_market(self, interaction: discord.Interaction):
        view = MarketView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_market_embed(self.store, interaction.user.id), view=view, ephemeral=True)

    async def open_buy(self, interaction: discord.Interaction):
        await interaction.response.send_modal(TradeModal(self, "buy"))

    async def open_sell(self, interaction: discord.Interaction):
        await interaction.response.send_modal(TradeModal(self, "sell"))

    # ------------------------------------------------------------------ 売買
    def _effective_fee_rate(self, user_id: str) -> float:
        """手数料率を決める。手数料パス（core/items.py の受動効果）が
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

    def _wallet(self):
        wallet = self.bot.get_cog("WalletCog")
        if wallet is None:
            raise market_core.TradeError("コイン機能が読み込まれていません。")
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
            # 売買自体は終わっているので、履歴だけ残せなかったことを記録する（wallet.pay と同方針）。
            logger.exception("market: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                             sender_id, receiver_id, amount)

    async def execute_buy(self, user_id: int, aga_amount: int) -> str:
        uid = str(user_id)
        try:
            fee_rate = self._effective_fee_rate(uid)
            self.store.validate_buy(aga_amount, fee_rate=fee_rate)
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -aga_amount, require_funds=True)
            if debit is INSUFFICIENT:
                return market_trade_failed("コインが不足しています。")
            if debit is None:
                return market_trade_failed("コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                result = self.store.apply_buy(uid, aga_amount, fee_rate=fee_rate)
            except market_core.TradeError as exc:
                await wallet._change_balance(uid, aga_amount)
                return market_trade_failed(exc)
            await self._record_history(uid, "MARKET_POOL", aga_amount, "token_buy")
            return (
                f"✅ **{market_core.TOKEN_NAME}を買いました**\n"
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
            fee_rate = self._effective_fee_rate(uid)
            self.store.validate_sell(uid, token_amount, fee_rate=fee_rate)
            wallet = self._wallet()
            result = self.store.apply_sell(uid, token_amount, fee_rate=fee_rate)
            credit = await wallet._change_balance(uid, result["net_aga"], create_with=0)
            if credit is None or credit is INSUFFICIENT:
                self.store.rollback_sell(uid, token_amount, result)
                return market_trade_failed("コインの更新に失敗したため、売却を取り消しました。")
            await self._record_history("MARKET_POOL", uid, result["net_aga"], "token_sell")
            return (
                f"✅ **{market_core.TOKEN_NAME}を売りました**\n"
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
