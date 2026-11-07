"""管理者向けの利用統計（総量カウンタ）。

ユーザ個人単位の利用履歴（core/general/action_usage.py、仕様書 D-2）とは別物で、
こちらは「Bot 全体で何がどれだけ使われたか」の総量だけを持つ。
ユーザ単位の内訳は保持しない・表示しない。

集計対象:
- コマンド呼び出し（cogs/usage_stats.py のリスナが記録する。
  プレフィックスは ``!名前``、スラッシュは ``/名前`` をキーにする）
- アクション実行（パネル／ショートカット／/quick／AI tools が通る
  4 つの dispatch 入口から、action_usage の記録と並べて記録する。
  キーは action id（``root:action``）

保存は専用 JSON（既定 ``data/usage_stats.json``、環境変数
``USAGE_STATS_PATH`` で変更可）。毎回は書かず、メモリ上で数えて
一定件数ごと／一定時間ごとにまとめて書き出す（監査 #3 の方針）。
記録の失敗で本体機能を壊さないよう、``*_safely`` 系は例外を握る。
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

from core.support import data_paths

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
DAILY_KEEP_DAYS = 7
FLUSH_EVERY_EVENTS = 100
FLUSH_INTERVAL_SECONDS = 300.0

_DEFAULT_PATH = data_paths.data_path("usage_stats.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/usage_stats.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(Path(__file__).resolve().parent.parent / "usage_stats.py", "usage_stats.json")  # 旧保存先は収納前の深さ基準のため1階層上を渡す


def _max_counts(canonical: Any, stray: Any) -> dict:
    """カウンタ同士のマージ: キーごとに大きい方を採る (EXP の移行と同じ)。"""
    merged: dict = {}
    if isinstance(canonical, dict):
        merged.update(canonical)
    if isinstance(stray, dict):
        for key, value in stray.items():
            current = merged.get(key)
            if isinstance(value, (int, float)) and isinstance(current, (int, float)):
                merged[key] = max(current, value)
            else:
                merged[key] = value
    return merged


def _merge_migrated(canonical: Any, stray: Any) -> Any:
    """パスずれ移行時のマージ (利用統計専用)。

    総量カウンタは2ファイル間で合算すると、移行の境界で同じ期間を
    二重に数える危険があるため合算しない。キーごとに大きい方を採る
    (EXP の最大値マージと同じ考え方で、二重計上だけは確実に避ける)。
    daily も日×種別ごとに最大値を採る。started_at などのスカラーは
    旧パス (最新ファイル) 側を正とする。
    """
    if not isinstance(stray, dict):
        return stray
    if not isinstance(canonical, dict):
        return stray
    merged = dict(stray)
    merged["commands"] = _max_counts(canonical.get("commands"), stray.get("commands"))
    merged["actions"] = _max_counts(canonical.get("actions"), stray.get("actions"))
    daily: dict = {}
    canon_daily = canonical.get("daily") if isinstance(canonical.get("daily"), dict) else {}
    stray_daily = stray.get("daily") if isinstance(stray.get("daily"), dict) else {}
    for day in set(canon_daily) | set(stray_daily):
        daily[day] = _max_counts(canon_daily.get(day), stray_daily.get(day))
    merged["daily"] = daily
    return merged


def default_path() -> Path:
    return Path(os.environ.get("USAGE_STATS_PATH") or _DEFAULT_PATH)


def _today_key(now: datetime) -> str:
    return now.astimezone(JST).date().isoformat()


def _empty_data(now: datetime) -> dict[str, Any]:
    return {
        "started_at": now.astimezone(JST).isoformat(),
        "commands": {},
        "actions": {},
        "daily": {},
    }


def _clean_counts(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    return {
        str(k): int(v)
        for k, v in raw.items()
        if isinstance(v, int) or (isinstance(v, str) and v.isdigit())
    }


def _clean_daily(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    daily: dict[str, dict[str, int]] = {}
    for day, bucket in raw.items():
        if isinstance(bucket, dict):
            daily[str(day)] = {
                "commands": int(bucket.get("commands") or 0),
                "actions": int(bucket.get("actions") or 0),
            }
    return daily


class UsageStatsStore:
    """総量カウンタの保持と JSON への保存を担う（同期 API、メモリ主体）。"""

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
        self._lock = threading.Lock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._data = self._load()

    # ------------------------------------------------------------------ 読み書き
    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする (_merge_migrated 参照)。環境変数や明示パスで
        # 保存先が指定されている場合は移行しない。
        if self._path != _DEFAULT_PATH:
            return data_paths.read_json(self._path)
        stray_raw = data_paths.read_json(_STRAY_PATH)
        if stray_raw is None:
            return data_paths.read_json(self._path)
        canonical_raw = data_paths.read_json(self._path)
        if canonical_raw is None:
            return stray_raw
        return _merge_migrated(canonical_raw, stray_raw)

    def _load(self) -> dict[str, Any]:
        raw = self._read_raw()
        if not isinstance(raw, dict):
            return _empty_data(datetime.now(JST))
        data = _empty_data(datetime.now(JST))
        if isinstance(raw.get("started_at"), str) and raw["started_at"]:
            data["started_at"] = raw["started_at"]
        data["commands"] = _clean_counts(raw.get("commands"))
        data["actions"] = _clean_counts(raw.get("actions"))
        data["daily"] = _clean_daily(raw.get("daily"))
        return data

    def flush(self) -> None:
        """現在のカウンタを JSON に書き出す（tmp 経由で原子的に差し替える）。"""
        with self._lock:
            payload = copy.deepcopy(self._data)
            self._dirty = 0
            self._last_flush = time.monotonic()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self._path)

    def _maybe_flush(self) -> None:
        if self._dirty >= self._flush_every or (
            self._dirty > 0 and time.monotonic() - self._last_flush >= self._flush_interval
        ):
            try:
                self.flush()
            except Exception:
                logger.debug("usage stats flush failed", exc_info=True)

    # ------------------------------------------------------------------ 記録
    def _record(self, kind: str, key: str, now: datetime | None) -> None:
        if not key:
            return
        now = now or datetime.now(JST)
        with self._lock:
            bucket = self._data["commands"] if kind == "commands" else self._data["actions"]
            bucket[key] = bucket.get(key, 0) + 1
            day = _today_key(now)
            daily = self._data["daily"]
            entry = daily.setdefault(day, {"commands": 0, "actions": 0})
            entry[kind] += 1
            # 日別は直近 DAILY_KEEP_DAYS 日分だけ残す（古い日付を間引く）。
            cutoff = (now.astimezone(JST).date() - timedelta(days=DAILY_KEEP_DAYS - 1)).isoformat()
            for old in [d for d in daily if d < cutoff]:
                del daily[old]
            self._dirty += 1
        self._maybe_flush()

    def record_command(self, name: str, *, now: datetime | None = None) -> None:
        """コマンド呼び出しを1回分記録する（キーは ``!logs`` / ``/vc`` 形式）。"""
        self._record("commands", name, now)

    def record_action(self, action_id: str, *, now: datetime | None = None) -> None:
        """アクション実行を1回分記録する（キーは action id）。"""
        self._record("actions", action_id, now)

    def reset(self, *, now: datetime | None = None) -> None:
        """カウンタを初期化して即座に保存する（集計開始日時も現在に更新）。"""
        with self._lock:
            self._data = _empty_data(now or datetime.now(JST))
            self._dirty = 0
        self.flush()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)


# ---------------------------------------------------------------------- 集計ヘルパ
def top_items(counts: dict[str, int], limit: int = 10) -> list[tuple[str, int]]:
    """(キー, 回数) を回数の多い順に返す（同数はキー順で安定させる）。"""
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]


def share_percent(count: int, total: int) -> float:
    """全体に占める割合（%）。total が 0 のときは 0.0。"""
    if total <= 0:
        return 0.0
    return count * 100.0 / total


def format_top_lines(
    counts: dict[str, int],
    *,
    limit: int = 10,
    label_for: Any = None,
) -> str:
    """トップ N を「順位. キー（ラベル） — 回数 (割合%)」の行テキストにする。"""
    total = sum(counts.values())
    if total <= 0:
        return "（まだ記録がありません）"
    lines = []
    for rank, (key, count) in enumerate(top_items(counts, limit), start=1):
        label = ""
        if label_for is not None:
            try:
                found = label_for(key)
            except Exception:
                found = None
            if found:
                label = f"（{found}）"
        lines.append(f"{rank}. `{key}`{label} — {count}回 ({share_percent(count, total):.1f}%)")
    return "\n".join(lines)


# ---------------------------------------------------------------------- 既定ストア
_default_store: UsageStatsStore | None = None


def get_store() -> UsageStatsStore:
    global _default_store
    if _default_store is None:
        _default_store = UsageStatsStore()
    return _default_store


def record_command_safely(name: str) -> None:
    """記録用ラッパ。失敗しても例外を外へ出さない。"""
    try:
        get_store().record_command(name)
    except Exception:
        logger.debug("usage stats: command record failed: %s", name, exc_info=True)


def record_action_safely(action_id: str) -> None:
    """記録用ラッパ。失敗しても例外を外へ出さない。"""
    try:
        get_store().record_action(action_id)
    except Exception:
        logger.debug("usage stats: action record failed: %s", action_id, exc_info=True)


def flush_safely() -> None:
    try:
        get_store().flush()
    except Exception:
        logger.debug("usage stats: flush failed", exc_info=True)


def reset_safely() -> None:
    try:
        get_store().reset()
    except Exception:
        logger.debug("usage stats: reset failed", exc_info=True)
