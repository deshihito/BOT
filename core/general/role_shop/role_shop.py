# -*- coding: utf-8 -*-
"""有期限ロールショップの単一の置き場。

原典（パンBot）のロールショップは固定の商品棚だったが、ロールは
ギルド固有のため AGO では「ギルド管理者が自ギルドのロールを商品と
して登録する」形にした:

- 商品（ロール・価格・期間）の保存はギルド単位で core/support/guild_settings.py
  の section "role_shop" に置く（このモジュールはその dict の読み書き
  ヘルパーだけを持つ）
- 購入で付与したロールの期限はこのモジュールの RoleShopStore が
  data/role_shop.json に持ち、期限切れは lazy 判定＋定期スイープで
  剥奪する（「切れても死なない」方針: 再起動しても期限は残る）

コインの支払いとロールの付け外しは cogs/role_shop.py が担う。
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

from core.general.items.items import JST

logger = logging.getLogger(__name__)

#: guild_settings の section 名。
SECTION = "role_shop"

#: 1ギルドに登録できる商品の上限。
MAX_ITEMS_PER_GUILD = 10

#: 期間（日数）の範囲。
MIN_DAYS = 1
MAX_DAYS = 365

#: 価格（AGO）の下限。
MIN_PRICE = 1

#: transaction_history の理由コード。
HISTORY_REASON = "role_buy"

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


class RoleShopError(Exception):
    """ユーザー向け文言を持つロールショップのエラー。"""


# ---------------------------------------------------------------------------
# 商品（guild_settings の section dict に対する純粋ヘルパー）
# ---------------------------------------------------------------------------

def products(section: dict | None) -> list[dict[str, Any]]:
    """登録済み商品を価格順に返す（壊れたエントリは読み飛ばす）。"""
    items = (section or {}).get("items")
    if not isinstance(items, dict):
        return []
    result = []
    for role_id, entry in items.items():
        if not isinstance(entry, dict):
            continue
        try:
            result.append({
                "role_id": int(role_id),
                "price": int(entry["price"]),
                "days": int(entry["days"]),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(result, key=lambda p: (p["price"], p["role_id"]))


def find_product(section: dict | None, role_id: int) -> dict[str, Any] | None:
    for product in products(section):
        if product["role_id"] == int(role_id):
            return product
    return None


def with_product(section: dict | None, role_id: int, price: int,
                 days: int) -> dict[str, Any]:
    """商品を登録/更新した新しい section dict を返す（検証つき）。"""
    price = int(price)
    days = int(days)
    if price < MIN_PRICE:
        raise RoleShopError(f"価格は {MIN_PRICE:,} AGO 以上にしてください。")
    if not MIN_DAYS <= days <= MAX_DAYS:
        raise RoleShopError(f"期間は {MIN_DAYS}〜{MAX_DAYS} 日で指定してください。")
    current = products(section)
    if (find_product(section, role_id) is None
            and len(current) >= MAX_ITEMS_PER_GUILD):
        raise RoleShopError(
            f"登録できる商品は {MAX_ITEMS_PER_GUILD} 件までです。")
    items = dict((section or {}).get("items") or {})
    items[str(int(role_id))] = {"price": price, "days": days}
    return {"items": items}


def without_product(section: dict | None, role_id: int) -> dict[str, Any]:
    items = dict((section or {}).get("items") or {})
    items.pop(str(int(role_id)), None)
    return {"items": items}


# ---------------------------------------------------------------------------
# 付与の期限管理
# ---------------------------------------------------------------------------

def _empty_state() -> dict[str, Any]:
    return {"grants": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    grants = raw.get("grants")
    if isinstance(grants, dict):
        for gid, users in grants.items():
            if not isinstance(users, dict):
                continue
            cleaned_users: dict[str, Any] = {}
            for uid, roles in users.items():
                if not isinstance(roles, dict):
                    continue
                cleaned_roles = {
                    str(rid): until for rid, until in roles.items()
                    if isinstance(until, str)
                }
                if cleaned_roles:
                    cleaned_users[str(uid)] = cleaned_roles
            if cleaned_users:
                state["grants"][str(gid)] = cleaned_users
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "role_shop.json"


def default_path() -> Path:
    return Path(os.environ.get("ROLE_SHOP_DATA_PATH") or _DEFAULT_PATH)


class RoleShopStore:
    """ショップで付与したロールの期限（ギルド×ユーザー×ロール）と保存。"""

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
            logger.exception("role_shop: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 期限
    def grant(self, guild_id: int, user_id: int, role_id: int, days: int,
              now: datetime | None = None) -> datetime:
        """付与（再購入は現在の期限から延長）し、新しい期限を返す。"""
        now = now or datetime.now(JST)
        with self._lock:
            current = self._active_until_locked(guild_id, user_id, role_id, now)
            base = current if current is not None else now
            until = base + timedelta(days=int(days))
            users = self._state["grants"].setdefault(str(guild_id), {})
            roles = users.setdefault(str(user_id), {})
            roles[str(role_id)] = until.astimezone(JST).isoformat()
            self._mark_dirty()
            return until

    def _active_until_locked(self, guild_id: int, user_id: int, role_id: int,
                             now: datetime) -> datetime | None:
        roles = (
            self._state["grants"].get(str(guild_id), {})
            .get(str(user_id), {}))
        raw = roles.get(str(role_id))
        if not isinstance(raw, str):
            return None
        try:
            until = datetime.fromisoformat(raw)
        except ValueError:
            return None
        if until <= now:
            self.remove(guild_id, user_id, role_id)
            return None
        return until

    def active_until(self, guild_id: int, user_id: int, role_id: int,
                     now: datetime | None = None) -> datetime | None:
        now = now or datetime.now(JST)
        with self._lock:
            return self._active_until_locked(guild_id, user_id, role_id, now)

    def remove(self, guild_id: int, user_id: int, role_id: int) -> bool:
        with self._lock:
            users = self._state["grants"].get(str(guild_id), {})
            roles = users.get(str(user_id), {})
            if str(role_id) not in roles:
                return False
            del roles[str(role_id)]
            if not roles:
                users.pop(str(user_id), None)
            if not users:
                self._state["grants"].pop(str(guild_id), None)
            self._mark_dirty()
            return True

    def expired(self, now: datetime | None = None) -> list[tuple[int, int, int]]:
        """期限切れの (guild_id, user_id, role_id) を返す（記録は消さない）。"""
        now = now or datetime.now(JST)
        result: list[tuple[int, int, int]] = []
        with self._lock:
            for gid, users in self._state["grants"].items():
                for uid, roles in users.items():
                    for rid, raw in roles.items():
                        try:
                            until = datetime.fromisoformat(raw)
                        except (TypeError, ValueError):
                            until = None
                        if until is None or until <= now:
                            result.append((int(gid), int(uid), int(rid)))
        return result

    def grants_of_user(self, guild_id: int, user_id: int,
                       now: datetime | None = None) -> dict[int, datetime]:
        """そのユーザーの有効な付与 {role_id: until}（期限切れは lazy に消す）。"""
        now = now or datetime.now(JST)
        with self._lock:
            roles = dict(
                self._state["grants"].get(str(guild_id), {})
                .get(str(user_id), {}))
            result: dict[int, datetime] = {}
            for rid in roles:
                until = self._active_until_locked(
                    guild_id, user_id, int(rid), now)
                if until is not None:
                    result[int(rid)] = until
            return result
