# -*- coding: utf-8 -*-
"""逮捕（prison）の単一の置き場。

原典（パンBot）の prison を AGO の仕様に載せたもの。発生条件と期間は
原典に合わせ、ブロック範囲はユーザーの定義（2026-11-06）に従う:

- 警棒で撃退された steal の実行者は 5 分間逮捕される（原典どおり）
- 泥帽を使って steal に失敗した実行者は 6 時間逮捕される（原典どおり）
- 大警棒／大泥帽は原典では効果未実装だったため、段階を保って AGO で
  新規に決めた（大警棒: 30 分／大泥帽の失敗: 12 時間）
- 逮捕中はマネージャンルの実行系アクションが一切できない（それ以外の
  機能は通常どおり）。原典には保釈のような解除手段は無く、解除は
  時間経過のみ

原典の prison_state はメモリ上の辞書で再起動で消えたが、AGO では
再起動耐性の方針（「切れても死なない」）に合わせ JSON に永続化する。
保存は core/steal.py と同じ流儀: 専用 JSON（既定 data/prison.json、
環境変数 PRISON_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。期限切れは読み取り時に lazy に解除する。

ブロックの適用は二層: /general の dispatch 入口（マネージャンルの
実行系アクション）と、各 cog の execute_* の先頭（マネーパネル経由や
パネル内ボタンなど dispatch を通らない実行も漏れないように）。
表示専用（残高・ランキング・パネルを開くこと）は逮捕中でも可能。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from core.items import JST

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 逮捕の期間（発生条件は cogs/circulation.py の steal 判定側）
# ---------------------------------------------------------------------------

#: 警棒の反撃による逮捕（分）。原典どおり。
BATON_PRISON_MINUTES = 5

#: 大警棒の反撃による逮捕（分）。原典未実装のため AGO で新規設定。
DAI_BATON_PRISON_MINUTES = 30

#: 泥帽を使って失敗したときの逮捕（時間）。原典どおり。
MUD_HAT_PRISON_HOURS = 6

#: 大泥帽を使って失敗したときの逮捕（時間）。原典未実装のため AGO で新規設定。
DAI_MUD_HAT_PRISON_HOURS = 12

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
            if isinstance(entry, dict) and isinstance(entry.get("until"), str):
                state["users"][str(uid)] = {
                    "until": entry["until"],
                    "reason": str(entry.get("reason") or ""),
                }
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "prison.json"


def default_path() -> Path:
    return Path(os.environ.get("PRISON_DATA_PATH") or _DEFAULT_PATH)


class PrisonStore:
    """逮捕状態（ユーザー単位・解除時刻つき）と JSON 保存。"""

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
            logger.exception("prison: 状態の保存に失敗しました path=%s", self._path)

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
    def _until_locked(self, user_id: str, now: datetime) -> datetime | None:
        """有効な解除時刻を返す（期限切れは lazy に消して None）。"""
        entry = self._state["users"].get(str(user_id))
        if entry is None:
            return None
        try:
            until = datetime.fromisoformat(entry["until"])
        except (TypeError, ValueError):
            until = None
        if until is None or until <= now:
            del self._state["users"][str(user_id)]
            self._mark_dirty()
            return None
        return until

    def imprison(self, user_id: str, *, minutes: float = 0.0, hours: float = 0.0,
                 reason: str = "", now: datetime | None = None) -> datetime:
        """ユーザーを逮捕し、解除時刻を返す。

        既に逮捕中の場合は短くならないよう、遅い方の解除時刻を採用する
        （原典は単純上書きだったが、連続発生で釈放が早まるのは不自然な
        ため AGO では延長方向にのみ揃える）。
        """
        now = now or datetime.now(JST)
        new_until = now + timedelta(minutes=float(minutes), hours=float(hours))
        with self._lock:
            current = self._until_locked(str(user_id), now)
            until = max(current, new_until) if current is not None else new_until
            self._state["users"][str(user_id)] = {
                "until": until.astimezone(JST).isoformat(),
                "reason": str(reason),
            }
            self._mark_dirty()
            return until

    def is_imprisoned(self, user_id: str, now: datetime | None = None) -> bool:
        now = now or datetime.now(JST)
        with self._lock:
            return self._until_locked(str(user_id), now) is not None

    def remaining_seconds(self, user_id: str, now: datetime | None = None) -> float:
        now = now or datetime.now(JST)
        with self._lock:
            until = self._until_locked(str(user_id), now)
            if until is None:
                return 0.0
            return max(0.0, (until - now).total_seconds())

    def status(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """表示用: 逮捕中かどうかと残り秒数・解除時刻。"""
        now = now or datetime.now(JST)
        with self._lock:
            until = self._until_locked(str(user_id), now)
            if until is None:
                return {"imprisoned": False, "remaining": 0.0, "until": None}
            return {
                "imprisoned": True,
                "remaining": max(0.0, (until - now).total_seconds()),
                "until": until,
            }


_shared_store: PrisonStore | None = None
_shared_lock = threading.Lock()


def shared_store() -> PrisonStore:
    """プロセス共有の単一インスタンス（複数 cog が同じ状態を触るため）。"""
    global _shared_store
    if _shared_store is None:
        with _shared_lock:
            if _shared_store is None:
                _shared_store = PrisonStore()
    return _shared_store


def format_remaining(seconds: float) -> str:
    """残り時間の表示（分未満は「1分未満」、時間超は小数1桁の時間）。"""
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return "1分未満"
    minutes = int(seconds // 60) + (1 if seconds % 60 else 0)
    if minutes >= 60:
        return f"約{minutes / 60:.1f}時間"
    return f"約{minutes}分"


def block_message(user_id: str, now: datetime | None = None,
                  store: PrisonStore | None = None) -> str | None:
    """逮捕中ならマネー系操作の拒否文を返し、自由なら None を返す。

    dispatch 入口と各 cog の execute_* の両方から使う一元チェック。
    """
    store = store if store is not None else shared_store()
    remaining = store.remaining_seconds(str(user_id), now)
    if remaining <= 0:
        return None
    return (
        f"🚔 逮捕中です（釈放まであと{format_remaining(remaining)}）。"
        "マネー系の操作はできません。"
    )
