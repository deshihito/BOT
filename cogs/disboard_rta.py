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
from core.supabase_client import key_role, select_key
from core.supabase_retry import run_with_retry

logger = logging.getLogger(__name__)
DISBOARD_BOT_ID = 302050872383242240
DISOKU_BOT_ID = 761562078095867916

# Time between the service's success message and the moment the command can be
# used again.  (Dis速's /up interval may differ from Disboard's; change it here.)
COOLDOWN = {"bump": timedelta(hours=2), "up": timedelta(hours=2)}
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
]
EVENT_TYPE_CHOICES = [
    app_commands.Choice(name="bump", value="bump"),
    app_commands.Choice(name="up", value="up"),
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


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
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


def detect_event(message):
    """Return (kind, user_id, event_at) for an official successful service embed.

    The event time is the Snowflake timestamp of the message (or of its edit for
    deferred responses); see ``REMINDER_ANCHOR``.
    """
    if not getattr(message, "guild", None):
        return None
    channel_type = getattr(getattr(message, "channel", None), "type", None)
    if channel_type not in ALLOWED_CHANNEL_TYPES:
        return None
    author = getattr(message, "author", None)
    author_id = getattr(author, "id", None)
    application_id = getattr(message, "application_id", None)
    has_embeds = bool(getattr(message, "embeds", None))
    if author_id not in (DISBOARD_BOT_ID, DISOKU_BOT_ID) and not has_embeds:
        return None

    text = _collect_embed_text(message)
    folded = text.casefold()
    # Dis速-specific signature from the real response: application/webhook ID,
    # the official embed title/URL, and the server-name field ending in
    # 「をアップしたよ!」. Do not depend on message.content or /up being present.
    embeds = getattr(message, "embeds", ()) or ()
    disoku_signature = any(
        getattr(embed, "title", "") == "ディス速 | Discordサーバー・友達募集・ボット掲示板"
        and getattr(embed, "url", "") == "https://dissoku.net/ja"
        and any(
            "をアップしたよ" in (getattr(field, "name", "") or "")
            for field in (getattr(embed, "fields", ()) or ())
        )
        for embed in embeds
    )
    app_ids = {
        str(value) for value in (
            author_id,
            getattr(message, "application_id", None),
            getattr(message, "webhook_id", None),
        ) if value is not None
    }
    is_disoku = DISOKU_BOT_ID in {int(value) for value in app_ids if value.isdigit()} and disoku_signature
    is_disboard = author_id == DISBOARD_BOT_ID
    if not (is_disboard or is_disoku):
        return None


    if is_disboard:
        if "表示順をアップしたよ" not in text and "bump done" not in folded:
            return None
        kind = "bump"
    else:
        # Dis速 may describe a successful bump without including "/up" in the
        # embed text.  The brand/app check above scopes these phrases to its response.
        if not any(phrase in folded for phrase in (
            "アップしたよ", "をアップ", "アップしました", "アップ完了", "up done", "bump done"
        )):
            logger.info(
                "Disoku message ignored (no recognized success phrase): message=%s text=%r",
                getattr(message, "id", None), text[:1500],
            )
            return None
        kind = "up"

    metadata = getattr(message, "interaction_metadata", None)
    if metadata is not None and getattr(metadata, "type", None) not in (
        None, discord.InteractionType.application_command
    ):
        logger.info("Ignored non-application_command type: %s", getattr(metadata, "type", None))
        return None
    user = getattr(metadata, "user", None)
    user_id = getattr(user, "id", None)
    if user_id is None:
        legacy_interaction = getattr(message, "interaction", None)
        user_id = getattr(getattr(legacy_interaction, "user", None), "id", None)
    try:
        event_at = _event_time(message)
    except (TypeError, ValueError, OverflowError):
        logger.exception("Could not decode message Snowflake timestamp: %s", getattr(message, "id", None))
        return None
    return kind, int(user_id) if user_id is not None else None, event_at


class _BoundedSet:
    """Insertion-ordered set that forgets the oldest entries instead of clearing everything."""

    def __init__(self, limit):
        self._limit = limit
        self._items = OrderedDict()

    def add(self, item):
        self._items[item] = None
        self._items.move_to_end(item)
        while len(self._items) > self._limit:
            self._items.popitem(last=False)

    def __contains__(self, item):
        return item in self._items


# --------------------------------------------------------------------------
# Clock
# --------------------------------------------------------------------------
class DiscordClock:
    """Estimate Discord's clock (the one Snowflake IDs are stamped with).

    Every live gateway message gives ``key = monotonic - snowflake_time``.  A
    key is the true monotonic-to-Discord offset plus that message's delivery
    delay, so the sliding-window *minimum* is the offset with the smallest
    delay.  ``now() = monotonic - min_key`` is then independent of the host's
    wall clock, including steps and slews of it.  The remaining bias (the best
    delivery delay, tens of ms) cancels out in the send-lead calibration done by
    the cog, because both use the same estimate.

    Fallbacks, in order: NTP (monotonic-extrapolated), a weak gateway estimate
    with fewer than ``min_samples`` samples, and finally the system clock.
    """

    def __init__(self, *, mono=time.monotonic, wall=time.time, window=CLOCK_WINDOW,
                 min_samples=CLOCK_MIN_SAMPLES, stale_after=CLOCK_STALE_AFTER,
                 ntp_fresh=NTP_FRESH_SECONDS):
        self._mono = mono
        self._wall = wall
        self._window = window
        self._min_samples = min_samples
        self._stale_after = stale_after
        self._ntp_fresh = ntp_fresh
        self._min_deque = deque()      # (mono_time, key), keys strictly increasing
        self._recent = deque(maxlen=min_samples)
        self._ntp_true = None
        self._ntp_mono = 0.0

    def observe(self, snowflake_ts, mono_now=None):
        """Record a live gateway message (call from on_message only)."""
        m = self._mono() if mono_now is None else mono_now
        key = m - snowflake_ts
        dq = self._min_deque
        while dq and dq[-1][1] >= key:
            dq.pop()
        dq.append((m, key))
        while dq and m - dq[0][0] > self._window:
            dq.popleft()
        self._recent.append(m)

    def set_ntp(self, offset_seconds):
        """``offset_seconds`` is true UTC minus the local wall clock."""
        self._ntp_true = self._wall() + offset_seconds
        self._ntp_mono = self._mono()

    def _source_at(self, m):
        if self._min_deque:
            fresh = m - self._recent[-1] <= self._stale_after
            if (fresh and len(self._recent) >= self._min_samples
                    and m - self._recent[0] <= self._window):
                return "gateway"
        if self._ntp_true is not None and m - self._ntp_mono <= self._ntp_fresh:
            return "ntp"
        if self._min_deque and m - self._recent[-1] <= self._stale_after:
            return "gateway-weak"
        return "system"

    def _estimate(self, source, m):
        if source in ("gateway", "gateway-weak"):
            return m - self._min_deque[0][1]
        if source == "ntp":
            return self._ntp_true + (m - self._ntp_mono)
        return self._wall()

    def source(self):
        return self._source_at(self._mono())

    def now(self):
        m = self._mono()
        return self._estimate(self._source_at(m), m)

    def now_and_source(self):
        m = self._mono()
        source = self._source_at(m)
        return self._estimate(source, m), source

    def snapshot(self):
        m = self._mono()
        source = self._source_at(m)
        estimate = self._estimate(source, m)
        ntp_diff = None
        if self._ntp_true is not None:
            ntp_diff = self._wall() - (self._ntp_true + (m - self._ntp_mono))
        return {
            "source": source,
            "local_minus_discord": None if source == "system" else self._wall() - estimate,
            "ntp_local_minus_true": ntp_diff,
            "samples": len(self._recent),
        }


# --------------------------------------------------------------------------
# NTP (fallback only)
# --------------------------------------------------------------------------
_NTP_EPOCH_OFFSET = 2208988800


def _unix_to_ntp_bytes(ts):
    ts += _NTP_EPOCH_OFFSET
    seconds = int(ts)
    return struct.pack("!II", seconds, int((ts - seconds) * 2**32))


def _ntp_bytes_to_unix(raw):
    seconds, fraction = struct.unpack("!II", raw)
    return seconds - _NTP_EPOCH_OFFSET + fraction / 2**32


def _ntp_offset_and_delay(t1, t2, t3, t4):
    """Standard four-timestamp NTP maths; offset is server minus local."""
    return ((t2 - t1) + (t3 - t4)) / 2, (t4 - t1) - (t3 - t2)


def _query_ntp_once(addr, timeout):
    """One validated NTP exchange against an already resolved address -> (offset, delay)."""
    request = bytearray(48)
    request[0] = 0x23  # LI 0, version 4, mode 3 (client)
    deadline = time.monotonic() + timeout
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        t1 = time.time()
        request[40:48] = _unix_to_ntp_bytes(t1)
        sock.sendto(bytes(request), addr)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("NTP response timed out")
            sock.settimeout(remaining)
            response, source = sock.recvfrom(512)
            t4 = time.time()
            if source[0] == addr[0] and len(response) >= 48 and response[24:32] == bytes(request[40:48]):
                break
    leap, mode, stratum = response[0] >> 6, response[0] & 7, response[1]
    if mode != 4 or leap == 3 or not 1 <= stratum <= 15:
        raise ValueError(f"unusable NTP reply (leap={leap} mode={mode} stratum={stratum})")
    t2 = _ntp_bytes_to_unix(response[32:40])
    t3 = _ntp_bytes_to_unix(response[40:48])
    if t3 <= 0:
        raise ValueError("NTP reply without transmit timestamp")
    return _ntp_offset_and_delay(t1, t2, t3, t4)


def _query_ntp_offset():
    """Return (offset, delay): true UTC minus local clock, from the best of a few samples.

    DNS is resolved outside the measured window; the old implementation timed it
    as part of the round trip and skewed the result.
    """
    errors = []
    for host in ("time.google.com", "pool.ntp.org", "time.cloudflare.com"):
        try:
            addr = socket.getaddrinfo(host, 123, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
            best = None
            last_error = None
            for _ in range(3):
                try:
                    sample = _query_ntp_once(addr, 1.0)
                except Exception as exc:
                    last_error = exc
                    continue
                if best is None or sample[1] < best[1]:
                    best = sample
                time.sleep(0.05)
            if best is None:
                raise last_error or OSError("no sample")
            if best[1] > 1.0:
                raise ValueError(f"round trip too slow ({best[1]:.3f}s)")
            return best
        except Exception as exc:
            errors.append(f"{host}: {exc!r}")
    raise OSError("NTP sync failed: " + "; ".join(errors))


# --------------------------------------------------------------------------
# Cog
# --------------------------------------------------------------------------
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


class BumpRta(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.db = getattr(bot, "supabase", None)
        self.clock = DiscordClock()
        # Dedicated pools: other cogs (voice, recording, ...) can saturate the
        # default executor, which used to delay both the DB claim and the send.
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bumprta-db")
        self._ntp_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bumprta-ntp")
        self._enabled_cache = {}
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

    # ---- lifecycle -------------------------------------------------------
    async def cog_load(self):
        if not self.reminder_worker.is_running():
            self.reminder_worker.start()
        key, source = select_key()
        role = key_role(key) if key else "not-set"
        if self.db is not None and role not in {"anon", "service_role"}:
            logger.warning(
                "bump/up RTA RPC requires an anon/service_role key and matching SQL grant; source=%s role=%s",
                source or "not-set", role,
            )

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

    async def _call(self, fn):
        return await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: run_with_retry(fn)
        )

    async def _is_enabled(self, guild_id):
        gid = str(guild_id)
        if gid in self._enabled_cache:
            return self._enabled_cache[gid]
        if self.db is None:
            return True
        try:
            result = await self._call(lambda: self.db.table("bump_rta_settings").select(
                "notifications_enabled").eq("guild_id", gid).limit(1).execute())
            enabled = bool(result.data[0]["notifications_enabled"]) if result.data else True
            self._enabled_cache[gid] = enabled
            return enabled
        except Exception:
            logger.exception("bump_rta_settings read failed; using default enabled state: guild=%s", gid)
            return True

    async def leaderboard(self, interaction: discord.Interaction, event_type: str = "bump", scope: str = "local"):
        """/leaderboard から呼び出す bump/up RTA ランキング。"""
        if self.db is None:
            return await interaction.followup.send(
                embed=_white_embed("Supabase未接続のため順位を取得できません。"), ephemeral=True)
        try:
            if scope == "me":
                uid, gid = str(interaction.user.id), str(interaction.guild_id)
                local = await self._call(lambda: self.db.table("bump_rta_records").select(
                    "elapsed_ms,completed_at").eq("guild_id", gid).eq("user_id", uid).eq("event_type", event_type).limit(1).execute())
                global_best = await self._call(lambda: self.db.table("bump_rta_events").select(
                    "elapsed_ms,completed_at").eq("user_id", uid).eq("event_type", event_type).order("elapsed_ms").limit(1).execute())
                local_text = f"{local.data[0]['elapsed_ms'] / 1000:.2f}秒" if local.data else "記録なし"
                global_text = f"{global_best.data[0]['elapsed_ms'] / 1000:.2f}秒" if global_best.data else "記録なし"
                return await interaction.followup.send(embed=_white_embed(
                    f"<@{uid}> の**{event_type}自己ベスト**\nこのサーバー: **{local_text}**\n全サーバー: **{global_text}**"))
            if scope == "global":
                rows = await self._call(lambda: self.db.rpc("get_bump_rta_global_ranking", {
                    "p_event_type": event_type, "p_limit": 10}).execute())
                data = rows.data or []
                lines = [f"**{i}.** <@{r['user_id']}> — **{r['elapsed_ms'] / 1000:.2f}秒**（{r['attempts']}回）" for i, r in enumerate(data, 1)]
                title = f"全サーバー {event_type} RTAランキング"
            else:
                rows = await self._call(lambda: self.db.table("bump_rta_records").select(
                    "user_id,elapsed_ms,completed_at").eq("guild_id", str(interaction.guild_id)).eq(
                    "event_type", event_type).order("elapsed_ms").limit(10).execute())
                data = rows.data or []
                lines = [f"**{i}.** <@{r['user_id']}> — **{r['elapsed_ms'] / 1000:.2f}秒**" for i, r in enumerate(data, 1)]
                title = f"このサーバー {event_type} RTAランキング"
            return await interaction.followup.send(
                embed=_white_embed(f"**{title}**\n" + ("\n".join(lines) if lines else "まだ記録がありません。")))
        except Exception as e:
            logger.exception("bump/up leaderboard query failed: scope=%s kind=%s", scope, event_type)
            return await interaction.followup.send(
                embed=_white_embed(f"ランキングの取得に失敗しました。\n（{type(e).__name__}: {e}）"))

    # ---- slash command ---------------------------------------------------
    async def bumprta_command(
        self,
        interaction: discord.Interaction,
        action: app_commands.Choice[str],
    ):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                embed=_white_embed("このコマンドはサーバー内でのみ使えます。"), ephemeral=True)
        selected_action = action.value
        if selected_action == "status":
            enabled = await self._is_enabled(interaction.guild_id)
            return await interaction.response.send_message(
                embed=_white_embed(
                    f"bump/up通知とRTA計測: **{'オン' if enabled else 'オフ'}**（初期状態: オン）"),
                ephemeral=True)
        if selected_action in {"on", "off"}:
            if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
                return await interaction.response.send_message(
                    embed=_white_embed("この操作にはサーバー管理権限が必要です。"), ephemeral=True)
            enabled = selected_action == "on"
            gid = str(interaction.guild_id)
            await interaction.response.defer(ephemeral=True)
            if self.db is not None:
                try:
                    await self._call(lambda: self.db.table("bump_rta_settings").upsert(
                        {"guild_id": gid, "notifications_enabled": enabled}, on_conflict="guild_id").execute())
                    if not enabled:
                        await self._call(lambda: self.db.table("bump_rta_reminders").update(
                            {"sent_at": discord.utils.utcnow().isoformat()}).eq("guild_id", gid).is_(
                            "sent_at", "null").execute())
                        await self._call(lambda: self.db.table("bump_rta_pending").delete().eq(
                            "guild_id", gid).execute())
                except Exception:
                    logger.exception("bump_rta settings update failed: guild=%s", gid)
                    return await interaction.followup.send(
                        embed=_white_embed("設定の保存に失敗しました。時間をおいて再度お試しください。"),
                        ephemeral=True)
            self._enabled_cache[gid] = enabled
            if not enabled:
                self._cancel_guild(interaction.guild_id)
            return await interaction.followup.send(
                embed=_white_embed(
                    f"bump/up通知とRTA計測を **{'オン' if enabled else 'オフ'}** にしました。"),
                ephemeral=True)
        return await interaction.response.send_message(
            embed=_white_embed("ランキングは `/leaderboard` から確認してください。"), ephemeral=True)

    # ---- send-lead calibration -------------------------------------------
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

    # ---- reminder registry -----------------------------------------------
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

    def _register_reminder(self, message, user_id, kind, event_at):
        """In-memory part of scheduling.  Cannot fail because of the database."""
        rem = _Reminder(
            message_id=str(message.id), guild_id=message.guild.id, channel_id=message.channel.id,
            user_id=int(user_id) if user_id else None, kind=kind,
            due_ts=(event_at + COOLDOWN[kind]).timestamp(),
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

    # ---- per-reminder task ------------------------------------------------
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
            channel, embed, reference = prepared
            await self._sleep_until(lambda: self._fire_target(rem))
            await self._fire(rem, channel, embed, reference)
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
        noun = "bump" if rem.kind == "bump" else "up"
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
        return channel, embed, reference

    async def _fire(self, rem, channel, embed, reference):
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
                        allowed_mentions=discord.AllowedMentions.none(),
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

    # ---- reconciliation (restart recovery) ---------------------------------
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

    # ---- clocks -------------------------------------------------------------
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

    # ---- message handling ----------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        try:
            self.clock.observe(_snowflake_ts(message.id))
        except Exception:
            logger.debug("clock sample skipped", exc_info=True)
        await self._handle_message(message)

    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message):
        # Deferred application responses are created empty and filled in by an edit.
        await self._handle_message(after)

    async def _handle_message(self, message):
        author_id = getattr(getattr(message, "author", None), "id", None)
        if author_id not in (DISBOARD_BOT_ID, DISOKU_BOT_ID) and not getattr(message, "embeds", None):
            return

        if message.id in self._processed_messages:
            return
        event = detect_event(message)
        if event is None:
            return
        kind, user_id, event_at = event
        guild_id = message.guild.id
        if not await self._is_enabled(guild_id):
            return
        self._processed_messages.add(message.id)
        lock = self._locks.setdefault((guild_id, kind), asyncio.Lock())
        async with lock:
            # Schedule in memory first: the notification must not depend on the database.
            rem, superseded = self._register_reminder(message, user_id, kind, event_at)
            if self.db is None:
                return
            try:
                await self._record_rta_event(message, kind, user_id, event_at)
            except Exception:
                logger.exception("Failed to record %s RTA event: guild=%s message=%s", kind, guild_id, message.id)
            try:
                await self._persist_reminder(rem, superseded)
            except Exception:
                logger.exception("Failed to save %s reminder: guild=%s message=%s", kind, guild_id, message.id)
            try:
                await self._start_rta_timer(rem)
            except Exception:
                logger.exception("Failed to start %s RTA timer: guild=%s message=%s", kind, guild_id, message.id)

    async def _record_rta_event(self, message, kind, user_id, event_at):
        gid = str(message.guild.id)
        pending = await self._call(lambda: self.db.table("bump_rta_pending").select(
            "user_id,bump_message_id,bump_at").eq("guild_id", gid).eq("event_type", kind).limit(1).execute())
        if not pending.data:
            logger.info(
                "RTA completion detected but no pending start marker: kind=%s guild=%s message=%s user=%s",
                kind, gid, getattr(message, "id", None), user_id,
            )
            return
        start = pending.data[0]
        # Interaction metadata is not exposed on every application response.
        # Prefer the user on the completion event, then fall back to the user who
        # triggered the pending RTA cycle.
        record_user_id = str(user_id or start.get("user_id") or "")
        if not record_user_id:
            logger.warning(
                "Cannot attribute %s RTA completion: guild=%s message=%s "
                "completion_user=%r pending_user=%r",
                kind, gid, getattr(message, "id", None), user_id, start.get("user_id"),
            )
            return
        start_time = _parse_dt(start.get("bump_at"))
        if start_time is None:
            logger.warning("Unreadable RTA start time %r; discarding marker: guild=%s", start.get("bump_at"), gid)
            await self._call(lambda: self.db.table("bump_rta_pending").delete().eq("guild_id", gid).eq(
                "event_type", kind).execute())
            return
        delta = (event_at - start_time).total_seconds()
        if delta < 0:
            # Completing before the timer started is not a valid run.  It also means
            # the cooldown anchor is later than the service's real cooldown end.
            logger.warning(
                "%s completion arrived %.3fs BEFORE the due time (guild=%s message=%s); not recorded. "
                "If this repeats, the cooldown anchor is late: see REMINDER_ANCHOR.",
                kind, -delta, gid, message.id)
            return
        existing = await self._call(lambda: self.db.table("bump_rta_events").select(
            "elapsed_ms,completed_at").eq("bump_message_id", start["bump_message_id"]).eq(
            "event_type", kind).limit(1).execute())
        if existing.data:
            elapsed = int(existing.data[0]["elapsed_ms"])
            completed_at = existing.data[0]["completed_at"]
        else:
            elapsed = max(1, int(delta * 1000))
            completed_at = event_at.isoformat()
            await self._call(lambda: self.db.table("bump_rta_events").insert({
                "guild_id": gid, "user_id": record_user_id, "event_type": kind,
                "elapsed_ms": elapsed, "bump_message_id": start["bump_message_id"],
                "completed_at": completed_at,
            }).execute())
        await self._call(lambda: self.db.rpc("record_bump_rta_best", {
            "p_guild_id": gid, "p_user_id": record_user_id, "p_event_type": kind,
            "p_elapsed_ms": elapsed, "p_completed_at": completed_at,
        }).execute())
        await self._call(lambda: self.db.table("bump_rta_pending").delete().eq("guild_id", gid).eq(
            "event_type", kind).execute())
        embed = discord.Embed(
            title="RTA記録",
            description=f"{kind} **{elapsed / 1000:.2f}秒**",
            color=0xFFFFFF,
        )
        try:
            await self._send_timed(
                message.channel,
                embed=embed,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception:
            logger.exception(
                "Failed to send RTA result embed: guild=%s kind=%s message=%s elapsed_ms=%s",
                gid, kind, getattr(message, "id", None), elapsed,
            )


async def setup(bot):
    await bot.add_cog(BumpRta(bot))
