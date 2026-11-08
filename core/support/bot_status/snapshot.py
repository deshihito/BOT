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


async def write_snapshot(
    bot: Any,
    *,
    started_at: Optional[datetime.datetime] = None,
    kv: Optional[KVStore] = None,
) -> dict[str, Any]:
    snapshot = collect_snapshot(bot, started_at=started_at)
    store = kv or KVStore(NAMESPACE)
    await store.set(SNAPSHOT_KEY, snapshot, wait=True)
    return snapshot
