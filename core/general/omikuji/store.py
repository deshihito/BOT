# -*- coding: utf-8 -*-
"""おみくじの日次結果ストア。

1日1回（ユーザー×ギルド、JST日次）を保証するため、その日の結果を
専用 JSON（既定 data/omikuji.json、環境変数 OMIKUJI_DATA_PATH で変更可）
に保存する。保存の流儀は core/game/lottery.py と同じ：メモリ主体＋
原子差し替え。キーは (ギルド, ユーザー) で値は最新日の分だけを保持する
ため、ファイルはユーザー数に対して頭打ちになる。

抽選自体も (ギルド, ユーザー, 日付) のシードで決定的に行うため、
万一保存に失敗しても同日内は同じ結果が再現される。

例外：UNLIMITED_USER_IDS のユーザー（ユーザー本人）は回数制限の
対象外で、保存も固定もせず毎回新規に抽選する。
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from core.support import data_paths

from .fortunes import Fortune, draw_fortune, seeded_rng

logger = logging.getLogger(__name__)

#: おみくじの日次境界は JST 固定（他機能の JST 定数と同じ定義）。
JST = timezone(timedelta(hours=9))

_DEFAULT_PATH = data_paths.data_path("omikuji.json")

#: 回数制限（1日1回）の対象外ユーザー（ユーザー本人）。
#: このユーザーは毎回新規に抽選し、その日の固定結果には縛られない。
UNLIMITED_USER_IDS = frozenset({1320705325686587408})


def is_unlimited_user(user_id: int) -> bool:
    """回数制限の対象外ユーザーかどうか。"""
    return user_id in UNLIMITED_USER_IDS


def jst_day(now: datetime | None = None) -> str:
    """JST の今日を 'YYYY-MM-DD' で返す。"""
    return (now or datetime.now(JST)).astimezone(JST).strftime("%Y-%m-%d")


class OmikujiStore:
    """その日のおみくじ結果を保持するストア。"""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = os.environ.get("OMIKUJI_DATA_PATH") or _DEFAULT_PATH
        self._path = Path(path)
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = self._load()

    def _load(self) -> dict[str, dict[str, Any]]:
        raw = data_paths.read_json(self._path)
        if isinstance(raw, dict) and isinstance(raw.get("entries"), dict):
            return {str(k): v for k, v in raw["entries"].items()
                    if isinstance(v, dict)}
        return {}

    def _save(self) -> None:
        payload = {"version": 1, "entries": self._entries}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            # 保存に失敗しても抽選はシードで再現できるため、機能は止めない。
            logger.exception("omikuji: 結果の保存に失敗しました path=%s", self._path)

    @staticmethod
    def _key(guild_id: int, user_id: int) -> str:
        return f"{guild_id}:{user_id}"

    def get_or_draw(
        self, guild_id: int, user_id: int, day: str | None = None,
    ) -> tuple[Fortune, bool]:
        """今日の結果を返す。未抽選なら抽選して保存する。

        戻り値は (結果, 今回新規に引いたか)。同日内は保存済みの結果を
        そのまま返すため、再表示でも画像内容は変わらない。
        """
        day = day or jst_day()
        if is_unlimited_user(user_id):
            # 回数制限の対象外：結果は保存せず、毎回まっさらから抽選する。
            return draw_fortune(random.Random()), True
        key = self._key(guild_id, user_id)
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry.get("date") == day:
                try:
                    return Fortune.from_dict(entry["fortune"]), False
                except (KeyError, TypeError, ValueError, IndexError):
                    logger.warning("omikuji: 保存済み結果が壊れています key=%s", key)
            fortune = draw_fortune(seeded_rng(guild_id, user_id, day))
            self._entries[key] = {"date": day, "fortune": fortune.to_dict()}
            self._save()
            return fortune, True
