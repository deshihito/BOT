# -*- coding: utf-8 -*-
"""サービスステータスのスナップショットを5分ごとに書き出す Cog。

Web（/status）は bot_kv のスナップショットを読むだけなので、
Bot が止まればスナップショットが古くなり、Web 側はその鮮度から
「停止・再起動中の疑い」を表示できる。
書き出しに失敗しても Bot の動作は止めない（次回周期で再試行する）。
"""
from __future__ import annotations

import asyncio
import datetime
import logging

from discord.ext import commands, tasks

from core.support.bot_status import snapshot

logger = logging.getLogger(__name__)

INITIAL_DELAY_SECONDS = 60


class BotStatusCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # Cog の読み込み≒Bot の起動として稼働時間の起点にする。
        self.started_at = datetime.datetime.now(datetime.timezone.utc)
        self._initial_task: asyncio.Task | None = None

    async def cog_load(self) -> None:
        self.publish_loop.start()
        self._initial_task = asyncio.create_task(self._publish_initial())

    def cog_unload(self) -> None:
        self.publish_loop.cancel()
        if self._initial_task is not None:
            self._initial_task.cancel()

    async def _publish_initial(self) -> None:
        """起動直後は on_ready を待ってから1回書き出す（周期ループの初回を待たない）。"""
        try:
            await asyncio.sleep(INITIAL_DELAY_SECONDS)
            await self.bot.wait_until_ready()
            await snapshot.write_snapshot(self.bot, started_at=self.started_at)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("サービスステータスの初回スナップショット書き出しに失敗しました")

    @tasks.loop(minutes=5)
    async def publish_loop(self) -> None:
        try:
            await snapshot.write_snapshot(self.bot, started_at=self.started_at)
        except Exception:
            logger.exception("サービスステータスのスナップショット書き出しに失敗しました")

    @publish_loop.before_loop
    async def _before_publish_loop(self) -> None:
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot):
    await bot.add_cog(BotStatusCog(bot))
