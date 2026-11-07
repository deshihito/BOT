# -*- coding: utf-8 -*-
"""逮捕（prison）の単一の置き場。

原典（パンBot）の prison を AGO の仕様に載せたもの。発生条件は
原典に合わせ、ブロック範囲と期間はユーザーの定義（2026-11-06）に
従う:

- 逮捕時間は 30 分〜1 時間の帯に統一する（ユーザー指示 2026-11-06）。
  警棒の反撃と泥帽の失敗は 30 分、大警棒と大泥帽の失敗は 60 分
  （原典は警棒 5 分／泥帽 6 時間だったが、帯の指示で置き換えた）
- 逮捕中はマネージャンルの実行系アクションが一切できない（それ以外の
  機能は通常どおり）
- 脱獄（ユーザー検討を受けて Maxwell が設計、2026-11-06）: 逮捕中のみ
  マネーパネルから試みられる。10 分に 1 回まで、成功率 30% で成功すれば
  即時釈放、失敗すると残り時間が 10 分延びる（ただし逮捕開始から
  通算 60 分を超えない）

原典の prison_state はメモリ上の辞書で再起動で消えたが、AGO では
再起動耐性の方針（「切れても死なない」）に合わせ JSON に永続化する。
保存は core/general/circulation/steal.py と同じ流儀: 専用 JSON（既定 data/prison.json、
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
import random
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths
from core.general.items.items import JST

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 逮捕の期間（発生条件は cogs/circulation.py の steal 判定側）
# ユーザー指示（2026-11-06）で逮捕時間は 30 分〜1 時間の帯に統一した。
# ---------------------------------------------------------------------------

#: 警棒の反撃による逮捕（分）。
BATON_PRISON_MINUTES = 30

#: 大警棒の反撃による逮捕（分）。
DAI_BATON_PRISON_MINUTES = 60

#: 泥帽を使って失敗したときの逮捕（分）。
MUD_HAT_PRISON_MINUTES = 30

#: 大泥帽を使って失敗したときの逮捕（分）。
DAI_MUD_HAT_PRISON_MINUTES = 60

#: 逮捕の通算上限（分）。脱獄失敗の延長はこの上限を超えない。
MAX_PRISON_MINUTES = 60

# ---------------------------------------------------------------------------
# 脱獄（Maxwell の設計、2026-11-06）
# ---------------------------------------------------------------------------

#: 脱獄を試みられる間隔（分）。
JAILBREAK_INTERVAL_MINUTES = 10

#: 脱獄の成功率。
JAILBREAK_SUCCESS_RATE = 0.30

#: 脱獄に失敗したときに延びる残り時間（分）。通算上限つき。
JAILBREAK_FAIL_EXTRA_MINUTES = 10

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
                cleaned = {
                    "until": entry["until"],
                    "reason": str(entry.get("reason") or ""),
                }
                # 逮捕開始・通算上限・脱獄の試行状態（旧データには無い）。
                for key in ("since", "cap", "jb_next"):
                    if isinstance(entry.get(key), str):
                        cleaned[key] = entry[key]
                attempts = entry.get("jb_attempts")
                if isinstance(attempts, int) and attempts > 0:
                    cleaned["jb_attempts"] = attempts
                state["users"][str(uid)] = cleaned
    return state


_DEFAULT_PATH = data_paths.data_path("prison.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/prison.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(Path(__file__).resolve().parent.parent / "prison.py", "prison.json")  # 旧保存先は収納前の深さ基準のため1階層上を渡す


def default_path() -> Path:
    return Path(os.environ.get("PRISON_DATA_PATH") or _DEFAULT_PATH)


class PrisonStore(DirtyFlushMixin):
    """逮捕状態（ユーザー単位・解除時刻つき）と JSON 保存。"""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        rng: random.Random | None = None,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
        self._rng = rng if rng is not None else random.Random()
        self._flush_every = max(1, int(flush_every))
        self._flush_interval = float(flush_interval)
        self._lock = threading.RLock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._state = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, Any]:
        raw = self._read_raw()
        if raw is None:
            return _empty_state()
        return _clean_state(raw)

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする (旧パス主・正規パスはユーザー単位で補完。
        # 期限切れの逮捕記録は従来どおり lazy に掃除される)。環境変数や
        # 明示パスで保存先が指定されている場合は移行しない。
        if self._path == _DEFAULT_PATH:
            return data_paths.load_migrated(self._path, _STRAY_PATH, fill=True)
        return data_paths.read_json(self._path)

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
            key = str(user_id)
            current = self._until_locked(key, now)
            until = max(current, new_until) if current is not None else new_until
            entry = self._state["users"].get(key) or {}
            if current is None:
                # 新規の逮捕: 開始時刻と通算上限（脱獄延長の天井）を記録する。
                entry["since"] = now.astimezone(JST).isoformat()
                entry["cap"] = (
                    now + timedelta(minutes=MAX_PRISON_MINUTES)
                ).astimezone(JST).isoformat()
                entry.pop("jb_attempts", None)
                entry.pop("jb_next", None)
            entry["until"] = until.astimezone(JST).isoformat()
            entry["reason"] = str(reason)
            self._state["users"][key] = entry
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

    def release(self, user_id: str) -> bool:
        """逮捕を即時解除する（脱獄成功時）。解除したら True。"""
        with self._lock:
            if self._state["users"].pop(str(user_id), None) is None:
                return False
            self._mark_dirty()
            return True

    # ------------------------------------------------------------------ 脱獄
    def jailbreak_status(self, user_id: str,
                         now: datetime | None = None) -> dict[str, Any]:
        """表示用: 脱獄の試行回数・次に試せるまでの秒数。"""
        now = now or datetime.now(JST)
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            next_at = None
            raw_next = entry.get("jb_next")
            if isinstance(raw_next, str):
                try:
                    next_at = datetime.fromisoformat(raw_next)
                except ValueError:
                    next_at = None
            wait = 0.0
            if next_at is not None:
                wait = max(0.0, (next_at - now).total_seconds())
            return {
                "attempts": int(entry.get("jb_attempts") or 0),
                "next_at": next_at,
                "wait_seconds": wait,
                "can_attempt": wait <= 0,
            }

    def attempt_jailbreak(self, user_id: str,
                          now: datetime | None = None) -> dict[str, Any]:
        """脱獄を1回試みる。結果は outcome で返す。

        - "not_imprisoned": 逮捕されていない（ボタンは逮捕中しか出ない）
        - "cooldown": 前回の試行から間隔が空いていない（状態は不変）
        - "success": 即時釈放した
        - "failure": 残り時間が延びた（通算上限 MAX_PRISON_MINUTES まで）
        """
        now = now or datetime.now(JST)
        key = str(user_id)
        with self._lock:
            until = self._until_locked(key, now)
            if until is None:
                return {"outcome": "not_imprisoned"}
            jb = self.jailbreak_status(key, now)
            if not jb["can_attempt"]:
                return {
                    "outcome": "cooldown",
                    "wait_seconds": jb["wait_seconds"],
                    "attempts": jb["attempts"],
                }
            entry = self._state["users"][key]
            entry["jb_attempts"] = jb["attempts"] + 1
            entry["jb_next"] = (
                now + timedelta(minutes=JAILBREAK_INTERVAL_MINUTES)
            ).astimezone(JST).isoformat()
            attempts = entry["jb_attempts"]
            if self._rng.random() < JAILBREAK_SUCCESS_RATE:
                del self._state["users"][key]
                self._mark_dirty()
                return {"outcome": "success", "attempts": attempts}
            cap = None
            raw_cap = entry.get("cap")
            if isinstance(raw_cap, str):
                try:
                    cap = datetime.fromisoformat(raw_cap)
                except ValueError:
                    cap = None
            new_until = until + timedelta(minutes=JAILBREAK_FAIL_EXTRA_MINUTES)
            if cap is not None:
                new_until = min(new_until, cap)
            new_until = max(new_until, until)
            entry["until"] = new_until.astimezone(JST).isoformat()
            self._mark_dirty()
            return {
                "outcome": "failure",
                "attempts": attempts,
                "remaining": max(0.0, (new_until - now).total_seconds()),
                "until": new_until,
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
