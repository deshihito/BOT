"""音楽の再生履歴ストアと、自動再生 v1 の選曲ロジック。

自動再生 v1（履歴記録＋関連曲の自動補充）の土台:

- :class:`MusicHistoryStore` が ``data/music_history.json`` にユーザーごとの
  再生履歴を保存する。作法は :mod:`core.vc.voice_restore` のストアに倣い、
  メモリ保持＋バッチ flush＋一時ファイル経由の原子的置換で書く。
  保存するのは曲メタデータ（タイトル/投稿者/ソース）と再生回数・完了/スキップ
  回数・最終再生時刻だけに絞り、ユーザーごとに件数上限を設けて
  Raspberry Pi のディスクを圧迫しない。
- 選曲は純粋関数 :func:`select_autoplay_candidate` に切り出してある。
  候補（その場にいるユーザーの履歴、関連曲、全体集計）を注入すれば
  ネットワークも Discord も無しに単体テストできる。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths

logger = logging.getLogger("cogs.sio_music")

_DEFAULT_PATH = data_paths.data_path("music_history.json")

# 肥大化防止の上限。recent は「直近に再生した曲」の一覧、tracks は曲ごとの集計。
MAX_RECENT_PER_USER = 200
MAX_TRACKS_PER_USER = 200
MAX_USERS = 10_000

FLUSH_EVERY_EVENTS = 5
FLUSH_INTERVAL_SECONDS = 10.0

# 選曲時に1ユーザーから候補として見る上位曲数（重み付き抽選の母数）。
HISTORY_TOP_PER_USER = 25


def default_path() -> Path:
    return Path(os.environ.get("MUSIC_HISTORY_DATA_PATH") or _DEFAULT_PATH)


def track_key(source_input: str | None, b62_id: str | None, is_yt: bool) -> str:
    """キュー要素（入力, b62_id, is_yt）から履歴キーを作る。

    再生開始時点では YouTube はページ URL に解決済みのため、同じ曲は
    同じキーに寄る。添付ファイルは失効する URL ではなく b62 ID をキーにする。
    """
    if b62_id:
        return f"att:{b62_id}"
    text = (source_input or "").strip()
    if text:
        return f"src:{text}"
    return "src:"


def source_kind(source_input: str | None, b62_id: str | None, is_yt: bool) -> str:
    """入力からソース種別を大まかに判定する（履歴の表示・集計用）。"""
    if b62_id:
        return "file"
    text = (source_input or "").lower()
    if "soundcloud.com" in text:
        return "soundcloud"
    if "nicovideo" in text or "nico.ms" in text:
        return "niconico"
    if "spotify.com" in text:
        return "spotify"
    if is_yt or "youtube.com" in text or "youtu.be" in text or text.startswith("ytsearch"):
        return "youtube"
    if text.startswith(("http://", "https://")):
        return "other"
    return "youtube" if is_yt else "other"


class MusicHistoryStore(DirtyFlushMixin):
    """ユーザーごとの再生履歴をメモリに持ち、変更をバッチで JSON へ書く。"""

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
        self._data: dict[str, dict[str, Any]] = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, dict[str, Any]]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except Exception:
            logger.exception(
                "music_history: %s の読み込みに失敗しました。壊れたファイルを退避して続行します",
                self._path,
            )
            try:
                os.replace(
                    self._path,
                    self._path.with_name(self._path.name + f".broken-{int(time.time())}"),
                )
            except OSError:
                logger.debug("music_history: 壊れたファイルの退避に失敗しました", exc_info=True)
            return {}
        if not isinstance(raw, dict):
            return {}
        users = raw.get("users")
        if not isinstance(users, dict):
            return {}
        cleaned: dict[str, dict[str, Any]] = {}
        for user_id, entry in users.items():
            if not isinstance(entry, dict):
                continue
            recent = entry.get("recent")
            tracks = entry.get("tracks")
            cleaned[str(user_id)] = {
                "recent": recent if isinstance(recent, list) else [],
                "tracks": tracks if isinstance(tracks, dict) else {},
            }
        return cleaned

    def flush(self) -> None:
        with self._lock:
            payload = {"users": copy.deepcopy(self._data)}
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("music_history: 状態の保存に失敗しました path=%s", self._path)


    # ------------------------------------------------------------------ 記録
    def record_play(
        self,
        user_id: int,
        *,
        key: str,
        source_input: str | None,
        title: str | None,
        artist: str | None = None,
        source: str = "other",
        is_yt: bool = False,
        b62_id: str | None = None,
        at: float | None = None,
    ) -> None:
        """再生開始を1件記録する（曲ごとの集計と直近リストを更新）。"""
        if not user_id or not key:
            return
        now = float(at if at is not None else time.time())
        with self._lock:
            entry = self._data.setdefault(str(user_id), {"recent": [], "tracks": {}})
            tracks = entry["tracks"]
            track = tracks.get(key)
            if track is None:
                track = {
                    "input": source_input,
                    "title": title,
                    "artist": artist,
                    "source": source,
                    "is_yt": bool(is_yt),
                    "b62_id": b62_id,
                    "count": 0,
                    "completed": 0,
                    "skipped": 0,
                    "first_played": now,
                    "last_played": now,
                }
                tracks[key] = track
            track["count"] = int(track.get("count") or 0) + 1
            track["last_played"] = now
            if title:
                track["title"] = title
            if artist:
                track["artist"] = artist
            if source_input:
                track["input"] = source_input
            recent = entry["recent"]
            recent.append({"key": key, "title": title, "at": now})
            if len(recent) > MAX_RECENT_PER_USER:
                del recent[: len(recent) - MAX_RECENT_PER_USER]
            if len(tracks) > MAX_TRACKS_PER_USER:
                # 最も長く再生されていない曲から間引く。
                by_old = sorted(tracks.items(), key=lambda kv: kv[1].get("last_played") or 0)
                for old_key, _ in by_old[: len(tracks) - MAX_TRACKS_PER_USER]:
                    del tracks[old_key]
            if len(self._data) > MAX_USERS:
                def _last_active(item: tuple[str, dict]) -> float:
                    tracks_of_user = item[1].get("tracks") or {}
                    return max(
                        (t.get("last_played") or 0 for t in tracks_of_user.values()),
                        default=0,
                    )

                by_inactive = sorted(self._data.items(), key=_last_active)
                for old_user, _ in by_inactive[: len(self._data) - MAX_USERS]:
                    del self._data[old_user]
            self._mark_dirty()

    def record_outcome(self, user_id: int, key: str, *, completed: bool) -> None:
        """再生の終わり方を記録する（v2 の学習材料。v1 の選曲重みには使わない）。"""
        if not user_id or not key:
            return
        with self._lock:
            entry = self._data.get(str(user_id))
            if not entry:
                return
            track = entry["tracks"].get(key)
            if track is None:
                return
            field = "completed" if completed else "skipped"
            track[field] = int(track.get(field) or 0) + 1
            self._mark_dirty()

    # ------------------------------------------------------------------ 参照
    def user_tracks(self, user_id: int) -> list[dict[str, Any]]:
        """そのユーザーの曲集計を再生回数の多い順に返す（キーを含むコピー）。"""
        with self._lock:
            entry = self._data.get(str(user_id))
            if not entry:
                return []
            tracks = []
            for key, track in entry["tracks"].items():
                item = copy.deepcopy(track)
                item["key"] = key
                tracks.append(item)
            tracks.sort(key=lambda t: (-(t.get("count") or 0), -(t.get("last_played") or 0)))
            return tracks

    def all_tracks(self) -> list[dict[str, Any]]:
        """全ユーザーの集計を曲キー単位に合算して返す（サーバー全体の頻出用）。"""
        with self._lock:
            merged: dict[str, dict[str, Any]] = {}
            for entry in self._data.values():
                for key, track in entry["tracks"].items():
                    slot = merged.get(key)
                    if slot is None:
                        slot = copy.deepcopy(track)
                        slot["key"] = key
                        slot["count"] = 0
                        merged[key] = slot
                    slot["count"] += int(track.get("count") or 0)
                    if (track.get("last_played") or 0) > (slot.get("last_played") or 0):
                        slot["last_played"] = track.get("last_played")
                        if track.get("title"):
                            slot["title"] = track.get("title")
            tracks = list(merged.values())
            tracks.sort(key=lambda t: (-(t.get("count") or 0), -(t.get("last_played") or 0)))
            return tracks

    def clear_user(self, user_id: int) -> bool:
        """そのユーザーの履歴をすべて消す。消えたら True。"""
        with self._lock:
            if str(user_id) not in self._data:
                return False
            del self._data[str(user_id)]
            self._mark_dirty()
            return True


_store: MusicHistoryStore | None = None
_store_lock = threading.Lock()


def get_store() -> MusicHistoryStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = MusicHistoryStore()
        return _store


def reset_store(path: Path | str | None = None) -> MusicHistoryStore:
    global _store
    with _store_lock:
        _store = MusicHistoryStore(path)
        return _store


# ---------------------------------------------------------------------- 選曲
def _weighted_pick(items: list[dict[str, Any]], rng: random.Random) -> dict[str, Any] | None:
    """count を重みにした抽選。重みが全て 0 以下なら一様抽選に落とす。"""
    if not items:
        return None
    weights = [max(0, int(item.get("count") or 0)) for item in items]
    total = sum(weights)
    if total <= 0:
        return items[rng.randrange(len(items))]
    return rng.choices(items, weights=weights, k=1)[0]


def _as_candidate(track: dict[str, Any], *, user_id: int | None) -> dict[str, Any]:
    return {
        "key": track.get("key"),
        "input": track.get("input"),
        "title": track.get("title"),
        "artist": track.get("artist"),
        "source": track.get("source"),
        "is_yt": bool(track.get("is_yt")),
        "b62_id": track.get("b62_id"),
        "count": int(track.get("count") or 0),
        "user_id": user_id,
    }


def select_autoplay_candidate(
    *,
    histories: dict[int, list[dict[str, Any]]] | None = None,
    related: list[dict[str, Any]] | None = None,
    global_pool: list[dict[str, Any]] | None = None,
    exclude_keys: Any = frozenset(),
    rng: random.Random | None = None,
    last_user_id: int | None = None,
) -> tuple[dict[str, Any], str] | None:
    """自動補充の1曲を選ぶ純粋関数。

    優先順は (1) その場にいるユーザーの履歴 (2) 関連曲 (3) 全体集計。
    履歴は「前回出したユーザー」の次からローテーションし、1人の趣味に
    偏らないようにする。各ユーザーの中では再生回数の重み付き抽選。
    ``exclude_keys`` に入っている曲（再生中・キュー内・直近再生済み）は選ばない。
    戻り値は (候補, 種別) で、種別は "history" / "related" / "global"。
    候補が無ければ None。
    """
    rng = rng or random.Random()
    exclude = set(exclude_keys or ())

    histories = histories or {}
    user_ids = sorted(uid for uid, tracks in histories.items() if tracks)
    if user_ids:
        if last_user_id in user_ids:
            start = (user_ids.index(last_user_id) + 1) % len(user_ids)
            order = user_ids[start:] + user_ids[:start]
        else:
            order = user_ids
        for user_id in order:
            eligible = [
                track for track in histories[user_id][:HISTORY_TOP_PER_USER]
                if track.get("key") not in exclude and track.get("input")
            ]
            if not eligible:
                continue
            picked = _weighted_pick(eligible, rng)
            if picked is not None:
                return _as_candidate(picked, user_id=user_id), "history"

    for track in related or []:
        if track.get("key") in exclude or not track.get("input"):
            continue
        return _as_candidate(track, user_id=None), "related"

    eligible_global = [
        track for track in (global_pool or [])
        if track.get("key") not in exclude and track.get("input")
    ]
    picked = _weighted_pick(eligible_global, rng)
    if picked is not None:
        return _as_candidate(picked, user_id=None), "global"
    return None
