# -*- coding: utf-8 -*-
"""盗む（steal 再仕様）の単一の置き場。

パンBot 資産移植 Phase 4（構成案 第4層）。原典の crime／steal を、
コインの新規創出を一切しないゼロサムの PvP 移転として組み直したもの。
ギルド内限定・対象の保護・罰金・クールダウンの制約は以下のとおり:

- 実行できるのは同一ギルド内のみ（判定は呼び出し側＝cogs/circulation.py）
- 成功率は SUCCESS_RATE。盗める額は対象残高の STEAL_BALANCE_RATE で、
  絶対上限 STEAL_MAX_AMOUNT でキャップする
- 対象の残高が TARGET_MIN_BALANCE 未満なら保護され、盗めない
- 失敗時は実行者が対象へ罰金（FINE_AMOUNT、実行者の残高が上限）を払う
- 実行者クールダウン＋1日回数上限と、対象側クールダウン（同一対象への
  連続実行の防止）を両方かける

このモジュールが持つのは制約の定数・クールダウン状態・成否の抽選まで。
コインの実移動は呼び出し側が wallet の原子的な経路
（_change_balance の CAS）で行い、transaction_history に
steal_success / steal_fine の理由コードを残す。保存は
core/general/workshop/workshop.py と同じ流儀: 専用 JSON（既定 data/steal.json、
環境変数 STEAL_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from core.general.items.items import JST, ItemError
from core.store_flush import DirtyFlushMixin

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（Phase 4 の暫定値。確率・上限の絶対値は AGO のコイン分布の
# 実測後に調整する）
# ---------------------------------------------------------------------------

#: 盗みの成功率。
SUCCESS_RATE = 0.40

#: 盗める額の割合（対象残高に対する比率）。
STEAL_BALANCE_RATE = 0.05

#: 盗める額の絶対上限（AGO）。
STEAL_MAX_AMOUNT = 500

#: 対象の最低残高の閾値（AGO）。これ未満の相手からは盗めない（保護）。
TARGET_MIN_BALANCE = 1000

#: 失敗時に実行者が対象へ払う罰金（AGO）。実行者の残高がこれ未満なら
#: 残高全額が上限になる。
FINE_AMOUNT = 100

#: 実行者のクールダウン（秒）。
ACTOR_COOLDOWN_SECONDS = 3600

#: 対象側のクールダウン（秒）。この間、その対象は誰からも盗まれない。
TARGET_COOLDOWN_SECONDS = 6 * 3600

#: 実行者の1日あたりの実行回数上限。
DAILY_ACTOR_LIMIT = 3

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def steal_amount(target_balance: int, *, rate_multiplier: float = 1.0,
                 cap_multiplier: float = 1.0) -> int:
    """対象残高から盗める額。閾値未満の対象は保護され0を返す。

    rate_multiplier / cap_multiplier はアイテム効果（大怪盗など）で
    割合と上限を引き上げるための補正で、既定は無補正（従来どおり）。
    """
    balance = int(target_balance)
    if balance < TARGET_MIN_BALANCE:
        return 0
    amount = int(balance * STEAL_BALANCE_RATE * max(0.0, float(rate_multiplier)))
    cap = int(STEAL_MAX_AMOUNT * max(0.0, float(cap_multiplier)))
    return max(1, min(amount, cap))


def fine_amount(actor_balance: int) -> int:
    """失敗時の罰金額（実行者の残高が上限。残高0なら罰金も0）。"""
    return min(FINE_AMOUNT, max(0, int(actor_balance)))


def _empty_state() -> dict[str, Any]:
    return {"actors": {}, "targets": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    actors = raw.get("actors")
    if isinstance(actors, dict):
        for uid, entry in actors.items():
            if not isinstance(entry, dict):
                continue
            last = entry.get("last")
            day = entry.get("day")
            count = entry.get("count")
            state["actors"][str(uid)] = {
                "last": last if isinstance(last, str) else None,
                "day": day if isinstance(day, str) else None,
                "count": int(count) if isinstance(count, int) and count > 0 else 0,
            }
    targets = raw.get("targets")
    if isinstance(targets, dict):
        for uid, entry in targets.items():
            if isinstance(entry, dict) and isinstance(entry.get("last"), str):
                state["targets"][str(uid)] = {"last": entry["last"]}
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "steal.json"


def default_path() -> Path:
    return Path(os.environ.get("STEAL_DATA_PATH") or _DEFAULT_PATH)


class StealStore(DirtyFlushMixin):
    """盗みのクールダウン・1日回数の状態と JSON 保存、成否の抽選。"""

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
            logger.exception("steal: 状態の保存に失敗しました path=%s", self._path)


    # ------------------------------------------------------------------ 状態参照
    def _actor_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["actors"].setdefault(
            str(user_id), {"last": None, "day": None, "count": 0})

    @staticmethod
    def _remaining(last_iso: str | None, cooldown: int, now: datetime) -> float:
        if not last_iso:
            return 0.0
        try:
            last = datetime.fromisoformat(last_iso)
        except ValueError:
            return 0.0
        return max(0.0, cooldown - (now - last).total_seconds())

    def actor_status(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """表示用: 実行者クールダウン残りと今日の実行回数。"""
        now = now or datetime.now(JST)
        today = now.date().isoformat()
        with self._lock:
            actor = self._actor_locked(str(user_id))
            return {
                "cooldown_remaining": self._remaining(
                    actor["last"], ACTOR_COOLDOWN_SECONDS, now),
                "today_count": int(actor["count"]) if actor["day"] == today else 0,
                "daily_limit": DAILY_ACTOR_LIMIT,
            }

    def target_cooldown_remaining(self, target_id: str,
                                    now: datetime | None = None) -> float:
        now = now or datetime.now(JST)
        with self._lock:
            entry = self._state["targets"].get(str(target_id)) or {}
            return self._remaining(entry.get("last"), TARGET_COOLDOWN_SECONDS, now)

    # ------------------------------------------------------------------ 判定
    def _check_locked(self, actor_id: str, target_id: str,
                      now: datetime) -> tuple[dict[str, Any], int]:
        """実行可否の判定（ロック保持中に呼ぶ）。不可なら ItemError。

        戻り値は (actor エントリ, 今日の実行回数)。状態は変えない
        （actor エントリの setdefault による空エントリ作成を除く）。
        """
        today = now.date().isoformat()
        actor = self._actor_locked(str(actor_id))
        remaining = self._remaining(actor["last"], ACTOR_COOLDOWN_SECONDS, now)
        if remaining > 0:
            minutes = int(remaining // 60) + (1 if remaining % 60 else 0)
            raise ItemError(f"盗みは1時間に1回までです。あと約{minutes}分で実行できます。")
        count = int(actor["count"]) if actor["day"] == today else 0
        if count >= DAILY_ACTOR_LIMIT:
            raise ItemError(
                f"今日の盗みは上限（{DAILY_ACTOR_LIMIT}回）に達しています。")
        target_entry = self._state["targets"].get(str(target_id)) or {}
        target_remaining = self._remaining(
            target_entry.get("last"), TARGET_COOLDOWN_SECONDS, now)
        if target_remaining > 0:
            hours = target_remaining / 3600
            raise ItemError(
                f"その相手はしばらく狙えません（保護期間中、あと約{hours:.1f}時間）。")
        return actor, count

    def check(self, actor_id: str, target_id: str, now: datetime | None = None) -> None:
        """実行可否の事前判定。不可なら ItemError（状態は不変）。

        ギルド限定・対象保護（残高の閾値）はコイン残高が要るため
        呼び出し側が判定し、ここではクールダウンと回数だけを見る。
        """
        now = now or datetime.now(JST)
        with self._lock:
            self._check_locked(actor_id, target_id, now)

    # ------------------------------------------------------------------ 予約
    def reserve(self, actor_id: str, target_id: str,
                now: datetime | None = None) -> dict[str, Any]:
        """判定と仮記録を1つのロック操作で行う予約（E-3 対応）。

        check が通れば、その場で実行者クールダウン・1日回数・対象保護を
        仮記録する。以後の処理が await を挟んでも、同一 actor／同一対象に
        対する2つ目の reserve は必ず弾かれる。処理が成立したら
        commit_reservation、成立しなかったら rollback_reservation を
        呼ぶこと（ロールバックは予約前の状態を差分として復元する）。
        不可なら ItemError（状態は不変）。
        """
        now = now or datetime.now(JST)
        today = now.date().isoformat()
        stamp = now.astimezone(JST).isoformat()
        actor_key = str(actor_id)
        target_key = str(target_id)
        with self._lock:
            actor_before = copy.deepcopy(self._state["actors"].get(actor_key))
            target_before = copy.deepcopy(self._state["targets"].get(target_key))
            actor, count = self._check_locked(actor_id, target_id, now)
            actor["last"] = stamp
            actor["day"] = today
            actor["count"] = count + 1
            self._state["targets"][target_key] = {"last": stamp}
            self._mark_dirty()
            return {
                "actor_id": actor_key, "target_id": target_key,
                "actor_before": actor_before, "target_before": target_before,
                "active": True,
            }

    def commit_reservation(self, reservation: dict[str, Any] | None) -> None:
        """予約を確定する（仮記録がそのまま本記録になる）。冪等。"""
        if not reservation:
            return
        with self._lock:
            reservation["active"] = False

    # 呼び出し側の読みやすさのための別名。
    confirm_reservation = commit_reservation

    def rollback_reservation(self, reservation: dict[str, Any] | None) -> None:
        """予約を取り消し、予約前の actor／target 状態だけを復元する。冪等。"""
        if not reservation:
            return
        with self._lock:
            if not reservation.get("active"):
                return
            reservation["active"] = False
            actor_key = str(reservation["actor_id"])
            target_key = str(reservation["target_id"])
            if reservation.get("actor_before") is None:
                self._state["actors"].pop(actor_key, None)
            else:
                self._state["actors"][actor_key] = copy.deepcopy(
                    reservation["actor_before"])
            if reservation.get("target_before") is None:
                self._state["targets"].pop(target_key, None)
            else:
                self._state["targets"][target_key] = copy.deepcopy(
                    reservation["target_before"])
            self._mark_dirty()

    def roll_success(self, rate_bonus: float = 0.0) -> bool:
        """成否の抽選（成功率 SUCCESS_RATE + アイテム補正、上限 0.95）。"""
        rate = min(0.95, SUCCESS_RATE + max(0.0, float(rate_bonus)))
        return self._rng.random() < rate

    def record_attempt(self, actor_id: str, target_id: str,
                       now: datetime | None = None) -> None:
        """実行が成立した（コイン移動まで完了した）時点で呼ぶ記録。"""
        now = now or datetime.now(JST)
        today = now.date().isoformat()
        stamp = now.astimezone(JST).isoformat()
        with self._lock:
            actor = self._actor_locked(str(actor_id))
            count = int(actor["count"]) if actor["day"] == today else 0
            actor["last"] = stamp
            actor["day"] = today
            actor["count"] = count + 1
            self._state["targets"][str(target_id)] = {"last": stamp}
            self._mark_dirty()
