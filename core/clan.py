# -*- coding: utf-8 -*-
"""チーム／クラン基盤 v1 の単一の置き場。

v1 の範囲:
- クランの作成（作成コストあり、名前の重複チェック）、参加・脱退・
  解散（解散はリーダーのみ）。所属は1人1クランまで
- 貢献ポイント: 所属中の経済活動（採掘・合成・ガチャ）で貯まる、
  コインとは別の換金不可ポイント。クラン内ランキングの元になる

v1 に入れないもの: 国庫との接続、クラン対抗戦、共有倉庫。
nation 機能とは混ぜない。

保存は data/clans.json（環境変数 CLAN_DATA_PATH で変更可）に
メモリ主体＋バッチフラッシュ＋原子差し替え。コインの支払いは
cogs/clan.py が wallet の CAS 経路で行う。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

from core.general.items import JST

logger = logging.getLogger(__name__)

#: クラン作成コスト（AGO、暫定）。
CREATE_COST = 10000

#: クラン名の最大長。
MAX_NAME_LENGTH = 20

#: transaction_history の理由コード。
HISTORY_REASON = "clan_create"

#: 貢献ポイント（活動別）。
POINTS_MINING = 5
POINTS_CRAFT = 5
POINTS_GACHA_PER_PULL = 1

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


class ClanError(Exception):
    """ユーザー向け文言を持つクランのエラー。"""


def normalize_name(name: str) -> str:
    """重複チェック用の正規化（NFKC＋小文字化＋空白圧縮）。"""
    normalized = unicodedata.normalize("NFKC", str(name)).strip().casefold()
    return " ".join(normalized.split())


def _empty_state() -> dict[str, Any]:
    return {"clans": {}, "user_clan": {}, "next_id": 1}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    clans = raw.get("clans")
    if isinstance(clans, dict):
        for clan_id, entry in clans.items():
            if not isinstance(entry, dict):
                continue
            members_raw = entry.get("members")
            members: dict[str, Any] = {}
            if isinstance(members_raw, dict):
                for uid, member in members_raw.items():
                    if not isinstance(member, dict):
                        continue
                    points = member.get("points")
                    members[str(uid)] = {
                        "joined_at": str(member.get("joined_at") or ""),
                        "points": int(points) if isinstance(points, int) and points > 0 else 0,
                    }
            if entry.get("leader") is not None and members:
                state["clans"][str(clan_id)] = {
                    "name": str(entry.get("name") or ""),
                    "leader": str(entry["leader"]),
                    "created_at": str(entry.get("created_at") or ""),
                    "members": members,
                }
    user_clan = raw.get("user_clan")
    if isinstance(user_clan, dict):
        for uid, clan_id in user_clan.items():
            if str(clan_id) in state["clans"] and str(uid) in state["clans"][str(clan_id)]["members"]:
                state["user_clan"][str(uid)] = str(clan_id)
    next_id = raw.get("next_id")
    if isinstance(next_id, int) and next_id > 0:
        state["next_id"] = next_id
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "clans.json"


def default_path() -> Path:
    return Path(os.environ.get("CLAN_DATA_PATH") or _DEFAULT_PATH)


class ClanStore:
    """クランと所属・貢献ポイントの状態と JSON 保存。"""

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
            logger.exception("clan: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 参照
    def clan_of(self, user_id: str) -> dict[str, Any] | None:
        """所属クランの写し（id つき）。未所属なら None。"""
        with self._lock:
            clan_id = self._state["user_clan"].get(str(user_id))
            if clan_id is None:
                return None
            return self.get(clan_id)

    def get(self, clan_id: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                return None
            result = copy.deepcopy(entry)
            result["id"] = str(clan_id)
            result["member_count"] = len(entry["members"])
            result["total_points"] = sum(
                int(m["points"]) for m in entry["members"].values())
            return result

    def list_clans(self) -> list[dict[str, Any]]:
        with self._lock:
            clans = [self.get(clan_id) for clan_id in self._state["clans"]]
            return sorted(
                (c for c in clans if c is not None),
                key=lambda c: (-c["total_points"], c["name"]))

    def members(self, clan_id: str) -> list[dict[str, Any]]:
        """メンバー一覧（貢献ポイント降順）。"""
        with self._lock:
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                return []
            result = [
                {"user_id": uid, **copy.deepcopy(member)}
                for uid, member in entry["members"].items()
            ]
            return sorted(result, key=lambda m: (-m["points"], m["user_id"]))

    def name_taken(self, name: str) -> bool:
        normalized = normalize_name(name)
        with self._lock:
            return any(
                normalize_name(entry["name"]) == normalized
                for entry in self._state["clans"].values())

    # ------------------------------------------------------------------ 変更
    def create(self, user_id: str, name: str,
               now: datetime | None = None) -> dict[str, Any]:
        """クランを作る。検証エラーは ClanError（状態は不変）。"""
        now = now or datetime.now(JST)
        name = str(name).strip()
        if not name:
            raise ClanError("クラン名を入力してください。")
        if len(name) > MAX_NAME_LENGTH:
            raise ClanError(f"クラン名は{MAX_NAME_LENGTH}文字までです。")
        uid = str(user_id)
        with self._lock:
            if uid in self._state["user_clan"]:
                raise ClanError("すでにクランに所属しています。")
            if self.name_taken(name):
                raise ClanError("その名前のクランはすでにあります。")
            clan_id = str(self._state["next_id"])
            self._state["next_id"] += 1
            stamp = now.astimezone(JST).isoformat()
            self._state["clans"][clan_id] = {
                "name": name,
                "leader": uid,
                "created_at": stamp,
                "members": {uid: {"joined_at": stamp, "points": 0}},
            }
            self._state["user_clan"][uid] = clan_id
            self._mark_dirty()
            return self.get(clan_id)

    def join(self, user_id: str, clan_id: str,
             now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(JST)
        uid = str(user_id)
        with self._lock:
            if uid in self._state["user_clan"]:
                raise ClanError("すでにクランに所属しています。")
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                raise ClanError("そのクランはありません。")
            entry["members"][uid] = {
                "joined_at": now.astimezone(JST).isoformat(), "points": 0}
            self._state["user_clan"][uid] = str(clan_id)
            self._mark_dirty()
            return self.get(str(clan_id))

    def leave(self, user_id: str) -> dict[str, Any]:
        """脱退する。リーダーは解散しないと脱退できない。"""
        uid = str(user_id)
        with self._lock:
            clan = self.clan_of(uid)
            if clan is None:
                raise ClanError("クランに所属していません。")
            if clan["leader"] == uid:
                raise ClanError(
                    "リーダーは脱退できません。解散してください。")
            entry = self._state["clans"][clan["id"]]
            del entry["members"][uid]
            del self._state["user_clan"][uid]
            self._mark_dirty()
            return clan

    def disband(self, user_id: str) -> dict[str, Any]:
        """解散する（リーダーのみ）。全員の所属が外れる。"""
        uid = str(user_id)
        with self._lock:
            clan = self.clan_of(uid)
            if clan is None:
                raise ClanError("クランに所属していません。")
            if clan["leader"] != uid:
                raise ClanError("解散できるのはリーダーだけです。")
            for member_id in list(clan["members"]):
                self._state["user_clan"].pop(member_id, None)
            del self._state["clans"][clan["id"]]
            self._mark_dirty()
            return clan

    # ------------------------------------------------------------------ 貢献
    def add_points(self, user_id: str, points: int) -> int:
        """所属中なら貢献ポイントを加え、加算後の値を返す。未所属は0。"""
        uid = str(user_id)
        with self._lock:
            clan_id = self._state["user_clan"].get(uid)
            if clan_id is None:
                return 0
            member = self._state["clans"][clan_id]["members"].get(uid)
            if member is None:
                return 0
            member["points"] = int(member["points"]) + int(points)
            self._mark_dirty()
            return int(member["points"])


_shared_store: ClanStore | None = None
_shared_lock = threading.Lock()


def shared_store() -> ClanStore:
    """プロセス共有の単一インスタンス（複数 cog が同じ状態を触るため）。"""
    global _shared_store
    if _shared_store is None:
        with _shared_lock:
            if _shared_store is None:
                _shared_store = ClanStore()
    return _shared_store


def award_points(user_id: str, points: int) -> None:
    """経済活動からの貢献フック。失敗しても呼び出し側に影響させない。"""
    try:
        if points:
            shared_store().add_points(str(user_id), int(points))
    except Exception:
        logger.exception("clan: 貢献ポイントの加算に失敗 user=%s", user_id)
