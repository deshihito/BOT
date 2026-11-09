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
from core.support.api_retry import run_with_retry
from core.game.rta.clock import logger, _BoundedSet, DiscordClock, _NTP_EPOCH_OFFSET, _unix_to_ntp_bytes, _ntp_bytes_to_unix, _ntp_offset_and_delay, _query_ntp_once, _query_ntp_offset  # noqa: F401
from core.game.rta.common import logger, DISBOARD_BOT_ID, DISOKU_BOT_ID, SABACHA_BOT_ID, TAKASUMI_BOT_ID, DICOALL_BOT_ID, DCAFE_BOT_ID, SHARKBOT_BOT_ID, COOLDOWN, REMINDER_ANCHOR, PREP_LEAD, SEND_MARGIN, DEFAULT_SEND_LEAD, STALE_SECONDS, MAX_SEND_ATTEMPTS, PERMANENT_HTTP_STATUS, RECONCILE_SECONDS, CLOCK_WINDOW, CLOCK_MIN_SAMPLES, CLOCK_STALE_AFTER, NTP_REFRESH_SECONDS, NTP_FRESH_SECONDS, DISCORD_EPOCH_MS, ACTION_CHOICES, EVENT_TYPE_CHOICES, LEADERBOARD_SCOPE_CHOICES, ALLOWED_CHANNEL_TYPES  # noqa: F401
from core.game.rta.detect import logger, _JST, _named_field_next_time, _sabacha_next_time, detect_event  # noqa: F401
from core.game.rta.events import logger, EventsMixin  # noqa: F401
from core.game.rta.helpers import logger, _collect_embed_text, _collect_component_text, _collect_message_text, _has_rich_content, _white_embed, _snowflake_ts, _snowflake_datetime, _parse_dt, _rank_line, _interaction_id, _event_time, _timing_summary  # noqa: F401
from core.game.rta.reminder import logger, ReminderMixin  # noqa: F401
from core.game.rta.settings import logger, SettingsMixin  # noqa: F401
from core.game.rta.types import logger, _Reminder, _GONE  # noqa: F401
from core.game.rta.views import logger, BumpRtaRoleView, RtaBoardView  # noqa: F401
from core.game.rta.worker import logger, WorkerMixin  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class BumpRta(SettingsMixin, ReminderMixin, WorkerMixin, EventsMixin, commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.db = getattr(bot, "db_api", None)
        self.clock = DiscordClock()
        # Dedicated pools: other cogs (voice, recording, ...) can saturate the
        # default executor, which used to delay both the DB claim and the send.
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bumprta-db")
        self._ntp_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bumprta-ntp")
        self._enabled_cache = {}
        self._role_cache = {}
        self._locks = {}
        self._processed_messages = _BoundedSet(5000)
        self._done = _BoundedSet(5000)       # reminders finished in this process
        self._unmarked = set()               # finished but sent_at not yet written
        self._reminders = {}
        self._timers = {}
        self._lead_samples = deque(maxlen=20)  # (clock source, request->creation seconds)
        self._ntp_task = None
        self._next_ntp = 0.0
        self._next_clock_log = time.monotonic() + 60
        self._ntp_failed_logged = False

    async def cog_load(self):
        if not self.reminder_worker.is_running():
            self.reminder_worker.start()
        if self.db is None:
            logger.warning("bump/up RTA database API is not configured; durable records are disabled")

    def cog_unload(self):
        self.reminder_worker.cancel()
        for task in list(self._timers.values()):
            task.cancel()
        self._timers.clear()
        self._reminders.clear()
        if self._ntp_task is not None:
            self._ntp_task.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)
        self._ntp_executor.shutdown(wait=False, cancel_futures=True)


async def setup(bot):
    await bot.add_cog(BumpRta(bot))
