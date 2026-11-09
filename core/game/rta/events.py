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

from core.game.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.rta.common import DISBOARD_BOT_ID, DISOKU_BOT_ID  # noqa: F401
from core.game.rta.detect import detect_event  # noqa: F401
from core.game.rta.helpers import _has_rich_content, _parse_dt, _rank_line, _snowflake_ts  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class EventsMixin:
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
        # Components V2 応答は Embed を持たないため、ゲートは detect_event と揃える
        if author_id not in (DISBOARD_BOT_ID, DISOKU_BOT_ID) and not _has_rich_content(message):
            return

        if message.id in self._processed_messages:
            return
        event = detect_event(message)
        if event is None:
            return
        kind, user_id, event_at, due_at = event
        guild_id = message.guild.id
        if not await self._is_enabled(guild_id):
            return
        self._processed_messages.add(message.id)
        lock = self._locks.setdefault((guild_id, kind), asyncio.Lock())
        async with lock:
            # Schedule in memory first: the notification must not depend on the database.
            rem, superseded = self._register_reminder(message, user_id, kind, event_at, due_at)
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


    async def _record_ranks(self, gid, kind, elapsed, bump_message_id):
        """記録時点の順位を算出して bump_rta_events の当該行へ保存する。

        順位は「その記録が各ランキングに入る位置」= 自分より上位のユーザー
        数 + 1（SQL関数 get_bump_rta_record_ranks が best/worst 反映後の
        テーブルから算出する）。戻り値は順位 dict（通知表示にも使う）。
        失敗は呼び出し側で握る前提で、ここでは例外をそのまま上げる。
        """
        result = await self._call(lambda: self.db.rpc("get_bump_rta_record_ranks", {
            "p_guild_id": gid, "p_event_type": kind, "p_elapsed_ms": elapsed,
        }).execute())
        rows = result.data or []
        if not rows:
            return None
        ranks = rows[0]
        await self._call(lambda: self.db.table("bump_rta_events").update({
            "rank_fast_local": ranks.get("rank_fast_local"),
            "rank_fast_global": ranks.get("rank_fast_global"),
            "rank_slow_local": ranks.get("rank_slow_local"),
            "rank_slow_global": ranks.get("rank_slow_global"),
        }).eq("bump_message_id", bump_message_id).eq("event_type", kind).execute())
        return ranks

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
        recorded_new = False
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
            recorded_new = True
        await self._call(lambda: self.db.rpc("record_bump_rta_best", {
            "p_guild_id": gid, "p_user_id": record_user_id, "p_event_type": kind,
            "p_elapsed_ms": elapsed, "p_completed_at": completed_at,
        }).execute())
        try:
            await self._call(lambda: self.db.rpc("record_bump_rta_worst", {
                "p_guild_id": gid, "p_user_id": record_user_id, "p_event_type": kind,
                "p_elapsed_ms": elapsed, "p_completed_at": completed_at,
            }).execute())
        except Exception:
            # 最遅記録は付随情報。SQL マイグレーション未適用などで失敗しても
            # 最速記録と pending の消化は通常どおり進める。
            logger.warning(
                "bump_rta worst record failed: guild=%s user=%s type=%s",
                gid, record_user_id, kind, exc_info=True)
        # 記録時点の順位（最速/最遅 × サーバー内/全体）も付随情報として保存する。
        # 新規に記録した実行だけが対象（再送時は記録時点の順位を保持する）。
        # 順位の保存先は実行単位の bump_rta_events 行。
        ranks = None
        if recorded_new:
            try:
                ranks = await self._record_ranks(
                    gid, kind, elapsed, start["bump_message_id"])
            except Exception:
                logger.warning(
                    "bump_rta record ranks failed: guild=%s user=%s type=%s",
                    gid, record_user_id, kind, exc_info=True)
        await self._call(lambda: self.db.table("bump_rta_pending").delete().eq("guild_id", gid).eq(
            "event_type", kind).execute())
        description = f"{kind} **{elapsed / 1000:.2f}秒**"
        if ranks:
            fast = _rank_line("最速", ranks.get("rank_fast_local"), ranks.get("rank_fast_global"))
            slow = _rank_line("最遅", ranks.get("rank_slow_local"), ranks.get("rank_slow_global"))
            if fast:
                description += f"\n{fast}"
            if slow:
                description += f"\n{slow}"
        embed = discord.Embed(
            title="RTA記録",
            description=description,
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
