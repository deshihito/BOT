# -*- coding: utf-8 -*-
"""地震情報フィードの設定（guild_settings）と既読状態の保存。

設定は guild_settings の "earthquake" セクションに
{"enabled": bool, "channel_id": int, "min_scale": int} を持つ
（min_scale は震度×10 表記、既定は震度3=30）。未設定は OFF。

既読状態（どの地震をどの詳しさまで見て、投稿済みか）は Bot 全体で
1つの JSON ファイル（data/earthquake_feed.json）に保存し、再起動を
またいでも同じ地震を二重投稿しない。投稿は稀なイベントなので、
更新のたびに即時保存する（バッチフラッシュにはしない）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from core.support import data_paths
from core.support.earthquake import feed

logger = logging.getLogger(__name__)

EARTHQUAKE_SECTION = "earthquake"

DEFAULT_MIN_SCALE = 30  # 震度3

_DEFAULT_PATH = data_paths.data_path("earthquake_feed.json")


def default_path() -> Path:
    return Path(os.environ.get("EARTHQUAKE_FEED_PATH") or _DEFAULT_PATH)


def _support_int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def get_earthquake_settings(store, guild_id) -> dict[str, Any]:
    """ギルドの地震情報設定を既定値で補って返す。未設定は OFF。"""
    raw = {}
    if guild_id is not None:
        try:
            raw = store.get(guild_id, EARTHQUAKE_SECTION)
        except Exception:
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False
    channel_id = _support_int(raw.get("channel_id"))
    min_scale = _support_int(raw.get("min_scale"))
    if min_scale not in feed.SCALE_LABELS:
        min_scale = DEFAULT_MIN_SCALE
    return {
        "enabled": enabled,
        "channel_id": channel_id,
        "min_scale": min_scale,
    }


class PostedEvents:
    """地震の既読状態（{key: {"level", "posted", "issue_time"}}）。

    読み込みは初回アクセス時。保存は set_state のたびに即時行い、
    失敗してもフィード自体は止めない（次回ポーリングで再試行される。
    その場合に限り同じ地震が再投稿されうるが、保存できていない以上
    正しさを優先する）。
    """

    def __init__(self, path: Path | None = None):
        self._path = Path(path) if path is not None else default_path()
        self._lock = threading.Lock()
        self._state: dict[str, dict] | None = None

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> dict[str, dict]:
        with self._lock:
            if self._state is None:
                self._state = self._read()
            return {key: dict(value) for key, value in self._state.items()}

    def _read(self) -> dict[str, dict]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except Exception:
            logger.warning("地震情報の既読状態を読めませんでした: %s", self._path)
            return {}
        if not isinstance(raw, dict):
            return {}
        posted = raw.get("posted")
        if not isinstance(posted, dict):
            return {}
        return {
            str(key): value for key, value in posted.items()
            if isinstance(value, dict)
        }

    def save(self, state: dict[str, dict]) -> None:
        with self._lock:
            self._state = {str(key): dict(value) for key, value in state.items()}
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._path.with_suffix(".tmp")
                tmp.write_text(
                    json.dumps({"posted": self._state}, ensure_ascii=False),
                    encoding="utf-8",
                )
                tmp.replace(self._path)
            except Exception:
                logger.warning(
                    "地震情報の既読状態を保存できませんでした: %s",
                    self._path, exc_info=True,
                )
