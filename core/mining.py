# -*- coding: utf-8 -*-
"""採掘（mining 再仕様）の単一の置き場。

パンBot 資産移植 Phase 4（構成案 第4層）。原典の mining は短い
クールダウンでコインが直接湧くボタンだった。再仕様では主産物を
Phase 2/3 の合成素材（スクラップ／金属片、レアで回路片）に寄せ、
コインは副産物として小さく抑える。新規創出は「日次グローバル供給
キャップ（コイン・素材それぞれ）＋個人の1日回数上限」で縛り、
キャップに達した資源はその日は産出ゼロになる（状態として明示する）。

保存は core/workshop.py と同じ流儀: 専用 JSON（既定 data/mining.json、
環境変数 MINING_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。素材の実増減は ItemStore 経由、コインの実移動は
呼び出し側（cogs/circulation.py）が wallet の安全な経路で行う。
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

from core.items import ITEM_DEFS, JST, ItemError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（Phase 4 の暫定値。価格・上限の絶対値は AGO のコイン分布の
# 実測後に調整する）
# ---------------------------------------------------------------------------

#: 採掘のクールダウン（秒）。原典の60秒はグローバル規模では連打に
#: なるため1時間に伸ばす。
COOLDOWN_SECONDS = 3600

#: 1人あたりの1日の採掘回数上限。
DAILY_USER_LIMIT = 10

#: 1日に全ユーザー合計で新規創出してよいコイン副産物の上限（AGO）。
DAILY_GLOBAL_COIN_CAP = 50_000

#: 1日に全ユーザー合計で新規創出してよい素材の上限（個数）。
DAILY_GLOBAL_MATERIAL_CAP = 20_000

#: 採掘1回の産出テーブル: (素材 {item_id: 個数}, コイン副産物, 重み)。
#: 主産物は素材で、コインは一部の行にだけ付く小さな副産物に抑える。
#: 期待値: 素材 約2.0個/回、コイン 約4 AGO/回（上限まで掘っても
#: 1人あたり素材 約20個・コイン 約40 AGO/日 が期待値ベースの目安）。
YIELD_TABLE: tuple[tuple[dict[str, int], int, int], ...] = (
    ({"scrap": 2}, 0, 40),
    ({"scrap": 3}, 0, 25),
    ({"metal_piece": 1}, 0, 20),
    ({"metal_piece": 1, "scrap": 1}, 30, 8),
    ({"circuit_piece": 1}, 0, 5),
    ({"scrap": 2}, 80, 2),
)

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _empty_state() -> dict[str, Any]:
    return {"users": {}, "daily": {"date": None, "coins": 0, "materials": 0}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entry in users.items():
            if not isinstance(entry, dict):
                continue
            last = entry.get("last")
            day = entry.get("day")
            count = entry.get("count")
            state["users"][str(uid)] = {
                "last": last if isinstance(last, str) else None,
                "day": day if isinstance(day, str) else None,
                "count": int(count) if isinstance(count, int) and count > 0 else 0,
            }
    daily = raw.get("daily")
    if isinstance(daily, dict):
        date = daily.get("date")
        coins = daily.get("coins")
        materials = daily.get("materials")
        state["daily"] = {
            "date": date if isinstance(date, str) else None,
            "coins": int(coins) if isinstance(coins, int) and coins > 0 else 0,
            "materials": int(materials) if isinstance(materials, int) and materials > 0 else 0,
        }
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "mining.json"


def default_path() -> Path:
    return Path(os.environ.get("MINING_DATA_PATH") or _DEFAULT_PATH)


class MiningStore:
    """採掘のクールダウン・個人回数・日次グローバル供給量と JSON 保存。"""

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
            logger.exception("mining: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 状態参照
    def _user_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(
            str(user_id), {"last": None, "day": None, "count": 0})

    def _daily_locked(self, today: str) -> dict[str, Any]:
        daily = self._state["daily"]
        if daily["date"] != today:
            daily = {"date": today, "coins": 0, "materials": 0}
            self._state["daily"] = daily
        return daily

    def _cooldown_remaining_locked(self, user: dict[str, Any], now: datetime) -> float:
        if not user["last"]:
            return 0.0
        try:
            last = datetime.fromisoformat(user["last"])
        except ValueError:
            return 0.0
        return max(0.0, COOLDOWN_SECONDS - (now - last).total_seconds())

    def status(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """表示用: クールダウン残り・今日の回数・グローバル供給の残量。"""
        now = now or datetime.now(JST)
        today = now.date().isoformat()
        with self._lock:
            user = self._user_locked(str(user_id))
            daily = self._daily_locked(today)
            count = int(user["count"]) if user["day"] == today else 0
            return {
                "cooldown_remaining": self._cooldown_remaining_locked(user, now),
                "today_count": count,
                "daily_limit": DAILY_USER_LIMIT,
                "global_coins_remaining": max(
                    0, DAILY_GLOBAL_COIN_CAP - int(daily["coins"])),
                "global_materials_remaining": max(
                    0, DAILY_GLOBAL_MATERIAL_CAP - int(daily["materials"])),
            }

    # ------------------------------------------------------------------ 採掘
    def _roll_yield(self) -> tuple[dict[str, int], int]:
        total = sum(weight for _items, _coins, weight in YIELD_TABLE)
        pick = self._rng.random() * total
        cumulative = 0.0
        for items, coins, weight in YIELD_TABLE:
            cumulative += weight
            if pick < cumulative:
                return dict(items), int(coins)
        items, coins, _w = YIELD_TABLE[-1]
        return dict(items), int(coins)

    def dig(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """採掘を1回実行し、確定した産出を返す（記録まで済ませる）。

        クールダウン中・個人の回数上限は ItemError（状態は不変）。
        グローバル供給キャップに達した資源は産出が0に clamp され、
        両方の資源が尽きている場合は ItemError で明示する。
        コインの実移動が呼び出し側で失敗した場合は rollback_dig で戻す。
        戻り値: {"items": {item_id: 個数}, "coins": int,
                 "user_before": ..., "daily_before": ...}（後2つは rollback 用）
        """
        now = now or datetime.now(JST)
        today = now.date().isoformat()
        uid = str(user_id)
        with self._lock:
            user = self._user_locked(uid)
            user_before = copy.deepcopy(user)
            daily = self._daily_locked(today)
            daily_before = copy.deepcopy(daily)
            remaining = self._cooldown_remaining_locked(user, now)
            if remaining > 0:
                minutes = int(remaining // 60) + (1 if remaining % 60 else 0)
                raise ItemError(f"採掘は1時間に1回までです。あと約{minutes}分で掘れます。")
            count = int(user["count"]) if user["day"] == today else 0
            if count >= DAILY_USER_LIMIT:
                raise ItemError(
                    f"今日の採掘は上限（{DAILY_USER_LIMIT}回）に達しています。")
            coins_room = DAILY_GLOBAL_COIN_CAP - int(daily["coins"])
            materials_room = DAILY_GLOBAL_MATERIAL_CAP - int(daily["materials"])
            if coins_room <= 0 and materials_room <= 0:
                raise ItemError(
                    "本日の全体の産出上限に達しています。明日また掘れます。")
            items, coins = self._roll_yield()
            coins = max(0, min(coins, coins_room))
            granted: dict[str, int] = {}
            budget = max(0, materials_room)
            for item_id, amount in items.items():
                take = min(int(amount), budget)
                if take > 0:
                    granted[item_id] = take
                    budget -= take
            total_materials = sum(granted.values())
            user["last"] = now.astimezone(JST).isoformat()
            user["day"] = today
            user["count"] = count + 1
            daily["coins"] = int(daily["coins"]) + coins
            daily["materials"] = int(daily["materials"]) + total_materials
            self._mark_dirty()
            return {
                "items": granted, "coins": coins,
                "user_before": user_before, "daily_before": daily_before,
            }

    def rollback_dig(self, user_id: str, result: dict[str, Any]) -> None:
        """dig の巻き戻し（コインの実移動に失敗したとき用）。"""
        with self._lock:
            self._state["users"][str(user_id)] = copy.deepcopy(result["user_before"])
            self._state["daily"] = copy.deepcopy(result["daily_before"])
            self._mark_dirty()
