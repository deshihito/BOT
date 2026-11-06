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
from core.game.rta.common import DISCORD_EPOCH_MS, REMINDER_ANCHOR  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


def _collect_embed_text(message):
    """Collect text from message content and all relevant Discord embed properties."""
    parts = [getattr(message, "content", "") or ""]
    for embed in getattr(message, "embeds", ()) or ():
        # Include properties that are easy to overlook when an app uses rich embeds.
        for attr in ("title", "description", "url", "type"):
            value = getattr(embed, attr, None)
            if value:
                parts.append(str(value))
        for section_name in ("author", "footer", "provider", "image", "thumbnail", "video"):
            section = getattr(embed, section_name, None)
            if section:
                for attr in ("name", "text", "url", "proxy_url"):
                    value = getattr(section, attr, None)
                    if value:
                        parts.append(str(value))
        for field in getattr(embed, "fields", ()) or ():
            parts.extend((getattr(field, "name", "") or "", getattr(field, "value", "") or ""))
    return " ".join(str(part) for part in parts if part)


def _white_embed(description=None, *, title=None):
    """Build the white embeds used by the bump/RTA feature."""
    return discord.Embed(title=title, description=description, color=0xFFFFFF)


def _snowflake_ts(snowflake_id):
    """Decode a Discord Snowflake ID into a UTC epoch timestamp (seconds, ms precision)."""
    return ((int(snowflake_id) >> 22) + DISCORD_EPOCH_MS) / 1000


def _snowflake_datetime(snowflake_id):
    """Decode a Discord Snowflake ID into its UTC creation timestamp."""
    return datetime.fromtimestamp(_snowflake_ts(snowflake_id), tz=timezone.utc)


def _parse_dt(value):
    """Parse an ISO timestamp from the database into an aware UTC datetime.

    Postgres may return 1-5 digit fractions or a bare "+00" offset, which
    ``datetime.fromisoformat`` rejects before Python 3.11.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        match = re.search(r"\.(\d+)", text)
        if match:
            text = text[:match.start()] + "." + (match.group(1) + "000000")[:6] + text[match.end():]
        if re.search(r"[+-]\d\d$", text):
            text += ":00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _interaction_id(message):
    metadata = getattr(message, "interaction_metadata", None)
    iid = getattr(metadata, "id", None)
    if iid is None:
        iid = getattr(getattr(message, "interaction", None), "id", None)
    return iid


def _event_time(message):
    """The moment the cooldown starts, as an aware UTC datetime."""
    created = _snowflake_datetime(message.id)
    if REMINDER_ANCHOR == "interaction":
        iid = _interaction_id(message)
        if iid is not None:
            return _snowflake_datetime(iid)
        return created
    if REMINDER_ANCHOR == "latest":
        # A deferred response keeps the Snowflake of its "thinking" placeholder;
        # the real result only exists from the edit onward.
        edited = getattr(message, "edited_at", None)
        if edited is not None:
            if edited.tzinfo is None:
                edited = edited.replace(tzinfo=timezone.utc)
            return max(created, edited)
    return created


def _timing_summary(message):
    """Human readable timing facts for the log (never raises)."""
    try:
        created = _snowflake_datetime(message.id)
        parts = [f"created={created.isoformat(timespec='milliseconds')}"]
        edited = getattr(message, "edited_at", None)
        if edited is not None:
            parts.append(f"edit_after={(edited - created).total_seconds():+.3f}s")
        iid = _interaction_id(message)
        if iid is not None:
            parts.append(f"response_delay={(created - _snowflake_datetime(iid)).total_seconds():+.3f}s")
        return " ".join(parts)
    except Exception:
        return "timing=unavailable"
