# -*- coding: utf-8 -*-
"""人物分析の交流グラフ保存（ギルド単位・本文は保存しない）。

数えるのは次の2つだけ:
- 辺カウント: 「誰が誰に返信／メンションしたか」を (from, to) で集約した回数
- 時間帯ヒストグラム: 発言者ごとの JST 24 バケツの発言件数

メッセージ本文・チャンネル名・生のログ列は一切保持しない。辺は集約済み
カウンタしか持たないため、データ量は「人数 × 平均の絡み相手数」に比例し、
発言総数には比例しない。

保存は data/person_analysis.json へ、usage_stats / garden と同じ
バッチフラッシュ方式（core/store_flush.py の DirtyFlushMixin）。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
FLUSH_EVERY_EVENTS = 100
FLUSH_INTERVAL_SECONDS = 300.0

#: guild_settings のセクション名。{"enabled": bool} だけを持つ。
PERSON_ANALYSIS_SECTION = "person_analysis"

_DEFAULT_PATH = data_paths.data_path("person_analysis.json")


def default_path() -> Path:
    return Path(os.environ.get("PERSON_ANALYSIS_PATH") or _DEFAULT_PATH)


def person_analysis_enabled(store, guild_id) -> bool:
    """guild_settings の収集トグル（既定 OFF）。読めない場合は OFF に倒す。"""
    if guild_id is None:
        return False
    try:
        raw = store.get(guild_id, PERSON_ANALYSIS_SECTION)
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    value = raw.get("enabled")
    return value if isinstance(value, bool) else False


def _empty_guild(now: datetime) -> dict[str, Any]:
    return {
        "started_at": now.astimezone(JST).isoformat(),
        "edges": {},
        "hours": {},
    }


def _clean_edges(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    edges: dict[str, dict[str, int]] = {}
    for src, outs in raw.items():
        if not isinstance(outs, dict):
            continue
        cleaned = {
            str(dst): int(count)
            for dst, count in outs.items()
            if isinstance(count, int) and count > 0
        }
        if cleaned:
            edges[str(src)] = cleaned
    return edges


def _clean_hours(raw: Any) -> dict[str, list[int]]:
    if not isinstance(raw, dict):
        return {}
    hours: dict[str, list[int]] = {}
    for user_id, buckets in raw.items():
        if not isinstance(buckets, list):
            continue
        cleaned = [int(v) if isinstance(v, int) and v > 0 else 0
                   for v in buckets[:24]]
        cleaned += [0] * (24 - len(cleaned))
        if any(cleaned):
            hours[str(user_id)] = cleaned
    return hours


def _clean_data(raw: Any) -> dict[str, Any]:
    guilds: dict[str, Any] = {}
    if isinstance(raw, dict) and isinstance(raw.get("guilds"), dict):
        for guild_id, entry in raw["guilds"].items():
            if not isinstance(entry, dict):
                continue
            started_at = entry.get("started_at")
            guilds[str(guild_id)] = {
                "started_at": started_at if isinstance(started_at, str) else "",
                "edges": _clean_edges(entry.get("edges")),
                "hours": _clean_hours(entry.get("hours")),
            }
    return {"guilds": guilds}


class PersonGraphStore(DirtyFlushMixin):
    """交流グラフの保持と JSON への保存を担う（同期 API、メモリ主体）。"""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
        self._flush_every = max(1, int(flush_every))
        self._flush_interval = float(flush_interval)
        self._lock = threading.RLock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._data = _clean_data(data_paths.read_json(self._path))

    # ------------------------------------------------------------------ 保存
    def flush(self) -> None:
        """現在のグラフを JSON に書き出す（tmp 経由で原子的に差し替える）。"""
        with self._lock:
            payload = copy.deepcopy(self._data)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("人物分析の保存に失敗しました path=%s", self._path)

    # ------------------------------------------------------------------ 記録
    def record(self, guild_id: int, author_id: int, targets: list[int],
               hour: int, *, now: datetime | None = None) -> None:
        """1メッセージ分を記録する。targets は重複排除済みの相手 ID 群。

        相手がいない通常発言もヒストグラムには数える（活発な時間の集計）。
        """
        now = now or datetime.now(JST)
        with self._lock:
            guild = self._data["guilds"].setdefault(
                str(guild_id), _empty_guild(now))
            if targets:
                outs = guild["edges"].setdefault(str(author_id), {})
                for target_id in targets:
                    key = str(target_id)
                    outs[key] = outs.get(key, 0) + 1
            hist = guild["hours"].setdefault(str(author_id), [0] * 24)
            hist[max(0, min(23, int(hour)))] += 1
            self._mark_dirty()

    # ------------------------------------------------------------------ 参照
    def guild_snapshot(self, guild_id: int) -> dict[str, Any]:
        """1ギルド分のグラフを int キー化した写しで返す（metrics の入力用）。

        戻り値: {"started_at": str, "edges": {int: {int: int}},
                 "hours": {int: [24 ints]}}。未収集のギルドは空の形で返す。
        """
        with self._lock:
            entry = self._data["guilds"].get(str(guild_id))
            if entry is None:
                return {"started_at": "", "edges": {}, "hours": {}}
            edges = {
                int(src): {int(dst): count for dst, count in outs.items()}
                for src, outs in entry["edges"].items()
            }
            hours = {
                int(user_id): list(buckets)
                for user_id, buckets in entry["hours"].items()
            }
            return {
                "started_at": entry.get("started_at", ""),
                "edges": edges,
                "hours": hours,
            }

    def has_data(self, guild_id: int) -> bool:
        with self._lock:
            return str(guild_id) in self._data["guilds"]


# ---------------------------------------------------------------------- 既定ストア
_default_store: PersonGraphStore | None = None


def get_store() -> PersonGraphStore:
    global _default_store
    if _default_store is None:
        _default_store = PersonGraphStore()
    return _default_store


def set_store(store: PersonGraphStore | None) -> None:
    """テスト用: 保存先を差し替える（None で既定に戻す）。"""
    global _default_store
    _default_store = store


def flush_safely() -> None:
    try:
        get_store().flush()
    except Exception:
        logger.debug("person analysis: flush failed", exc_info=True)
