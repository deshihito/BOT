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

from core.game.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.rta.common import COOLDOWN, DEFAULT_SEND_LEAD, MAX_SEND_ATTEMPTS, PERMANENT_HTTP_STATUS, PREP_LEAD, SEND_MARGIN, STALE_SECONDS  # noqa: F401
from core.game.rta.helpers import _timing_summary  # noqa: F401
from core.game.rta.types import _GONE, _Reminder  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class ReminderMixin:
    def _send_lead(self):
        """Seconds between starting a request and Discord stamping the message."""
        source = self.clock.source()
        values = [tau for src, tau in self._lead_samples if src == source][-5:]
        if not values:
            return DEFAULT_SEND_LEAD
        return max(-30.0, min(30.0, median(values)))


    def _observe_send(self, source, started, message):
        try:
            tau = message.created_at.timestamp() - started
        except Exception:
            return
        if abs(tau) <= 60:
            self._lead_samples.append((source, tau))


    async def _send_timed(self, channel, **kwargs):
        started, source = self.clock.now_and_source()
        sent = await channel.send(**kwargs)
        self._observe_send(source, started, sent)
        return sent


    def _register(self, rem):
        mid = rem.message_id
        if mid in self._timers or mid in self._done:
            return False
        self._reminders[mid] = rem
        self._timers[mid] = asyncio.get_running_loop().create_task(
            self._run_reminder(rem), name=f"bumprta-{mid}")
        return True


    def _cancel(self, mid, *, mark_done=False):
        if mark_done:
            self._done.add(mid)
        task = self._timers.pop(mid, None)
        self._reminders.pop(mid, None)
        if task is not None and not task.done():
            task.cancel()


    def _cancel_guild(self, guild_id):
        for rem in list(self._reminders.values()):
            if rem.guild_id == guild_id:
                self._cancel(rem.message_id)


    def _register_reminder(self, message, user_id, kind, event_at, due_at=None):
        """In-memory part of scheduling.  Cannot fail because of the database."""
        rem = _Reminder(
            message_id=str(message.id), guild_id=message.guild.id, channel_id=message.channel.id,
            user_id=int(user_id) if user_id else None, kind=kind,
            due_ts=(due_at or (event_at + COOLDOWN[kind])).timestamp(),
        )
        superseded = []
        for other in list(self._reminders.values()):
            if other.guild_id == rem.guild_id and other.kind == kind and other.message_id != rem.message_id:
                superseded.append(other.message_id)
                self._cancel(other.message_id, mark_done=True)
        self._register(rem)
        logger.info(
            "Reminder scheduled: kind=%s guild=%s message=%s due=%s %s clock=%s",
            kind, rem.guild_id, rem.message_id,
            datetime.fromtimestamp(rem.due_ts, tz=timezone.utc).isoformat(timespec="milliseconds"),
            _timing_summary(message), self.clock.source(),
        )
        return rem, superseded


    async def _persist_reminder(self, rem, superseded):
        if self.db is None:
            return
        row = {
            "message_id": rem.message_id, "guild_id": str(rem.guild_id),
            "channel_id": str(rem.channel_id), "user_id": str(rem.user_id) if rem.user_id else None,
            "event_type": rem.kind,
            "due_at": datetime.fromtimestamp(rem.due_ts, tz=timezone.utc).isoformat(),
        }
        await self._call(lambda: self.db.table("bump_rta_reminders").upsert(
            row, on_conflict="message_id", ignore_duplicates=True).execute())
        if superseded:
            await self._mark_sent(superseded)


    async def _start_rta_timer(self, rem):
        """Create the RTA start marker when the cycle is scheduled, not when the
        notification is sent: a fast player can otherwise complete the next
        bump before the marker exists, losing the record and leaving a stale marker."""
        if self.db is None:
            return
        pending = {
            "guild_id": str(rem.guild_id), "event_type": rem.kind,
            "user_id": str(rem.user_id) if rem.user_id else None,
            "bump_message_id": rem.message_id,
            "bump_at": datetime.fromtimestamp(rem.due_ts, tz=timezone.utc).isoformat(),
        }
        await self._call(lambda: self.db.table("bump_rta_pending").upsert(
            pending, on_conflict="guild_id,event_type").execute())


    async def _mark_sent(self, message_ids):
        ids = [str(mid) for mid in message_ids]
        if not ids or self.db is None:
            return
        try:
            await self._call(lambda: self.db.table("bump_rta_reminders").update(
                {"sent_at": discord.utils.utcnow().isoformat()}
            ).in_("message_id", ids).is_("sent_at", "null").execute())
            self._unmarked.difference_update(ids)
        except Exception:
            logger.exception("Could not mark reminders as sent (will retry): %s", ids[:5])
            self._unmarked.update(ids)


    async def _sleep_until(self, target_fn):
        """Sleep until ``target_fn()`` (Discord-clock seconds) with millisecond accuracy."""
        while True:
            remaining = target_fn() - self.clock.now()
            if remaining <= 0:
                return
            if remaining > 1.0:
                await asyncio.sleep(min(remaining - 0.5, 30.0))   # re-evaluate: clock estimate may move
            elif remaining > 0.06:
                await asyncio.sleep(remaining - 0.05)             # stay clear of timer granularity
            else:
                await asyncio.sleep(0)                            # yield-spin the last ~50 ms


    def _fire_target(self, rem):
        return rem.due_ts - self._send_lead() + SEND_MARGIN


    async def _run_reminder(self, rem):
        mid = rem.message_id
        try:
            rem.overdue = self.clock.now() > rem.due_ts
            await self._sleep_until(lambda: rem.due_ts - PREP_LEAD - self._send_lead())
            prepared = await self._prepare(rem)
            if prepared is None:
                return
            channel, embed, reference, role_id = prepared
            await self._sleep_until(lambda: self._fire_target(rem))
            await self._fire(rem, channel, embed, reference, role_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Not marked done: the reconciler re-registers it from the database.
            logger.exception("bump/up reminder task failed: message=%s", mid)
        finally:
            self._timers.pop(mid, None)
            self._reminders.pop(mid, None)


    async def _resolve_channel(self, channel_id):
        channel = self.bot.get_channel(channel_id)
        if channel is not None:
            return channel
        try:
            return await self.bot.fetch_channel(channel_id)
        except (discord.NotFound, discord.Forbidden):
            return _GONE
        except discord.HTTPException:
            return None


    async def _finish(self, rem, reason, level=logging.INFO):
        self._done.add(rem.message_id)
        logger.log(level, "Reminder finished without a send: message=%s kind=%s reason=%s",
                   rem.message_id, rem.kind, reason)
        await self._mark_sent([rem.message_id])


    async def _prepare(self, rem):
        """Do all I/O that is allowed to be slow, ahead of the due time."""
        if not await self._is_enabled(rem.guild_id):
            await self._finish(rem, "notifications disabled")
            return None
        if self.clock.now() - rem.due_ts > STALE_SECONDS:
            await self._finish(rem, "stale", logging.WARNING)
            return None
        channel = await self._resolve_channel(rem.channel_id)
        if channel is _GONE:
            await self._finish(rem, "channel unavailable", logging.WARNING)
            return None
        role_id = await self._role_id(rem.guild_id)
        noun = rem.kind if rem.kind in ("bump", "vote") else "up"
        # Keep the reminder wording exactly aligned with the supplied original.
        embed = discord.Embed(
            title=f"{noun.upper()} できます",
            description=f"{noun}が可能になりました!",
            color=0xFFFFFF,
            timestamp=datetime.fromtimestamp(rem.due_ts, tz=timezone.utc),
        )
        embed.set_footer(text="RTA計測を開始しました")
        # Build the reply reference from IDs; fetching the source message would add
        # a round trip exactly when the reminder is due.
        reference = discord.MessageReference(
            message_id=int(rem.message_id), channel_id=rem.channel_id,
            guild_id=rem.guild_id, fail_if_not_exists=False,
        )
        return channel, embed, reference, role_id


    async def _fire(self, rem, channel, embed, reference, role_id=None):
        mid = rem.message_id
        if mid in self._done:
            return
        if not self._enabled_cache.get(str(rem.guild_id), True):
            await self._finish(rem, "notifications disabled before send")
            return
        start_delay = self.clock.now() - self._fire_target(rem)
        lead = self._send_lead()
        source = self.clock.source()
        if start_delay > 0.25 and not rem.overdue:
            logger.warning(
                "Reminder send started %.3fs late (event loop or GIL was busy): message=%s",
                start_delay, mid)
        for attempt in range(1, MAX_SEND_ATTEMPTS + 1):
            if channel is None:
                channel = await self._resolve_channel(rem.channel_id)
                if channel is _GONE:
                    await self._finish(rem, "channel unavailable", logging.WARNING)
                    return
            if channel is not None:
                try:
                    sent = await self._send_timed(
                        channel, embed=embed, reference=reference, mention_author=False,
                        content=f"<@&{role_id}>" if role_id else None,
                        allowed_mentions=(
                            discord.AllowedMentions(roles=[discord.Object(id=role_id)])
                            if role_id else discord.AllowedMentions.none()
                        ),
                    )
                except discord.HTTPException as exc:
                    if exc.status in PERMANENT_HTTP_STATUS:
                        await self._finish(rem, f"send rejected (HTTP {exc.status})", logging.WARNING)
                        return
                    logger.warning("Reminder send failed (attempt %s/%s): message=%s error=%s",
                                   attempt, MAX_SEND_ATTEMPTS, mid, exc)
                except Exception:
                    logger.exception("Reminder send crashed (attempt %s/%s): message=%s",
                                     attempt, MAX_SEND_ATTEMPTS, mid)
                else:
                    self._done.add(mid)
                    logger.info(
                        "Reminder sent: message=%s kind=%s lag=%+.3fs start_delay=%+.3fs "
                        "lead=%.3fs clock=%s attempt=%s",
                        mid, rem.kind, sent.created_at.timestamp() - rem.due_ts,
                        start_delay, lead, source, attempt,
                    )
                    await self._mark_sent([mid])
                    return
            if attempt < MAX_SEND_ATTEMPTS:
                await asyncio.sleep(2 ** attempt)
        await self._finish(rem, "gave up after retries", logging.WARNING)
