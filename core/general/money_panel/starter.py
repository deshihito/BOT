# -*- coding: utf-8 -*-
"""新規ユーザーのスターター（初期体験の階段）の単一の置き場。

新規ユーザーの初期残高は 10 AGO しかないのに、経済コンテンツの
価格帯は数百〜数千 AGO から始まるため、入口で詰みやすかった。
マネーパネルに「スターターを受け取る」を1回だけ出し、受け取ると
スターター一式が付与される。受け取り済みは二度と表示しない。

このモジュールは受け取り状態の永続化だけを持ち、実際のコイン・
アイテム付与は cogs/money_panel.py が wallet / items の経路で行う。
保存は core/prison.py と同じ流儀（data/starter.json、環境変数
STARTER_DATA_PATH で変更可、バッチフラッシュ＋原子差し替え）。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from core.general.items.items import JST

logger = logging.getLogger(__name__)

#: スターターのコイン量（暫定）。確定式（仕様 S0）: 小型加工機の価格
#: ＋3,000 が目安。実測（tools/coin_distribution.py）後に確定する。
STARTER_COINS = 3000

#: スターターのスクラップ個数（暫定）。
STARTER_SCRAPS = 3
STARTER_SCRAP_ITEM = "scrap"

#: 残高がこの額未満のユーザーにだけ、概要へ短い導線を1行出す。
GUIDE_BALANCE_THRESHOLD = 1000

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _empty_state() -> dict[str, Any]:
    return {"users": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entry in users.items():
            if isinstance(entry, dict) and isinstance(entry.get("claimed_at"), str):
                state["users"][str(uid)] = {"claimed_at": entry["claimed_at"]}
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "starter.json"


def default_path() -> Path:
    return Path(os.environ.get("STARTER_DATA_PATH") or _DEFAULT_PATH)


class StarterStore:
    """スターターの受け取り状態（ユーザー単位）と JSON 保存。"""

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
        self._state = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return _empty_state()
        return _clean_state(raw)

    def flush(self) -> None:
        with self._lock:
            payload = copy.deepcopy(self._state)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("starter: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 状態
    def has_claimed(self, user_id: str) -> bool:
        with self._lock:
            return str(user_id) in self._state["users"]

    def try_claim(self, user_id: str, now: datetime | None = None) -> bool:
        """初回だけ True を返して受け取り済みにし、2回目以降は False。

        チェックと記録を同一ロックで行い、二重受け取りを防ぐ。
        """
        now = now or datetime.now(JST)
        with self._lock:
            key = str(user_id)
            if key in self._state["users"]:
                return False
            self._state["users"][key] = {
                "claimed_at": now.astimezone(JST).isoformat()}
            self._mark_dirty()
            return True

    def unclaim(self, user_id: str) -> None:
        """付与が失敗したときの巻き戻し用。"""
        with self._lock:
            if self._state["users"].pop(str(user_id), None) is not None:
                self._mark_dirty()
