import asyncio
import logging
import re
import socket
import struct
import time
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.api_retry import run_with_retry

from core.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.rta.clock import _query_ntp_offset  # noqa: F401
from core.rta.common import COOLDOWN, NTP_REFRESH_SECONDS, RECONCILE_SECONDS, STALE_SECONDS  # noqa: F401
from core.rta.helpers import _parse_dt, _snowflake_datetime  # noqa: F401
from core.rta.types import _Reminder  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class WorkerMixin:
    @tasks.loop(seconds=RECONCILE_SECONDS)
    async def reminder_worker(self):
        try:
            await self._sync_ntp_if_due()
            await self._reconcile()
            self._log_clock_if_due()
        except Exception:
            logger.exception("bump/up reminder reconcile failed")


    @reminder_worker.before_loop
    async def before_reminder_worker(self):
        await self.bot.wait_until_ready()


    async def _reconcile(self):
        """Replay persisted reminders into memory; drop stale and superseded ones."""
        if self._unmarked:
            await self._mark_sent(list(self._unmarked))
        if self.db is None:
            return
        now_ts = self.clock.now()
        cutoff = datetime.fromtimestamp(now_ts - STALE_SECONDS, tz=timezone.utc).isoformat()
        # Old unsent rows must not crowd out fresh ones (the old worker retried them every second).
        await self._call(lambda: self.db.table("bump_rta_reminders").update(
            {"sent_at": discord.utils.utcnow().isoformat()}).is_("sent_at", "null").lt(
            "due_at", cutoff).execute())
        rows = await self._call(lambda: self.db.table("bump_rta_reminders").select(
            "message_id,guild_id,channel_id,user_id,event_type,due_at"
        ).is_("sent_at", "null").order("due_at").limit(500).execute())
        candidates, expire = [], []
        for row in rows.data or []:
            mid = str(row["message_id"])
            if mid in self._done:
                continue
            try:
                kind = row["event_type"]
                due = _parse_dt(row.get("due_at")) or (_snowflake_datetime(mid) + COOLDOWN[kind])
                rem = _Reminder(
                    message_id=mid, guild_id=int(row["guild_id"]), channel_id=int(row["channel_id"]),
                    user_id=int(row["user_id"]) if row.get("user_id") else None,
                    kind=kind, due_ts=due.timestamp(),
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                logger.warning("Dropping unreadable reminder row: %s", row)
                expire.append(mid)
                continue
            if now_ts - rem.due_ts > STALE_SECONDS:
                expire.append(mid)
                continue
            candidates.append(rem)
        newest = {}
        for rem in candidates:
            key = (rem.guild_id, rem.kind)
            if key not in newest or rem.due_ts > newest[key].due_ts:
                newest[key] = rem
        for rem in candidates:
            if newest[(rem.guild_id, rem.kind)] is rem:
                self._register(rem)
            else:
                self._cancel(rem.message_id, mark_done=True)
                expire.append(rem.message_id)
        for mid in expire:
            self._done.add(mid)
        if expire:
            await self._mark_sent(expire)


    async def _sync_ntp_if_due(self):
        m = time.monotonic()
        if m < self._next_ntp or (self._ntp_task is not None and not self._ntp_task.done()):
            return
        self._next_ntp = m + NTP_REFRESH_SECONDS
        self._ntp_task = asyncio.create_task(self._refresh_ntp())


    async def _refresh_ntp(self):
        loop = asyncio.get_running_loop()
        try:
            offset, delay = await asyncio.wait_for(
                loop.run_in_executor(self._ntp_executor, _query_ntp_offset), timeout=20)
        except Exception as exc:
            level = logging.DEBUG if self._ntp_failed_logged else logging.WARNING
            self._ntp_failed_logged = True
            logger.log(level, "NTP unavailable (Discord gateway timestamps are used instead): %r", exc)
        else:
            self._ntp_failed_logged = False
            self.clock.set_ntp(offset)
            logger.info("NTP offset (true - local): %+.3fs, round trip %.3fs", offset, delay)


    def _log_clock_if_due(self):
        m = time.monotonic()
        if m < self._next_clock_log:
            return
        self._next_clock_log = m + 300
        snap = self.clock.snapshot()

        def fmt(value):
            return "n/a" if value is None else f"{value:+.3f}s"

        logger.info(
            "Clock: source=%s local-minus-Discord=%s local-minus-NTP=%s gateway_samples=%s send_lead=%.3fs",
            snap["source"], fmt(snap["local_minus_discord"]), fmt(snap["ntp_local_minus_true"]),
            snap["samples"], self._send_lead(),
        )
        if snap["local_minus_discord"] is not None and abs(snap["local_minus_discord"]) > 1.0:
            logger.warning(
                "The host clock is off by %+.3fs relative to Discord. Reminders are unaffected "
                "(they use Discord's clock) but fix the host's time sync.", snap["local_minus_discord"])
