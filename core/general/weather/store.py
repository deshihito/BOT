# -*- coding: utf-8 -*-
"""天気のユーザー別「前回の地域」ストア。

パネルを開き直したときに前回見た地域を初期表示にするための小さな
控え（専用 JSON、既定 data/weather_users.json、環境変数
WEATHER_DATA_PATH で変更可）。保存の流儀は omikuji のストアと同じ
（メモリ主体＋原子差し替え、失敗しても機能は止めない）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from core.support import data_paths

logger = logging.getLogger(__name__)

_DEFAULT_PATH = data_paths.data_path("weather_users.json")


class WeatherUserStore:
    """ユーザーID -> 最後に見た office コード。"""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = os.environ.get("WEATHER_DATA_PATH") or _DEFAULT_PATH
        self._path = Path(path)
        self._lock = threading.RLock()
        self._entries: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        raw = data_paths.read_json(self._path)
        if isinstance(raw, dict) and isinstance(raw.get("last_area"), dict):
            return {str(k): str(v) for k, v in raw["last_area"].items()}
        return {}

    def _save(self) -> None:
        payload = {"version": 1, "last_area": self._entries}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            logger.exception("weather: 前回地域の保存に失敗しました path=%s",
                             self._path)

    def last_area(self, user_id: int) -> str | None:
        with self._lock:
            return self._entries.get(str(user_id))

    def remember(self, user_id: int, office_code: str) -> None:
        with self._lock:
            if self._entries.get(str(user_id)) == office_code:
                return
            self._entries[str(user_id)] = office_code
            self._save()
