# -*- coding: utf-8 -*-
"""サービスステータス（Web /status）用のスナップショット生成。

Bot の稼働情報（導入サーバー数・メンバー数・応答速度・起動時刻）を
bot_kv の namespace ``bot_status``（key ``snapshot``）へ書き出す。
Web は Bot API 経由でこれを読むだけ（公開ランキングと同じ方式）。

プライバシー境界:
- サーバーID・サーバー名・ユーザーID は含めない（含めるのは件数だけ）。
- Web 側は updated_at の鮮度で「稼働中／停止・再起動中の疑い」を判定する。
"""
from __future__ import annotations

import datetime
import logging
import math
from typing import Any, Optional

from core.support.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "bot_status"
SNAPSHOT_KEY = "snapshot"
HISTORY_KEY = "history"

JST = datetime.timezone(datetime.timedelta(hours=9))
# スナップショットは5分ごとに書かれるため、1日分は最大 288 サンプル。
SAMPLES_PER_DAY = 24 * 12
HISTORY_DAYS = 30
CMD_HOURS_KEEP = 48


def _as_count(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def build_snapshot(
    *,
    guild_count: Any,
    member_count: Any,
    latency_ms: Any,
    started_at: Optional[datetime.datetime],
    now: Optional[datetime.datetime] = None,
) -> dict[str, Any]:
    """表示用の値だけからステータススナップショットを作る（純粋関数）。"""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return {
        "updated_at": now.isoformat(),
        "started_at": started_at.isoformat() if started_at is not None else None,
        "guild_count": _as_count(guild_count),
        "member_count": _as_count(member_count),
        "latency_ms": _as_count(latency_ms) if latency_ms is not None else None,
    }


def collect_snapshot(
    bot: Any,
    *,
    started_at: Optional[datetime.datetime] = None,
    now: Optional[datetime.datetime] = None,
) -> dict[str, Any]:
    """Bot の実データからステータススナップショットを作る。

    member_count は各サーバーのメンバー数（Discord が返す概数）の合計で、
    Bot アカウント分も含む。latency は WebSocket の応答時間（秒→ミリ秒）。
    """
    guilds = list(getattr(bot, "guilds", None) or [])
    member_count = sum(_as_count(getattr(guild, "member_count", 0)) for guild in guilds)
    latency = getattr(bot, "latency", None)
    latency_ms: Optional[int] = None
    if isinstance(latency, (int, float)) and math.isfinite(latency) and latency >= 0:
        latency_ms = round(latency * 1000)
    return build_snapshot(
        guild_count=len(guilds),
        member_count=member_count,
        latency_ms=latency_ms,
        started_at=started_at,
        now=now,
    )


def _clean_day_entry(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {"samples": 0, "guilds": 0, "users": 0}
    return {
        "samples": _as_count(value.get("samples")),
        "guilds": _as_count(value.get("guilds")),
        "users": _as_count(value.get("users")),
    }


def build_history(
    previous: Any,
    snapshot: dict[str, Any],
    cmd_hours: Any,
    *,
    now: Optional[datetime.datetime] = None,
) -> dict[str, Any]:
    """履歴ドキュメントを1サンプル分進める（純粋関数）。

    days は JST の日付キーで、samples=その日の書き出し回数（稼働率の
    分子）、guilds / users=その日の最新値。直近 HISTORY_DAYS 日分だけ
    残す。cmd_hours は usage_stats の時間別カウンタ（合計値）の写しで、
    直近 CMD_HOURS_KEEP 件だけ残す。
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    today = now.astimezone(JST).date()
    days: dict[str, dict[str, int]] = {}
    if isinstance(previous, dict) and isinstance(previous.get("days"), dict):
        for key, value in previous["days"].items():
            days[str(key)] = _clean_day_entry(value)
    key = today.isoformat()
    entry = days.get(key) or {"samples": 0, "guilds": 0, "users": 0}
    entry["samples"] += 1
    entry["guilds"] = _as_count(snapshot.get("guild_count"))
    entry["users"] = _as_count(snapshot.get("member_count"))
    days[key] = entry
    cutoff = (today - datetime.timedelta(days=HISTORY_DAYS - 1)).isoformat()
    days = {k: v for k, v in days.items() if k >= cutoff}
    hours: dict[str, int] = {}
    if isinstance(cmd_hours, dict):
        for hour, count in cmd_hours.items():
            hours[str(hour)] = _as_count(count)
    if len(hours) > CMD_HOURS_KEEP:
        hours = {k: hours[k] for k in sorted(hours)[-CMD_HOURS_KEEP:]}
    return {"days": days, "cmd_hours": hours}


def collect_cmd_hours() -> dict[str, int]:
    """usage_stats の時間別カウンタを「コマンド+アクション」の合計に直す。"""
    try:
        from core.support.usage_stats import usage_stats

        hourly = usage_stats.get_store().snapshot().get("hourly") or {}
        return {
            str(hour): _as_count(bucket.get("commands")) + _as_count(bucket.get("actions"))
            for hour, bucket in hourly.items()
            if isinstance(bucket, dict)
        }
    except Exception:
        return {}


async def write_snapshot(
    bot: Any,
    *,
    started_at: Optional[datetime.datetime] = None,
    kv: Optional[KVStore] = None,
) -> dict[str, Any]:
    snapshot = collect_snapshot(bot, started_at=started_at)
    store = kv or KVStore(NAMESPACE)
    await store.set(SNAPSHOT_KEY, snapshot, wait=True)
    try:
        previous = await store.load_one(HISTORY_KEY)
        history = build_history(previous, snapshot, collect_cmd_hours())
        await store.set(HISTORY_KEY, history, wait=True)
    except Exception:
        # 履歴は付随情報。失敗してもスナップショット自体は書けている。
        logger.exception("サービスステータスの履歴書き出しに失敗しました")
    return snapshot
