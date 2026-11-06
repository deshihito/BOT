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
from core.game.rta.common import CLOCK_MIN_SAMPLES, CLOCK_STALE_AFTER, CLOCK_WINDOW, NTP_FRESH_SECONDS  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


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
