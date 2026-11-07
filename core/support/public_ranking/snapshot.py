# -*- coding: utf-8 -*-
"""公開ランキング（Web /ranking）用のスナップショット生成。

Bot 内の全体ランキング（EXP総合・コイン保有）と同じ集計結果から、
表示名・数値・順位だけを取り出した公開用スナップショットを作り、
bot_kv の namespace ``public_ranking``（key ``snapshot``）へ書き出す。
Web は Bot API 経由でこれを読むだけ（F3 仕様）。

プライバシー境界:
- ユーザーID・サーバーID・サーバー名はスナップショットに含めない。
- 名前は Bot 内ランキングと同じ平文の表示名（core/general/user_names.py）。
- 公開範囲は Bot 内の全体ランキングで既に表示されている範囲に限る。
"""
from __future__ import annotations

import datetime
import logging
from typing import Any, Iterable, Mapping, Optional

from core.support.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "public_ranking"
SNAPSHOT_KEY = "snapshot"
TOP_N = 50


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def build_snapshot(
    exp_rows: Iterable[Mapping[str, Any]],
    coin_rows: Iterable[Mapping[str, Any]],
    names: Mapping[int, str],
    *,
    now: Optional[datetime.datetime] = None,
) -> dict[str, Any]:
    """集計済みの行と表示名から公開スナップショットを作る（純粋関数）。

    exp_rows: core.general.exp.exp_board.build_rows(..., "general", None) の行。
    coin_rows: {"user_id": ..., "balance": ...} の行（順不同でよい）。
    戻り値に ID 類は一切含めない。
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)

    exp_entries: list[dict[str, Any]] = []
    for row in list(exp_rows)[:TOP_N]:
        user_id = _as_int(row.get("user_id"))
        exp_entries.append({
            "name": str(names.get(user_id) or ""),
            "value": _as_int(row.get("value")),
            "level": _as_int(row.get("general_level")),
        })

    coins = sorted(
        coin_rows,
        key=lambda r: (-_as_int(r.get("balance")), _as_int(r.get("user_id"))),
    )[:TOP_N]
    coin_entries: list[dict[str, Any]] = []
    for row in coins:
        user_id = _as_int(row.get("user_id"))
        coin_entries.append({
            "name": str(names.get(user_id) or ""),
            "value": _as_int(row.get("balance")),
        })

    return {
        "updated_at": now.isoformat(),
        "exp": exp_entries,
        "coin": coin_entries,
    }


async def collect_snapshot(bot: Any) -> dict[str, Any]:
    """Bot の実データから公開スナップショットを集計する。"""
    import asyncio

    from core.general.exp.exp import _exp_load
    from core.general.exp.exp_board import build_rows
    from core.general.user_names import resolve_display_names

    exp_data = await _exp_load()
    exp_rows = build_rows(exp_data, "general", None)

    import config

    def _fetch_coins() -> list[dict[str, Any]]:
        response = (
            config.db_api.table("users")
            .select("user_id, balance")
            .order("balance", desc=True)
            .limit(TOP_N)
            .execute()
        )
        return list(response.data or [])

    coin_rows = await asyncio.to_thread(_fetch_coins)

    user_ids: list[int] = []
    for row in list(exp_rows)[:TOP_N]:
        user_ids.append(_as_int(row.get("user_id")))
    for row in coin_rows:
        user_ids.append(_as_int(row.get("user_id")))
    names = await resolve_display_names(bot, user_ids)
    return build_snapshot(exp_rows, coin_rows, names)


async def write_snapshot(bot: Any, kv: Optional[KVStore] = None) -> dict[str, Any]:
    snapshot = await collect_snapshot(bot)
    store = kv or KVStore(NAMESPACE)
    await store.set(SNAPSHOT_KEY, snapshot, wait=True)
    return snapshot
