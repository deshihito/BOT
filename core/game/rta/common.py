"""Default-on Disboard bump / Dis速 up reminders and separate RTA leaderboards.

Timing design
-------------
* Reminders are scheduled in memory (one asyncio task per reminder) instead of
  being discovered by polling the database every second.  The database is only
  the durable copy that is replayed after a restart (see ``_reconcile``).
* Everything needed for the send (enabled flag, channel, embed, reply
  reference) is resolved *before* the due time, so the time-critical part is a
  single ``channel.send`` with no database round trip in front of it.
* "Now" is Discord's clock, not the host clock.  Due times are Snowflake
  based, so ``DiscordClock`` derives the current Discord time from the
  Snowflake timestamps of live gateway messages plus ``time.monotonic()``.  A
  host clock that is seconds off (Raspberry Pi without RTC, late NTP step,
  VM resume) therefore cannot shift a reminder.  NTP is only a fallback.
* The measured delay between starting a request and Discord stamping the new
  message is fed back into the schedule, so the message is created at the due
  time instead of one request-latency after it.
"""
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

logger = logging.getLogger("cogs.disboard_rta")
DISBOARD_BOT_ID = 302050872383242240
DISOKU_BOT_ID = 761562078095867916
SABACHA_BOT_ID = 1233072112139501608   # 鯖ちゃんねる (discord.sabach.jp)
TAKASUMI_BOT_ID = 981314695543783484   # TakasumiBOT

# Time between the service's success message and the moment the command can be
# used again.  (Dis速's /up interval may differ from Disboard's; change it here.)
COOLDOWN = {
    "bump": timedelta(hours=2),
    "up": timedelta(hours=2),
    "vote": timedelta(hours=2),       # 鯖ちゃんねる /vote (次回時刻が埋め込みにあればそちら優先)
    "takasumi": timedelta(hours=1),   # TakasumiBOT up (応答本文「1時間後に通知します」)
}
# Which timestamp the cooldown is counted from:
#   "latest"      - message Snowflake, or the edit time if the service answered
#                   with a deferred response and edited it afterwards (default)
#   "message"     - message Snowflake only
#   "interaction" - the moment the user ran the command
REMINDER_ANCHOR = "latest"
PREP_LEAD = 15.0               # seconds before the send to resolve channel/embed
SEND_MARGIN = 0.03             # aim to be created this long *after* the due time
DEFAULT_SEND_LEAD = 0.15       # initial request->creation latency estimate
STALE_SECONDS = 6 * 3600       # reminders overdue by more than this are dropped
MAX_SEND_ATTEMPTS = 3
PERMANENT_HTTP_STATUS = {400, 401, 403, 404}
RECONCILE_SECONDS = 30
CLOCK_WINDOW = 600.0           # seconds of gateway samples used for the minimum
CLOCK_MIN_SAMPLES = 5
CLOCK_STALE_AFTER = 1800.0
NTP_REFRESH_SECONDS = 300.0
NTP_FRESH_SECONDS = 900.0
DISCORD_EPOCH_MS = 1420070400000

ACTION_CHOICES = [
    app_commands.Choice(name="状態", value="status"),
    app_commands.Choice(name="通知オン", value="on"),
    app_commands.Choice(name="通知オフ", value="off"),
    app_commands.Choice(name="メンションロール設定", value="role"),
]
EVENT_TYPE_CHOICES = [
    app_commands.Choice(name="bump", value="bump"),
    app_commands.Choice(name="up", value="up"),
    app_commands.Choice(name="vote", value="vote"),
    app_commands.Choice(name="takasumi", value="takasumi"),
]
LEADERBOARD_SCOPE_CHOICES = [
    app_commands.Choice(name="自分のベスト", value="me"),
    app_commands.Choice(name="このサーバー", value="local"),
    app_commands.Choice(name="全サーバー", value="global"),
]
ALLOWED_CHANNEL_TYPES = {
    discord.ChannelType.text,
    discord.ChannelType.news,
    discord.ChannelType.public_thread,
    discord.ChannelType.private_thread,
    discord.ChannelType.news_thread,
}
