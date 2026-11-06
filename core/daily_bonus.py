"""デイリーボーナス（次期仕様 S6-1）の単一の置き場。

原典の毎日ボーナス相当。マネーパネルに未受取の間だけボタンが出て、
1日1回（JST日次）だけ受け取れる。受け取り済み日付をユーザーごとに
永続化するだけの小さなストアで、コインの支払いと宝箱の付与は
cogs 側（MoneyPanelCog）が wallet / items の経路で行う。

保存は data/daily_bonus.json（環境変数 DAILY_BONUS_DATA_PATH で変更可）
にメモリ主体＋バッチフラッシュ＋原子差し替え。
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

from core.general.items import JST

logger = logging.getLogger(__name__)

#: デイリーボーナスの額（AGO、暫定。S0 の実測で確定する）。
DAILY_BONUS_COINS = 300

#: 宝箱が付く確率（暫定）。
BOX_CHANCE = 0.20

#: 宝箱が付いたときのアイテムID。
BOX_ITEM_ID = "treasure_box"

#: transaction_history の理由コード。
HISTORY_REASON = "daily_bonus"

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _empty_state() -> dict[str, Any]:
    return {"claimed": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    claimed = raw.get("claimed")
    if isinstance(claimed, dict):
        for uid, day in claimed.items():
            if isinstance(day, str):
                state["claimed"][str(uid)] = day
    return state


def _default_path() -> Path:
    override = os.environ.get("DAILY_BONUS_DATA_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "data" / "daily_bonus.json"


class DailyBonusStore:
    """ユーザーごとの最終受け取り日（JST）を保持する。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _default_path()
        self._lock = threading.RLock()
        self._state = self._load()
        self._dirty = False
        self._events_since_flush = 0
        self._last_flush = time.monotonic()

    # ------------------------------------------------------------------ 永続化
    def _load(self) -> dict[str, Any]:
        try:
            with open(self.path, encoding="utf-8") as handle:
                return _clean_state(json.load(handle))
        except FileNotFoundError:
            return _empty_state()
        except (OSError, ValueError):
            logger.exception("daily_bonus: 状態ファイルの読み込みに失敗しました")
            return _empty_state()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._state)

    def flush(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            payload = copy.deepcopy(self._state)
            tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with open(tmp_path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False)
                os.replace(tmp_path, self.path)
            except OSError:
                logger.exception("daily_bonus: 状態ファイルの保存に失敗しました")
                return
            self._dirty = False
            self._events_since_flush = 0
            self._last_flush = time.monotonic()

    def _mark_dirty(self) -> None:
        self._dirty = True
        self._events_since_flush += 1
        if (self._events_since_flush >= FLUSH_EVERY_EVENTS
                or time.monotonic() - self._last_flush >= FLUSH_INTERVAL_SECONDS):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= FLUSH_INTERVAL_SECONDS:
            self.flush()

    # ------------------------------------------------------------------ 受け取り
    @staticmethod
    def _day(now: datetime | None) -> str:
        now = now or datetime.now(JST)
        return now.astimezone(JST).date().isoformat()

    def claimed_today(self, user_id: str, now: datetime | None = None) -> bool:
        with self._lock:
            return self._state["claimed"].get(str(user_id)) == self._day(now)

    def try_claim(self, user_id: str, now: datetime | None = None) -> bool:
        """今日分を未受取なら受け取り済みにして True を返す（原子的）。"""
        with self._lock:
            day = self._day(now)
            if self._state["claimed"].get(str(user_id)) == day:
                return False
            self._state["claimed"][str(user_id)] = day
            self._mark_dirty()
            return True

    def unclaim(self, user_id: str) -> None:
        """支払いに失敗したときの巻き戻し用。"""
        with self._lock:
            if self._state["claimed"].pop(str(user_id), None) is not None:
                self._mark_dirty()


_SHARED_STORE: DailyBonusStore | None = None
_SHARED_LOCK = threading.Lock()


def shared_store() -> DailyBonusStore:
    """プロセス内で1つのストアを共有する（cogs はこれを使う）。"""
    global _SHARED_STORE
    if _SHARED_STORE is None:
        with _SHARED_LOCK:
            if _SHARED_STORE is None:
                _SHARED_STORE = DailyBonusStore()
    return _SHARED_STORE
