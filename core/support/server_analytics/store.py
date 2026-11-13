# -*- coding: utf-8 -*-
"""サーバー分析の日次メタ集計の保存（ギルド単位・本文は保存しない）。

数えるのは日次×ギルドの集計だけ:
- messages: その日の発言総数
- users: 発言者 ID → 件数（アクティブユーザー数と Top Users の算出用）
- vc_seconds: ユーザー ID → VC 滞在秒数
- new_members: 新規参加数
- emojis: 絵文字キー → 件数（ユニコードは文字そのもの、カスタムは
  ``:name:`` 表記。ID や画像は持たない）
- reacted: リアクションを受けたメッセージ著者 ID → 件数
- mentioned: メンション／返信されたユーザー ID → 件数
- hours: JST 0–23 時の発言件数ヒストグラム（曜日は日付から復元できる
  ため、ヒートマップは表示時に日付の曜日で振り分けて合算する）

保持は直近 RETENTION_DAYS 日のローリングで、それより古い日は記録時と
読み込み時に落とす。保存は data/server_analytics.json へ、person_analysis
と同じバッチフラッシュ方式（core/store_flush.py の DirtyFlushMixin）。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
FLUSH_EVERY_EVENTS = 100
FLUSH_INTERVAL_SECONDS = 300.0
RETENTION_DAYS = 35
#: Overview / ヒートマップの対象期間（直近14日）。
WINDOW_DAYS = 14

#: guild_settings のセクション名。{"enabled": bool, "ranking_optout": bool}。
SERVER_ANALYTICS_SECTION = "server_analytics"

#: サーバー対抗ランキングのオプトアウトを表すキー（セクション内）。
#: 参加は既定で ON（キー無し = 参加）。True のギルドだけランキングから外す。
RANKING_OPTOUT_KEY = "ranking_optout"

_DEFAULT_PATH = data_paths.data_path("server_analytics.json")

# カスタム絵文字のマークアップ <a:name:id> / <:name:id> から名前だけ取る。
_CUSTOM_EMOJI_RE = re.compile(r"<a?:([A-Za-z0-9_]+):\d+>")
# ユニコード絵文字のおおまかな範囲（記号・絵記号・国旗・肌色修飾など）。
_UNICODE_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\U00002600-\U000026FF"
    "\U00002700-\U000027BF"
    "\U0001F1E6-\U0001F1FF"
    "]"
)


def default_path() -> Path:
    return Path(os.environ.get("SERVER_ANALYTICS_PATH") or _DEFAULT_PATH)


def server_analytics_enabled(store, guild_id) -> bool:
    """guild_settings の収集トグル（既定 OFF）。読めない場合は OFF に倒す。"""
    if guild_id is None:
        return False
    try:
        raw = store.get(guild_id, SERVER_ANALYTICS_SECTION)
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    value = raw.get("enabled")
    return value if isinstance(value, bool) else False


def section_ranking_opted_out(section) -> bool:
    """セクション dict がランキングのオプトアウト状態かどうか。

    参加は既定 ON なので、ranking_optout が明示的に True のときだけ
    「参加しない」とみなす（未設定・型違いは参加側に倒す）。
    """
    if not isinstance(section, dict):
        return False
    return section.get(RANKING_OPTOUT_KEY) is True


def server_ranking_opted_out(store, guild_id) -> bool:
    """guild_settings のランキング参加状態（既定は参加）。読めない場合は参加扱い。"""
    if guild_id is None:
        return False
    try:
        raw = store.get(guild_id, SERVER_ANALYTICS_SECTION)
    except Exception:
        return False
    return section_ranking_opted_out(raw)


def extract_emojis(content: str | None) -> list[str]:
    """メッセージ本文から絵文字キーだけを取り出す（本文は保持しない）。

    カスタム絵文字は ``:name:``、ユニコード絵文字は文字そのものをキーに
    する。呼び出し側は戻り値の集計だけを保存し、本文自体は捨てる。
    """
    if not content:
        return []
    keys = [f":{name}:" for name in _CUSTOM_EMOJI_RE.findall(content)]
    keys.extend(_UNICODE_EMOJI_RE.findall(content))
    return keys


def _empty_day() -> dict[str, Any]:
    return {
        "messages": 0,
        "users": {},
        "vc_seconds": {},
        "new_members": 0,
        "emojis": {},
        "reacted": {},
        "mentioned": {},
        "hours": [0] * 24,
    }


def _clean_counter(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): int(value)
        for key, value in raw.items()
        if isinstance(value, int) and value > 0
    }


def _clean_day(raw: Any) -> dict[str, Any]:
    day = _empty_day()
    if not isinstance(raw, dict):
        return day
    if isinstance(raw.get("messages"), int) and raw["messages"] > 0:
        day["messages"] = raw["messages"]
    if isinstance(raw.get("new_members"), int) and raw["new_members"] > 0:
        day["new_members"] = raw["new_members"]
    for key in ("users", "vc_seconds", "emojis", "reacted", "mentioned"):
        day[key] = _clean_counter(raw.get(key))
    hours = raw.get("hours")
    if isinstance(hours, list):
        cleaned = [int(v) if isinstance(v, int) and v > 0 else 0
                   for v in hours[:24]]
        cleaned += [0] * (24 - len(cleaned))
        day["hours"] = cleaned
    return day


def _prune_days(days: dict[str, Any], today: date) -> dict[str, Any]:
    """保持期間（直近 RETENTION_DAYS 日）より古い日を落とす。"""
    cutoff = today - timedelta(days=RETENTION_DAYS - 1)
    kept: dict[str, Any] = {}
    for key, value in days.items():
        try:
            day = date.fromisoformat(str(key))
        except ValueError:
            continue
        if day >= cutoff:
            kept[key] = value
    return kept


def _clean_data(raw: Any, today: date) -> dict[str, Any]:
    guilds: dict[str, Any] = {}
    if isinstance(raw, dict) and isinstance(raw.get("guilds"), dict):
        for guild_id, entry in raw["guilds"].items():
            if not isinstance(entry, dict):
                continue
            started_at = entry.get("started_at")
            raw_days = entry.get("days")
            days = {}
            if isinstance(raw_days, dict):
                days = {str(k): _clean_day(v) for k, v in raw_days.items()}
            guilds[str(guild_id)] = {
                "started_at": started_at if isinstance(started_at, str) else "",
                "days": _prune_days(days, today),
            }
    return {"guilds": guilds}


class ServerAnalyticsStore(DirtyFlushMixin):
    """日次メタ集計の保持と JSON への保存を担う（同期 API、メモリ主体）。"""

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
        today = datetime.now(JST).date()
        self._data = _clean_data(data_paths.read_json(self._path), today)

    # ------------------------------------------------------------------ 保存
    def flush(self) -> None:
        """現在の集計を JSON に書き出す（tmp 経由で原子的に差し替える）。"""
        with self._lock:
            payload = copy.deepcopy(self._data)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False),
                           encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("サーバー分析の保存に失敗しました path=%s",
                             self._path)

    # ------------------------------------------------------------------ 内部
    def _guild(self, guild_id: int, now: datetime) -> dict[str, Any]:
        guild = self._data["guilds"].get(str(guild_id))
        if guild is None:
            guild = {
                "started_at": now.astimezone(JST).isoformat(),
                "days": {},
            }
            self._data["guilds"][str(guild_id)] = guild
        return guild

    def _day(self, guild_id: int, now: datetime) -> dict[str, Any]:
        guild = self._guild(guild_id, now)
        key = now.astimezone(JST).date().isoformat()
        day = guild["days"].get(key)
        if day is None:
            day = _empty_day()
            guild["days"][key] = day
            guild["days"] = _prune_days(guild["days"],
                                         now.astimezone(JST).date())
        return day

    # ------------------------------------------------------------------ 記録
    def record_message(self, guild_id: int, author_id: int,
                       mentioned_ids: list[int], emoji_keys: list[str],
                       *, now: datetime | None = None) -> None:
        """1メッセージ分を記録する。本文は受け取らない（集計値だけ）。"""
        now = now or datetime.now(JST)
        with self._lock:
            day = self._day(guild_id, now)
            day["messages"] += 1
            users = day["users"]
            key = str(author_id)
            users[key] = users.get(key, 0) + 1
            hour = max(0, min(23, now.astimezone(JST).hour))
            day["hours"][hour] += 1
            mentioned = day["mentioned"]
            for target_id in mentioned_ids:
                tkey = str(target_id)
                mentioned[tkey] = mentioned.get(tkey, 0) + 1
            emojis = day["emojis"]
            for emoji_key in emoji_keys:
                emojis[emoji_key] = emojis.get(emoji_key, 0) + 1
            self._mark_dirty()

    def record_reaction(self, guild_id: int, author_id: int,
                        *, now: datetime | None = None) -> None:
        """メッセージ著者がリアクションを1件受けたことを記録する。"""
        now = now or datetime.now(JST)
        with self._lock:
            day = self._day(guild_id, now)
            reacted = day["reacted"]
            key = str(author_id)
            reacted[key] = reacted.get(key, 0) + 1
            self._mark_dirty()

    def record_member_join(self, guild_id: int,
                           *, now: datetime | None = None) -> None:
        now = now or datetime.now(JST)
        with self._lock:
            day = self._day(guild_id, now)
            day["new_members"] += 1
            self._mark_dirty()

    def record_vc_seconds(self, guild_id: int, user_id: int, seconds: int,
                          *, now: datetime | None = None) -> None:
        """VC 滞在秒数を記録する。日付は退出時点の日（JST）に寄せる。"""
        if seconds <= 0:
            return
        now = now or datetime.now(JST)
        with self._lock:
            day = self._day(guild_id, now)
            vc = day["vc_seconds"]
            key = str(user_id)
            vc[key] = vc.get(key, 0) + int(seconds)
            self._mark_dirty()

    # ------------------------------------------------------------------ 参照
    def guild_snapshot(self, guild_id: int) -> dict[str, Any]:
        """1ギルド分の集計を int キー化した写しで返す（metrics の入力用）。

        戻り値: {"started_at": str, "days": {"YYYY-MM-DD": day}}。
        day の users / vc_seconds / reacted / mentioned は int キー。
        未収集のギルドは空の形で返す。
        """
        with self._lock:
            entry = self._data["guilds"].get(str(guild_id))
            if entry is None:
                return {"started_at": "", "days": {}}
            days: dict[str, Any] = {}
            for key, raw_day in entry.get("days", {}).items():
                day = _clean_day(raw_day)
                for counter_key in ("users", "vc_seconds", "reacted",
                                    "mentioned"):
                    day[counter_key] = {
                        int(k): v for k, v in day[counter_key].items()
                        if str(k).lstrip("-").isdigit()
                    }
                days[key] = day
            return {"started_at": entry.get("started_at", ""), "days": days}

    def has_data(self, guild_id: int) -> bool:
        with self._lock:
            return str(guild_id) in self._data["guilds"]

    def all_guild_snapshots(self) -> dict[int, dict[str, Any]]:
        """収集済み全ギルド分のスナップショット（サーバー対抗ランキング用）。

        戻り値: {guild_id(int): guild_snapshot と同じ形}。ID として読めない
        キーは落とす。
        """
        with self._lock:
            guild_ids = list(self._data["guilds"].keys())
        snapshots: dict[int, dict[str, Any]] = {}
        for raw_id in guild_ids:
            try:
                guild_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            snapshots[guild_id] = self.guild_snapshot(guild_id)
        return snapshots


# ---------------------------------------------------------------------- 既定ストア
_default_store: ServerAnalyticsStore | None = None


def get_store() -> ServerAnalyticsStore:
    global _default_store
    if _default_store is None:
        _default_store = ServerAnalyticsStore()
    return _default_store


def set_store(store: ServerAnalyticsStore | None) -> None:
    """テスト用: 保存先を差し替える（None で既定に戻す）。"""
    global _default_store
    _default_store = store


def flush_safely() -> None:
    try:
        get_store().flush()
    except Exception:
        logger.debug("server analytics: flush failed", exc_info=True)
