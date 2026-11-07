# -*- coding: utf-8 -*-
"""公開ランキングのスナップショットを1時間ごとに書き出す Cog。

Web（/ranking）は bot_kv のスナップショットを読むだけなので、
Bot が止まっていても Web 側は前回の表示（スナップショット）を出し続けられる。
書き出しに失敗しても Bot の動作は止めない（次回周期で再試行する）。
"""
from __future__ import annotations

import asyncio
import logging

from discord.ext import commands, tasks

from core.support.public_ranking import snapshot

logger = logging.getLogger(__name__)

INITIAL_DELAY_SECONDS = 120


class PublicRankingCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
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
            await snapshot.write_snapshot(self.bot)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("公開ランキングの初回スナップショット書き出しに失敗しました")

    @tasks.loop(hours=1)
    async def publish_loop(self) -> None:
        try:
            await snapshot.write_snapshot(self.bot)
        except Exception:
            logger.exception("公開ランキングのスナップショット書き出しに失敗しました")
        # Web 連携データの定期更新を兼ねる: ダッシュボードのセレクタ用に
        # guild_registry のサーバー構造スナップショットも1時間ごとに同期する。
        try:
            from core.support.guild_registry import get_registry

            await get_registry().sync_all(list(self.bot.guilds))
        except Exception:
            logger.exception("サーバー構造スナップショットの定期同期に失敗しました")

    @publish_loop.before_loop
    async def _before_publish_loop(self) -> None:
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot):
    await bot.add_cog(PublicRankingCog(bot))
