# -*- coding: utf-8 -*-
"""日報（オプトインDM）の送信と ON/OFF 切り替え。

原典の日報は特定個人への無条件DMだったため、AGO では同意モデルに
作り替えた（core/support/daily_report.py）。ユーザーが自分で ON にしたとき
だけ、JST 21:00 以降にその日の経済サマリを DM で送る。

送信チェックは毎分ループ1本だけ（既存の flush ループ群と同じ作法）。
送信対象の判定（購読中・本日未送信）はストア側が持ち、DM が閉じて
いるユーザーは静かにスキップして当日分は試行済みにする（毎分
リトライし続けない）。入口は新規スラッシュを作らず、/general の
マネージャンル（general:daily_report）とマネーパネル「その他」の
ボタンから。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core.support.daily_report import store as report_core
from cogs import general as wallet_module

logger = logging.getLogger(__name__)


class DailyReportCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 store: report_core.DailyReportStore | None = None,
                 balance_reader=None):
        self.bot = bot
        self.store = store if store is not None else report_core.DailyReportStore()
        self._balance_reader = balance_reader

    async def cog_load(self) -> None:
        if not self.send_loop.is_running():
            self.send_loop.start()

    async def cog_unload(self) -> None:
        if self.send_loop.is_running():
            self.send_loop.cancel()
        self.store.flush()

    # ------------------------------------------------------------------ 送信
    @tasks.loop(minutes=1)
    async def send_loop(self) -> None:
        try:
            await self.send_due_reports()
            self.store.maybe_flush()
        except Exception:
            logger.exception("daily_report: 送信チェックに失敗しました")

    @send_loop.before_loop
    async def _before_send_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def _collect_status(self, user_id: int) -> dict:
        """MoneyPanelCog の集約を再利用する（無ければ残高だけ）。"""
        panel = self.bot.get_cog("MoneyPanelCog")
        if panel is not None:
            try:
                return await panel.collect_status(user_id)
            except Exception:
                logger.exception(
                    "daily_report: ステータス集約に失敗 user=%s", user_id)
        return {"balance": await self._balance(str(user_id))}

    async def _balance(self, user_id: str) -> int:
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

    async def send_due_reports(self, now: datetime | None = None) -> int:
        """送信対象へ日報DMを送り、送信（試行）した人数を返す。"""
        now = now or datetime.now(config.JST)
        sent = 0
        for uid in self.store.due_users(now):
            try:
                user = self.bot.get_user(int(uid))
                if user is None:
                    user = await self.bot.fetch_user(int(uid))
            except Exception:
                user = None
            if user is None:
                # 見つからないユーザーは当日分を試行済みにして回し続けない。
                self.store.mark_sent(uid, now)
                continue
            status = await self._collect_status(int(uid))
            text = "\n".join(report_core.build_report_lines(status, now))
            try:
                await user.send(text)
            except discord.Forbidden:
                # DM が閉じられている場合は静かにスキップ（当日分は試行済み）。
                logger.info("daily_report: DM不可のためスキップ user=%s", uid)
            except Exception:
                logger.exception("daily_report: 送信に失敗 user=%s", uid)
            self.store.mark_sent(uid, now)
            sent += 1
        return sent

    # ------------------------------------------------------------------ 入口
    async def toggle(self, interaction: discord.Interaction):
        """購読の ON/OFF を切り替えて現在状態を本人にだけ返す。"""
        opted_in = self.store.toggle(str(interaction.user.id))
        if opted_in:
            message = (
                "📬 日報DMを **ON** にしました。毎晩、その日の経済サマリを"
                "DMで送ります。止めるときはもう一度押してください。")
        else:
            message = "📬 日報DMを **OFF** にしました。"
        await interaction.response.send_message(message, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(DailyReportCog(bot))
