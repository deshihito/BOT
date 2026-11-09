# -*- coding: utf-8 -*-
"""公開ランキング（Web /ranking）用のスナップショット生成。

Bot 内の全体ランキング（EXP総合・コイン保有・bump系RTA）と同じ
集計結果から、表示名・数値・順位だけを取り出した公開用スナップ
ショットを作り、bot_kv の namespace ``public_ranking``（key
``snapshot``）へ書き出す。Web は Bot API 経由でこれを読むだけ（F3 仕様）。

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

# Web 公開する RTA のサービス種別（core/game/rta/common.py の
# RTA_SERVICE_TYPES と同じ並び・同じキー。support 側から game 側を
# import しないためここにも持ち、サービス追加時は両方を揃えること）。
RTA_SERVICE_TYPES = (
    "bump", "up", "vote", "takasumi", "dicoall", "dcafe", "sharkbot",
)


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _rta_entries(
    rows: Iterable[Mapping[str, Any]], names: Mapping[int, str],
) -> list[dict[str, Any]]:
    """RTA の行（user_id / elapsed_ms）を速い順の公開エントリにする。"""
    ordered = sorted(
        rows,
        key=lambda r: (_as_int(r.get("elapsed_ms")), _as_int(r.get("user_id"))),
    )[:TOP_N]
    return [
        {
            "name": str(names.get(_as_int(r.get("user_id"))) or ""),
            "value": _as_int(r.get("elapsed_ms")),
        }
        for r in ordered
    ]


def best_rta_rows(
    event_rows: Iterable[Mapping[str, Any]], *, slowest: bool = False,
    limit: int = TOP_N,
) -> list[dict[str, Any]]:
    """整列済みのイベント行から、ユーザーごとの代表記録を先着で取る。

    event_rows は elapsed_ms の昇順（最速ボード）または降順（最遅ボード）
    で整列済みのこと。同じユーザーの最初の行が、そのユーザーの最速 /
    最遅の記録（日時つき）になる。
    戻り値: [{"user_id", "elapsed_ms", "completed_at"}]（整列順を維持）。
    """
    picked: dict[int, dict[str, Any]] = {}
    for row in event_rows:
        user_id = _as_int(row.get("user_id"))
        if user_id == 0 or user_id in picked:
            continue
        completed_at = row.get("completed_at")
        picked[user_id] = {
            "user_id": user_id,
            "elapsed_ms": _as_int(row.get("elapsed_ms")),
            "completed_at": completed_at if isinstance(completed_at, str) else None,
        }
        if len(picked) >= limit:
            break
    return list(picked.values())


def combine_rta_boards(
    boards: Mapping[str, Iterable[Mapping[str, Any]]], *,
    slowest: bool = False, limit: int = TOP_N,
) -> list[dict[str, Any]]:
    """サービス別の代表記録を総合ボードへ統合する。

    ユーザーごとに全サービス中の最速（slowest=True なら最遅）の記録を
    採り、そのサービスと日時を保持する。同点は先に現れた記録を優先する。
    """
    best: dict[int, dict[str, Any]] = {}
    for service, rows in boards.items():
        for row in rows:
            user_id = _as_int(row.get("user_id"))
            if user_id == 0:
                continue
            elapsed = _as_int(row.get("elapsed_ms"))
            current = best.get(user_id)
            if current is not None:
                better = elapsed > current["elapsed_ms"] if slowest else elapsed < current["elapsed_ms"]
                if not better:
                    continue
            completed_at = row.get("completed_at")
            best[user_id] = {
                "user_id": user_id,
                "elapsed_ms": elapsed,
                "completed_at": completed_at if isinstance(completed_at, str) else None,
                "service": service,
            }

    def sort_key(item: Mapping[str, Any]):
        elapsed = _as_int(item.get("elapsed_ms"))
        return (
            -elapsed if slowest else elapsed,
            str(item.get("completed_at") or ""),
            _as_int(item.get("user_id")),
        )

    return sorted(best.values(), key=sort_key)[:limit]


def _rta_board_entries(
    rows: Iterable[Mapping[str, Any]], names: Mapping[int, str],
    service: str = "",
) -> list[dict[str, Any]]:
    """代表記録の行を、日時・サービスつきの公開エントリにする（順序維持）。"""
    entries: list[dict[str, Any]] = []
    for row in rows:
        entries.append({
            "name": str(names.get(_as_int(row.get("user_id"))) or ""),
            "value": _as_int(row.get("elapsed_ms")),
            "at": row.get("completed_at") if isinstance(row.get("completed_at"), str) else None,
            "service": str(row.get("service") or service),
        })
    return entries


def build_snapshot(
    exp_rows: Iterable[Mapping[str, Any]],
    coin_rows: Iterable[Mapping[str, Any]],
    names: Mapping[int, str],
    *,
    now: Optional[datetime.datetime] = None,
    bump_rows: Iterable[Mapping[str, Any]] = (),
    up_rows: Iterable[Mapping[str, Any]] = (),
    rta_boards: Optional[Mapping[str, Mapping[str, Iterable[Mapping[str, Any]]]]] = None,
) -> dict[str, Any]:
    """集計済みの行と表示名から公開スナップショットを作る（純粋関数）。

    exp_rows: core.general.exp.exp_board.build_rows(..., "general", None) の行。
    coin_rows: {"user_id": ..., "balance": ...} の行（順不同でよい）。
    bump_rows / up_rows: {"user_id": ..., "elapsed_ms": ...} の行（順不同でよい）。
        旧形式の入力で、rta_boards が無いときだけ使う。
    rta_boards: {サービス: {"fast": 代表記録の行, "slow": 代表記録の行}}。
        代表記録の行は best_rta_rows の戻り値の形（user_id / elapsed_ms /
        completed_at）。ここから日時・サービスつきの "rta" と、サービス
        横断の総合ボード ("rta"["all"]) を作る。旧キーの bump / up は
        fast 側から従来形式（name / value のみ）で引き続き出す。
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

    if rta_boards is not None:
        rta: dict[str, Any] = {}
        fast_by_service: dict[str, list[Mapping[str, Any]]] = {}
        slow_by_service: dict[str, list[Mapping[str, Any]]] = {}
        for service in RTA_SERVICE_TYPES:
            boards = rta_boards.get(service) or {}
            fast_rows = list(boards.get("fast") or [])
            slow_rows = list(boards.get("slow") or [])
            fast_by_service[service] = fast_rows
            slow_by_service[service] = slow_rows
            rta[service] = {
                "fast": _rta_board_entries(fast_rows, names, service),
                "slow": _rta_board_entries(slow_rows, names, service),
            }
        rta["all"] = {
            "fast": _rta_board_entries(
                combine_rta_boards(fast_by_service), names),
            "slow": _rta_board_entries(
                combine_rta_boards(slow_by_service, slowest=True), names),
        }
        legacy_bump = fast_by_service["bump"]
        legacy_up = fast_by_service["up"]
    else:
        rta = {}
        legacy_bump = bump_rows
        legacy_up = up_rows

    return {
        "updated_at": now.isoformat(),
        "exp": exp_entries,
        "coin": coin_entries,
        "bump": _rta_entries(legacy_bump, names),
        "up": _rta_entries(legacy_up, names),
        "rta": rta,
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

    def _fetch_rta_board(event_type: str, slowest: bool) -> list[dict[str, Any]]:
        # 記録日時も一緒に公開するため、集計 RPC ではなくイベント表を
        # elapsed の方向に走査し、ユーザーごとの代表記録（最初の1件）を
        # 拾う。TOP_N 人ぶん集まるか、イベントが尽きたら止める。
        page_size = 1000
        events: list[dict[str, Any]] = []
        picked: list[dict[str, Any]] = []
        for page in range(3):
            response = (
                config.db_api.table("bump_rta_events")
                .select("user_id, elapsed_ms, completed_at")
                .eq("event_type", event_type)
                .order("elapsed_ms", desc=slowest)
                .order("completed_at")
                .range(page * page_size, page * page_size + page_size - 1)
                .execute()
            )
            rows = list(response.data or [])
            events.extend(rows)
            picked = best_rta_rows(events, slowest=slowest)
            if len(picked) >= TOP_N or len(rows) < page_size:
                break
        return picked

    rta_boards: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for event_type in RTA_SERVICE_TYPES:
        boards: dict[str, list[dict[str, Any]]] = {}
        for slowest, key in ((False, "fast"), (True, "slow")):
            try:
                boards[key] = await asyncio.to_thread(
                    _fetch_rta_board, event_type, slowest)
            except Exception:
                # RTA の取得失敗で EXP / コインの公開まで止めない。
                logger.warning(
                    "公開ランキング: %s RTA (%s) の取得に失敗しました"
                    "（空で続行します）",
                    event_type, key, exc_info=True)
                boards[key] = []
        rta_boards[event_type] = boards

    user_ids: list[int] = []
    for row in list(exp_rows)[:TOP_N]:
        user_ids.append(_as_int(row.get("user_id")))
    for row in coin_rows:
        user_ids.append(_as_int(row.get("user_id")))
    for boards in rta_boards.values():
        for rows in boards.values():
            for row in rows:
                user_ids.append(_as_int(row.get("user_id")))
    names = await resolve_display_names(bot, user_ids)
    return build_snapshot(
        exp_rows, coin_rows, names, rta_boards=rta_boards,
    )


async def write_snapshot(bot: Any, kv: Optional[KVStore] = None) -> dict[str, Any]:
    snapshot = await collect_snapshot(bot)
    store = kv or KVStore(NAMESPACE)
    await store.set(SNAPSHOT_KEY, snapshot, wait=True)
    return snapshot
