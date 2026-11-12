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
from core import ads as partner_ads
from core.support.api_retry import run_with_retry

from core.game.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.rta.common import DISBOARD_BOT_ID, DISOKU_BOT_ID  # noqa: F401
from core.game.rta.detect import detect_event  # noqa: F401
from core.game.rta.helpers import _has_rich_content, _parse_dt, _rank_line, _snowflake_ts  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class EventsMixin:
    # 総合順位のカラムが DB にない（マイグレーション未適用）ことが
    # 分かったら、プロセスの間は書き込みを試行しない。
    _combined_write_disabled = False

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

        順位は「その記録が各ランキングに入る位置」= 自分より上位の
        エントリ数 + 1（SQL関数 get_bump_rta_record_ranks が best/worst
        反映後のテーブルから算出する）。順位の基準は表示ボードと同じ
        「ユーザー × サービス種類」のエントリを pooled した統合
        ランキング（p_event_type は互換のため渡すが、SQL 側では
        絞り込みに使わない）。戻り値は順位 dict（通知表示にも使う）。
        あわせて、全サービスを通したユーザー単位の「総合」順位
        （rank_all_*: 最速=全サービス中の最小、最遅=最大を1人1エントリ
        として数える）も同じ関数が返す（SQL マイグレーション適用後）。
        総合ぶんの保存は独立に試み、失敗しても通常の順位は残す。
        関数が総合順位を返さない移行前の DB では、テーブル API から
        同じ定義で算出するフォールバック（_combined_ranks_fallback）で
        表示だけでも成立させる。
        失敗は呼び出し側で握る前提で、ここでは例外をそのまま上げる。
        """
        result = await self._call(lambda: self.db.rpc("get_bump_rta_record_ranks", {
            "p_guild_id": gid, "p_event_type": kind, "p_elapsed_ms": elapsed,
        }).execute())
        rows = result.data or []
        if not rows:
            return None
        ranks = rows[0]
        if not any(key in ranks for key in (
                "rank_all_fast_local", "rank_all_fast_global",
                "rank_all_slow_local", "rank_all_slow_global")):
            fallback = await self._combined_ranks_fallback(gid, elapsed)
            if fallback is not None:
                logger.info(
                    "bump_rta combined ranks computed bot-side "
                    "(SQL migration not applied?): guild=%s", gid)
                ranks = {**ranks, **fallback}
        await self._call(lambda: self.db.table("bump_rta_events").update({
            "rank_fast_local": ranks.get("rank_fast_local"),
            "rank_fast_global": ranks.get("rank_fast_global"),
            "rank_slow_local": ranks.get("rank_slow_local"),
            "rank_slow_global": ranks.get("rank_slow_global"),
        }).eq("bump_message_id", bump_message_id).eq("event_type", kind).execute())
        combined = {
            key: ranks[key]
            for key in ("rank_all_fast_local", "rank_all_fast_global",
                        "rank_all_slow_local", "rank_all_slow_global")
            if key in ranks
        }
        if combined and not self._combined_write_disabled:
            try:
                await self._call(lambda: self.db.table("bump_rta_events").update(
                    combined).eq("bump_message_id", bump_message_id).eq(
                    "event_type", kind).execute())
            except Exception as exc:
                if "Unknown column" in str(exc):
                    # カラム追加のマイグレーション未適用。表示側は bot 側
                    # フォールバックで出るので、書き込みだけを止めて
                    # エラーを繰り返さない（再起動で再判定する）。
                    type(self)._combined_write_disabled = True
                    logger.info(
                        "bump_rta: 総合順位のカラムが DB にないため、"
                        "保存を無効化しました（表示はフォールバックで継続）")
                else:
                    # 総合順位の保存は付随情報。失敗しても通常の順位と
                    # 表示は通常どおり。
                    logger.warning(
                        "bump_rta combined ranks save failed: guild=%s", gid,
                        exc_info=True)
        return ranks

    async def _combined_ranks_fallback(self, gid, elapsed):
        """総合順位をテーブル API から算出する（移行前の DB 向け）。

        get_bump_rta_record_ranks が総合順位を返さない環境では、SQL と
        同じ定義（ユーザー単位: 最速は全サービス中の最小、最遅は最大、
        legacy は対象外）で bot 側から数える。全体順位は events を
        elapsed 順に走査し、自分より上位の間だけ数えるため、記録が
        上位ほど走査は短い。走査がページ上限に達して数え切れない
        場合は、誤った順位を表示しないため None を返す。失敗時も
        None（呼び出し側は総合なしで続行する）。
        """
        page_size = 1000
        max_pages = 50
        try:
            records = await self._call(lambda: self.db.table(
                "bump_rta_records").select("user_id,event_type,elapsed_ms").eq(
                "guild_id", gid).limit(10000).execute())
            worst = await self._call(lambda: self.db.table(
                "bump_rta_worst_records").select(
                "user_id,event_type,elapsed_ms").eq(
                "guild_id", gid).limit(10000).execute())

            def per_user(rows, pick):
                best = {}
                for row in rows or []:
                    if row.get("event_type") == "legacy":
                        continue
                    uid = str(row.get("user_id"))
                    value = int(row["elapsed_ms"])
                    best[uid] = (pick(best[uid], value)
                                 if uid in best else value)
                return best.values()

            fast_local = 1 + sum(
                1 for v in per_user(records.data, min) if v < elapsed)
            slow_local = 1 + sum(
                1 for v in per_user(worst.data, max) if v > elapsed)

            async def count_global(*, slowest):
                users = set()
                for page in range(max_pages):
                    offset = page * page_size
                    rows = await self._call(lambda: self.db.table(
                        "bump_rta_events").select(
                        "user_id,event_type,elapsed_ms").order(
                        "elapsed_ms", desc=slowest).range(
                        offset, offset + page_size - 1).execute())
                    data = rows.data or []
                    for row in data:
                        value = int(row["elapsed_ms"])
                        beyond = (value > elapsed) if slowest else (value < elapsed)
                        if not beyond:
                            # 並び順の境界（以降の行は全て対象外）
                            return 1 + len(users)
                        if row.get("event_type") != "legacy":
                            users.add(str(row.get("user_id")))
                    if len(data) < page_size:
                        return 1 + len(users)
                return None

            fast_global = await count_global(slowest=False)
            slow_global = await count_global(slowest=True)
            if fast_global is None or slow_global is None:
                return None
            return {
                "rank_all_fast_local": fast_local,
                "rank_all_fast_global": fast_global,
                "rank_all_slow_local": slow_local,
                "rank_all_slow_global": slow_global,
            }
        except Exception:
            logger.warning(
                "bump_rta combined ranks fallback failed: guild=%s", gid,
                exc_info=True)
            return None

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
            all_fast = _rank_line("総合最速", ranks.get("rank_all_fast_local"), ranks.get("rank_all_fast_global"))
            all_slow = _rank_line("総合最遅", ranks.get("rank_all_slow_local"), ranks.get("rank_all_slow_global"))
            if all_fast:
                description += f"\n{all_fast}"
            if all_slow:
                description += f"\n{all_slow}"
        embed = discord.Embed(
            title="RTA記録",
            description=description,
            color=0xFFFFFF,
        )
        # 連携広告枠（記録表示のみ。強制表示）
        try:
            ad = partner_ads.next_ad_field()
            if ad is not None:
                embed.add_field(name=ad[0], value=ad[1], inline=False)
        except Exception:
            logger.debug("広告枠の添付に失敗（記録表示は通常どおり送る）", exc_info=True)
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
