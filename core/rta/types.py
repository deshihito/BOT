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

logger = logging.getLogger("cogs.disboard_rta")


@dataclass
class _Reminder:
    message_id: str
    guild_id: int
    channel_id: int
    user_id: object
    kind: str
    due_ts: float          # Discord-clock epoch seconds
    overdue: bool = False  # already past due when picked up (e.g. after a restart)


_GONE = object()           # channel permanently unavailable
