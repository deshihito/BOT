# -*- coding: utf-8 -*-
"""チーム／クラン基盤の単一の置き場。

範囲:
- クランの作成（作成コストあり、名前の重複チェック）、参加・脱退・
  解散（解散はリーダーのみ）。所属は1人1クランまで
- 貢献ポイント: 所属中の経済活動（採掘・合成・ガチャ）で貯まる、
  コインとは別の換金不可ポイント。クラン内ランキングの元になる
- クランレベル（次期仕様 S2）: レベルは累計貢献ポイント（脱退・解散で
  減らない単調増加の累計）から導出し、定員拡張と実績表示を解放する
- 原典チーム機能の残り（次期仕様 S6-5）: 招待コード参加、改名、
  追放／脱退の再参加クールダウン、クランボーナス（日次・宝箱）

入れないもの: 国庫との接続、クラン対抗戦、共有倉庫、月次1位チーム
への専用ロール付与（設計のみ）。nation 機能とは混ぜない。

保存は data/clans.json（環境変数 CLAN_DATA_PATH で変更可）に
メモリ主体＋バッチフラッシュ＋原子差し替え。コインの支払いは
cogs/clan.py が wallet の CAS 経路で行う。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import secrets
import threading
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from core.general.items.items import JST
from core.store_flush import DirtyFlushMixin

logger = logging.getLogger(__name__)

#: クラン作成コスト（AGO、暫定）。確定式（仕様 S0）: 残高 p90 の
#: 20〜30%。実測（tools/coin_distribution.py）後に確定する。
CREATE_COST = 10000

#: 改名コスト（AGO、暫定。次期仕様 S6-5）。
RENAME_COST = 1000

#: クラン名の最大長。
MAX_NAME_LENGTH = 20

#: transaction_history の理由コード。
HISTORY_REASON = "clan_create"
HISTORY_REASON_RENAME = "clan_rename"

#: 貢献ポイント（活動別）。
POINTS_MINING = 5
POINTS_CRAFT = 5
POINTS_GACHA_PER_PULL = 1

#: 貢献の活動種別（実績表示用カウンタのキー）。
ACTIVITIES = ("mining", "craft", "gacha")

#: クランレベル表（次期仕様 S2）: (レベル, 必要累計貢献, 定員)。
#: レベルは保存せず、累計貢献ポイントから導出する。
LEVEL_TABLE: tuple[tuple[int, int, int], ...] = (
    (1, 0, 10),
    (2, 500, 15),
    (3, 2000, 20),
    (4, 5000, 30),
    (5, 12000, 50),
)

#: 実績表示（総採掘回数など）が解放されるレベル。
STATS_LEVEL = 3

#: 追放された相手の再参加クールダウン（日。原典準拠、S6-5）。
KICK_COOLDOWN_DAYS = 3

#: 脱退した本人の再参加クールダウン（日。原典準拠、S6-5）。
LEAVE_COOLDOWN_DAYS = 5

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def level_for(points: int) -> int:
    """累計貢献ポイントからクランレベルを導出する。"""
    points = int(points)
    level = LEVEL_TABLE[0][0]
    for lv, required, _cap in LEVEL_TABLE:
        if points >= required:
            level = lv
    return level


def member_cap_for(points: int) -> int:
    """累計貢献ポイントからそのレベルの定員を返す。"""
    level = level_for(points)
    for lv, _required, cap in LEVEL_TABLE:
        if lv == level:
            return cap
    return LEVEL_TABLE[0][2]


def next_level_requirement(points: int) -> int | None:
    """次のレベルに必要な累計貢献。最大レベルなら None。"""
    level = level_for(points)
    for lv, required, _cap in LEVEL_TABLE:
        if lv == level + 1:
            return required
    return None


def _new_invite_code(clan_id: str) -> str:
    """招待コード（クランIDベース＋推測できない接尾辞）。"""
    return f"{clan_id}-{secrets.token_hex(3).upper()}"


class ClanError(Exception):
    """ユーザー向け文言を持つクランのエラー。"""


def normalize_name(name: str) -> str:
    """重複チェック用の正規化（NFKC＋小文字化＋空白圧縮）。"""
    normalized = unicodedata.normalize("NFKC", str(name)).strip().casefold()
    return " ".join(normalized.split())


def _empty_state() -> dict[str, Any]:
    return {"clans": {}, "user_clan": {}, "next_id": 1,
            "cooldowns": {}, "bonus_claims": {}}


def _clean_stats(raw: Any) -> dict[str, int]:
    stats = {activity: 0 for activity in ACTIVITIES}
    if isinstance(raw, dict):
        for activity in ACTIVITIES:
            value = raw.get(activity)
            if isinstance(value, int) and value > 0:
                stats[activity] = value
    return stats


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
                total = entry.get("total_points")
                announced = entry.get("level_announced")
                state["clans"][str(clan_id)] = {
                    "name": str(entry.get("name") or ""),
                    "leader": str(entry["leader"]),
                    "created_at": str(entry.get("created_at") or ""),
                    "members": members,
                    # 累計貢献（単調増加）。旧データではメンバー合計で初期化。
                    "total_points": (
                        int(total) if isinstance(total, int) and total > 0
                        else sum(m["points"] for m in members.values())),
                    "stats": _clean_stats(entry.get("stats")),
                    "invite_code": str(entry.get("invite_code") or ""),
                    "level_announced": (
                        int(announced) if isinstance(announced, int)
                        and announced > 0 else 1),
                }
    user_clan = raw.get("user_clan")
    if isinstance(user_clan, dict):
        for uid, clan_id in user_clan.items():
            if str(clan_id) in state["clans"] and str(uid) in state["clans"][str(clan_id)]["members"]:
                state["user_clan"][str(uid)] = str(clan_id)
    next_id = raw.get("next_id")
    if isinstance(next_id, int) and next_id > 0:
        state["next_id"] = next_id
    cooldowns = raw.get("cooldowns")
    if isinstance(cooldowns, dict):
        for uid, entry in cooldowns.items():
            if isinstance(entry, dict) and isinstance(entry.get("until"), str):
                state["cooldowns"][str(uid)] = {
                    "until": entry["until"],
                    "kind": str(entry.get("kind") or ""),
                }
    bonus_claims = raw.get("bonus_claims")
    if isinstance(bonus_claims, dict):
        for uid, day in bonus_claims.items():
            if isinstance(day, str):
                state["bonus_claims"][str(uid)] = day
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "clans.json"


def default_path() -> Path:
    return Path(os.environ.get("CLAN_DATA_PATH") or _DEFAULT_PATH)


class ClanStore(DirtyFlushMixin):
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
            # 累計貢献は保存値（単調増加）。レベルと定員はここから導出する。
            total = int(entry.get("total_points") or 0)
            result["total_points"] = total
            result["level"] = level_for(total)
            result["member_cap"] = member_cap_for(total)
            result["next_level_requirement"] = next_level_requirement(total)
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

    def name_taken(self, name: str, *, exclude_clan_id: str | None = None) -> bool:
        normalized = normalize_name(name)
        with self._lock:
            return any(
                normalize_name(entry["name"]) == normalized
                for clan_id, entry in self._state["clans"].items()
                if exclude_clan_id is None or clan_id != str(exclude_clan_id))

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
                "total_points": 0,
                "stats": {activity: 0 for activity in ACTIVITIES},
                "invite_code": _new_invite_code(clan_id),
                "level_announced": 1,
            }
            self._state["user_clan"][uid] = clan_id
            self._mark_dirty()
            return self.get(clan_id)

    # ------------------------------------------------------------------ 再参加クールダウン
    def _cooldown_remaining_locked(self, user_id: str, now: datetime) -> float:
        entry = self._state["cooldowns"].get(str(user_id))
        if entry is None:
            return 0.0
        try:
            until = datetime.fromisoformat(entry["until"])
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, (until - now).total_seconds())

    def _set_cooldown_locked(self, user_id: str, days: int, kind: str,
                             now: datetime) -> None:
        self._state["cooldowns"][str(user_id)] = {
            "until": (now + timedelta(days=days)).astimezone(JST).isoformat(),
            "kind": kind,
        }

    def _check_joinable_locked(self, uid: str, now: datetime) -> None:
        if uid in self._state["user_clan"]:
            raise ClanError("すでにクランに所属しています。")
        remaining = self._cooldown_remaining_locked(uid, now)
        if remaining > 0:
            days = int(remaining // 86400) + (1 if remaining % 86400 else 0)
            raise ClanError(
                f"再参加できるまであと約{days}日かかります。")

    def join(self, user_id: str, clan_id: str,
             now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(JST)
        uid = str(user_id)
        with self._lock:
            self._check_joinable_locked(uid, now)
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                raise ClanError("そのクランはありません。")
            cap = member_cap_for(int(entry.get("total_points") or 0))
            if len(entry["members"]) >= cap:
                raise ClanError("このクランは満員です。")
            entry["members"][uid] = {
                "joined_at": now.astimezone(JST).isoformat(), "points": 0}
            self._state["user_clan"][uid] = str(clan_id)
            self._state["cooldowns"].pop(uid, None)
            self._mark_dirty()
            return self.get(str(clan_id))

    def join_by_code(self, user_id: str, code: str,
                     now: datetime | None = None) -> dict[str, Any]:
        """招待コードで参加する。コードが一致するクランが無ければエラー。"""
        code = str(code or "").strip()
        with self._lock:
            for clan_id, entry in self._state["clans"].items():
                if entry.get("invite_code") and entry["invite_code"] == code:
                    return self.join(user_id, clan_id, now=now)
        raise ClanError("招待コードが正しくありません。")

    def ensure_invite_code(self, clan_id: str) -> str:
        """招待コードを返す（旧データで未発行なら発行して保存する）。"""
        with self._lock:
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                raise ClanError("そのクランはありません。")
            if not entry.get("invite_code"):
                entry["invite_code"] = _new_invite_code(str(clan_id))
                self._mark_dirty()
            return str(entry["invite_code"])

    def regenerate_invite_code(self, user_id: str) -> str:
        """招待コードを再発行する（リーダーのみ。旧コードは無効になる）。"""
        uid = str(user_id)
        with self._lock:
            clan = self.clan_of(uid)
            if clan is None:
                raise ClanError("クランに所属していません。")
            if clan["leader"] != uid:
                raise ClanError("コードを発行できるのはリーダーだけです。")
            entry = self._state["clans"][clan["id"]]
            entry["invite_code"] = _new_invite_code(clan["id"])
            self._mark_dirty()
            return str(entry["invite_code"])

    def rename(self, user_id: str, new_name: str) -> dict[str, Any]:
        """改名する（リーダーのみ）。支払いは呼び出し側が済ませる前提。"""
        new_name = str(new_name).strip()
        if not new_name:
            raise ClanError("クラン名を入力してください。")
        if len(new_name) > MAX_NAME_LENGTH:
            raise ClanError(f"クラン名は{MAX_NAME_LENGTH}文字までです。")
        uid = str(user_id)
        with self._lock:
            clan = self.clan_of(uid)
            if clan is None:
                raise ClanError("クランに所属していません。")
            if clan["leader"] != uid:
                raise ClanError("改名できるのはリーダーだけです。")
            if self.name_taken(new_name, exclude_clan_id=clan["id"]):
                raise ClanError("その名前のクランはすでにあります。")
            self._state["clans"][clan["id"]]["name"] = new_name
            self._mark_dirty()
            return self.get(clan["id"])

    def leave(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """脱退する。リーダーは解散しないと脱退できない。

        脱退した本人には再参加クールダウン（LEAVE_COOLDOWN_DAYS）が付く
        （原典準拠）。累計貢献は減らない。
        """
        now = now or datetime.now(JST)
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
            self._set_cooldown_locked(uid, LEAVE_COOLDOWN_DAYS, "left", now)
            self._mark_dirty()
            return clan

    def kick(self, leader_id: str, target_id: str,
             now: datetime | None = None) -> dict[str, Any]:
        """メンバーを追放する（リーダーのみ）。

        追放された相手には再参加クールダウン（KICK_COOLDOWN_DAYS）が付く
        （原典準拠）。累計貢献は減らない。
        """
        now = now or datetime.now(JST)
        leader = str(leader_id)
        target = str(target_id)
        with self._lock:
            clan = self.clan_of(leader)
            if clan is None:
                raise ClanError("クランに所属していません。")
            if clan["leader"] != leader:
                raise ClanError("追放できるのはリーダーだけです。")
            if target == leader:
                raise ClanError("リーダーは追放できません。")
            entry = self._state["clans"][clan["id"]]
            if target not in entry["members"]:
                raise ClanError("そのメンバーはいません。")
            del entry["members"][target]
            self._state["user_clan"].pop(target, None)
            self._set_cooldown_locked(target, KICK_COOLDOWN_DAYS, "kicked", now)
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
    def add_points(self, user_id: str, points: int,
                   activity: str | None = None) -> int:
        """所属中なら貢献ポイントを加え、加算後の個人値を返す。未所属は0。

        個人ポイント（ランキング用）とクランの累計貢献（レベル用・
        単調増加）の両方へ加える。activity があれば実績カウンタも進める。
        """
        uid = str(user_id)
        with self._lock:
            clan_id = self._state["user_clan"].get(uid)
            if clan_id is None:
                return 0
            entry = self._state["clans"][clan_id]
            member = entry["members"].get(uid)
            if member is None:
                return 0
            member["points"] = int(member["points"]) + int(points)
            entry["total_points"] = int(entry.get("total_points") or 0) + int(points)
            if activity in ACTIVITIES:
                stats = entry.setdefault(
                    "stats", {name: 0 for name in ACTIVITIES})
                stats[activity] = int(stats.get(activity) or 0) + 1
            self._mark_dirty()
            return int(member["points"])

    # ------------------------------------------------------------------ レベル表示（S2）
    def pending_level_up(self, clan_id: str) -> int | None:
        """未告知のレベルアップがあればそのレベルを返す（状態は変えない）。"""
        with self._lock:
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                return None
            level = level_for(int(entry.get("total_points") or 0))
            if level > int(entry.get("level_announced") or 1):
                return level
            return None

    def mark_level_announced(self, clan_id: str) -> None:
        with self._lock:
            entry = self._state["clans"].get(str(clan_id))
            if entry is None:
                return
            level = level_for(int(entry.get("total_points") or 0))
            if level != int(entry.get("level_announced") or 1):
                entry["level_announced"] = level
                self._mark_dirty()

    # ------------------------------------------------------------------ クランボーナス（S6-5）

    def try_claim_bonus(self, user_id: str, now: datetime | None = None) -> bool:
        """今日分を未受取なら受け取り済みにして True（JST日次）。"""
        now = now or datetime.now(JST)
        day = now.astimezone(JST).date().isoformat()
        with self._lock:
            if self._state["bonus_claims"].get(str(user_id)) == day:
                return False
            self._state["bonus_claims"][str(user_id)] = day
            self._mark_dirty()
            return True

    def unclaim_bonus(self, user_id: str) -> None:
        """付与が失敗したときの巻き戻し用。"""
        with self._lock:
            if self._state["bonus_claims"].pop(str(user_id), None) is not None:
                self._mark_dirty()


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


def award_points(user_id: str, points: int, activity: str | None = None) -> None:
    """経済活動からの貢献フック。失敗しても呼び出し側に影響させない。"""
    try:
        if points:
            shared_store().add_points(str(user_id), int(points), activity)
    except Exception:
        logger.exception("clan: 貢献ポイントの加算に失敗 user=%s", user_id)
