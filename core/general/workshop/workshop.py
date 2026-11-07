# -*- coding: utf-8 -*-
"""工房（加工機・委託加工・連続稼働ストリーク）の単一の置き場。

パンBot 資産移植 Phase 3（構成案 第3.5層）。原典の焼き釜が持っていた
「時間で進む定期タスク」を、パンのテーマを外して AGO の合成素材の
供給源として組み直したもの。

形: コインで加工機を買う → 時間経過で合成素材が生産される →
claim で受け取る（lazy 決済。ユーザー別常駐タスクも経過通知も無し）。
生産物はコインではなく素材に限定する（コインを直接湧かせない）。
加工機は原典の焼き釜と同じ使い捨てで、寿命（決済サイクル数）を
使い切ると消える。価格は寿命までの総生産 EV のおよそ半分に置き、
回し切れば元が取れて利益が残るようにしてある。

保存は core/general/items/items.py と同じ流儀: 専用 JSON（既定 data/workshop.json、
環境変数 WORKSHOP_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。アイテムの実増減は ItemStore 経由でのみ行う。
コインの実移動（加工機の購入）は呼び出し側（cogs/workshop.py）が
wallet の安全な経路で行う。
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

from core.general.workshop import craft as craft_core
from core.general.items.items import ITEM_DEFS, JST, ItemError, ItemStore
from core.store_flush import DirtyFlushMixin

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（Phase 3 の暫定値。価格の絶対値は AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: 加工機ティア（使い捨てモデル）。lifespan_cycles が寿命で、生産サイクルが
#: 決済されるたびに1ずつ減り、0になった加工機は消える（買い直し前提）。
#: price は暫定値で、寿命までの総生産 EV（lifespan_cycles × 1サイクルEV）の
#: およそ半分（40〜60%の範囲）に置いた。満稼働で回し切れば元が取れて
#: 利益が残る計算。計算根拠は production_expected_value() と
#: lifetime_expected_value() を参照。
#: production はレア枠を除いた通常素材の重みテーブル、rare_rate の確率で
#: rare_item（強化合金）が出る。max_cycles = storage_hours // cycle_hours。
MACHINE_TIERS: dict[str, dict[str, Any]] = {
    "small": {
        "name": "小型加工機",
        "price": 1400,
        "cycle_hours": 4,
        "storage_hours": 8,
        "lifespan_cycles": 36,
        "production": (("scrap", 70), ("metal_piece", 30)),
        "rare_item": "reinforced_alloy",
        "rare_rate": 0.0,
        "commission_slots": 1,
    },
    "auto": {
        "name": "自動加工機",
        "price": 5200,
        "cycle_hours": 6,
        "storage_hours": 12,
        "lifespan_cycles": 40,
        "production": (("scrap", 55), ("metal_piece", 30), ("circuit_piece", 10)),
        "rare_item": "reinforced_alloy",
        "rare_rate": 0.05,
        "commission_slots": 1,
    },
    "large": {
        "name": "大型加工機",
        "price": 9400,
        "cycle_hours": 8,
        "storage_hours": 24,
        "lifespan_cycles": 42,
        "production": (("scrap", 45), ("metal_piece", 30), ("circuit_piece", 13)),
        "rare_item": "reinforced_alloy",
        "rare_rate": 0.12,
        "commission_slots": 2,
    },
}

#: 委託加工にかかる時間（時間）。暫定値。
COMMISSION_HOURS = 2.0

#: 委託加工のレア結果の重み倍率（通常合成よりレアが出やすい）。
COMMISSION_RARE_BOOST = 2.0

#: 連続稼働ストリーク: claim 日が続くごとに生産ボーナス +5%（最大 +25%、
#: 6日目で到達）。1日 claim が空いても（猶予1日）ストリークは続く。
STREAK_BONUS_PER_DAY = 0.05
STREAK_BONUS_CAP = 0.25
STREAK_GRACE_DAYS = 1

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _material_value(item_id: str) -> float:
    # 生産物の実現価値は売却額（全アイテム共通で購入価格の半分）で測る。
    # 全アイテム売却が可能になった 2026-11-06 以前は、売却できない素材を
    # 購入価格で評価していたため EV が実態より大きく出ていた。売却額
    # ベースに直した結果、加工機価格も総 EV の約半分になるよう調整した。
    definition = ITEM_DEFS[item_id]
    return float(definition["sell_price"])


def production_expected_value(tier_id: str) -> float:
    """1サイクルあたりの生産 EV（AGO 換算、アイテムの想定価値ベース）。"""
    tier = MACHINE_TIERS[tier_id]
    total_weight = sum(weight for _item, weight in tier["production"])
    normal_ev = sum(
        weight / total_weight * _material_value(item_id)
        for item_id, weight in tier["production"]
    )
    rare_rate = float(tier["rare_rate"])
    return (1.0 - rare_rate) * normal_ev + rare_rate * _material_value(tier["rare_item"])


def lifetime_expected_value(tier_id: str) -> float:
    """寿命（lifespan_cycles）まで回し切った場合の総生産 EV（AGO 換算）。"""
    tier = MACHINE_TIERS[tier_id]
    return production_expected_value(tier_id) * int(tier["lifespan_cycles"])


def lifetime_days(tier_id: str) -> float:
    """満稼働（24h 回し続けた場合）で寿命を使い切るまでの日数。"""
    tier = MACHINE_TIERS[tier_id]
    return int(tier["lifespan_cycles"]) * float(tier["cycle_hours"]) / 24.0


def streak_bonus_rate(streak_days: int) -> float:
    """ストリーク日数に対する生産ボーナス率（初日0%、+5%/日、上限+25%）。"""
    if streak_days <= 1:
        return 0.0
    return min((streak_days - 1) * STREAK_BONUS_PER_DAY, STREAK_BONUS_CAP)


def _empty_state() -> dict[str, Any]:
    return {"users": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if not isinstance(users, dict):
        return state
    for uid, entry in users.items():
        if not isinstance(entry, dict):
            continue
        machines = []
        for machine in entry.get("machines") or []:
            if not isinstance(machine, dict):
                continue
            tier = machine.get("tier")
            anchor = machine.get("anchor")
            if tier in MACHINE_TIERS and isinstance(anchor, str):
                lifespan = int(MACHINE_TIERS[tier]["lifespan_cycles"])
                raw_left = machine.get("cycles_left")
                if isinstance(raw_left, int) and not isinstance(raw_left, bool):
                    cycles_left = min(max(raw_left, 0), lifespan)
                else:
                    # 恒久モデル時代の保存形式（耐久なし）は、没収せず
                    # そのティアの満タン耐久を付与して消耗モデルへ移行する。
                    cycles_left = lifespan
                if cycles_left > 0:
                    machines.append({
                        "tier": tier, "anchor": anchor,
                        "cycles_left": cycles_left,
                    })
        commissions = []
        for job in entry.get("commissions") or []:
            if not isinstance(job, dict):
                continue
            a, b, ready_at = job.get("a"), job.get("b"), job.get("ready_at")
            if (isinstance(a, str) and isinstance(b, str)
                    and a in ITEM_DEFS and b in ITEM_DEFS
                    and isinstance(ready_at, str)
                    and craft_core.find_recipe(a, b) is not None):
                commissions.append({"a": a, "b": b, "ready_at": ready_at})
        streak_raw = entry.get("streak") or {}
        streak = {"days": 0, "last": None}
        if isinstance(streak_raw, dict):
            days = streak_raw.get("days")
            last = streak_raw.get("last")
            if isinstance(days, int) and days > 0 and isinstance(last, str):
                streak = {"days": days, "last": last}
        if machines or commissions or streak["days"]:
            state["users"][str(uid)] = {
                "machines": machines, "commissions": commissions, "streak": streak,
            }
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "workshop.json"


def default_path() -> Path:
    return Path(os.environ.get("WORKSHOP_DATA_PATH") or _DEFAULT_PATH)


class WorkshopStore(DirtyFlushMixin):
    """加工機・委託・ストリークの状態と JSON 保存（同期 API、メモリ主体）。"""

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
            logger.exception("workshop: 状態の保存に失敗しました path=%s", self._path)


    # ------------------------------------------------------------------ 状態参照
    def _user_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(str(user_id), {
            "machines": [], "commissions": [],
            "streak": {"days": 0, "last": None},
        })

    def machines(self, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._user_locked(str(user_id))["machines"])

    def commissions(self, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._user_locked(str(user_id))["commissions"])

    def commission_slots(self, user_id: str) -> int:
        """委託加工の並行上限（所有する最上位ティアで決まる。未所有は0）。

        状態に残っている加工機はすべて寿命（cycles_left）が残っている
        ものだけなので、「寿命の残っている加工機を所有」が条件になる。
        """
        with self._lock:
            machines = self._user_locked(str(user_id))["machines"]
            return max(
                (MACHINE_TIERS[m["tier"]]["commission_slots"] for m in machines),
                default=0,
            )

    # ------------------------------------------------------------------ 生産
    @staticmethod
    def _max_cycles(tier: dict[str, Any]) -> int:
        return int(tier["storage_hours"]) // int(tier["cycle_hours"])

    def pending_cycles(self, machine: dict[str, Any], now: datetime,
                       time_scale: float = 1.0) -> int:
        """貯蔵上限までに溜まっている完成サイクル数（lazy 計算、状態は変えない）。

        time_scale は経過時間の倍率（加速オイルの効果から cog が渡す）。
        時間を速く数えても貯蔵上限（storage_hours 分）自体は変わらない。
        """
        tier = MACHINE_TIERS[machine["tier"]]
        try:
            anchor = datetime.fromisoformat(machine["anchor"])
        except (KeyError, ValueError):
            return 0
        elapsed = (now - anchor).total_seconds()
        if elapsed < 0:
            return 0
        cycle_seconds = tier["cycle_hours"] * 3600
        accrued = min(elapsed * float(time_scale), tier["storage_hours"] * 3600)
        cycles = min(self._max_cycles(tier), int(accrued // cycle_seconds))
        # 残り寿命を超えては生産できない（寿命が先に尽きる）。
        return min(cycles, int(machine.get("cycles_left", 0)))

    def total_pending(self, user_id: str, now: datetime | None = None,
                      time_scale: float = 1.0) -> int:
        now = now or datetime.now(JST)
        with self._lock:
            return sum(
                self.pending_cycles(m, now, time_scale)
                for m in self._user_locked(str(user_id))["machines"]
            )

    def _roll_production(self, tier: dict[str, Any]) -> str:
        if tier["rare_rate"] > 0 and self._rng.random() < tier["rare_rate"]:
            return tier["rare_item"]
        table = tier["production"]
        total = sum(weight for _item, weight in table)
        pick = self._rng.random() * total
        cumulative = 0.0
        for item_id, weight in table:
            cumulative += weight
            if pick < cumulative:
                return item_id
        return table[-1][0]

    # ------------------------------------------------------------------ ストリーク
    def _streak_days_locked(self, user: dict[str, Any], today) -> int:
        """今日時点で生きているストリーク日数（猶予を過ぎていれば0扱い）。"""
        streak = user["streak"]
        if not streak["days"] or not streak["last"]:
            return 0
        try:
            last = datetime.fromisoformat(streak["last"]).date()
        except ValueError:
            return 0
        gap = (today - last).days
        if gap < 0 or gap > STREAK_GRACE_DAYS + 1:
            return 0
        return int(streak["days"])

    def streak_status(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """表示用: 現在のストリーク日数と、いま claim した場合に乗るボーナス率。"""
        now = now or datetime.now(JST)
        with self._lock:
            user = self._user_locked(str(user_id))
            days = self._streak_days_locked(user, now.date())
            if days and not self._claimed_today_locked(user, now.date()):
                # 今日 claim すればストリークがもう1日伸びた状態で抽選される。
                effective = days + 1
            else:
                effective = max(days, 1)
            return {"days": days, "bonus_rate": streak_bonus_rate(effective)}

    def _claimed_today_locked(self, user: dict[str, Any], today) -> bool:
        last = user["streak"]["last"]
        if not last:
            return False
        try:
            return datetime.fromisoformat(last).date() == today
        except ValueError:
            return False

    def _advance_streak_locked(self, user: dict[str, Any], now: datetime) -> int:
        """claim 日としてストリークを進め、更新後の日数を返す。"""
        today = now.date()
        if self._claimed_today_locked(user, today):
            return int(user["streak"]["days"])
        alive = self._streak_days_locked(user, today)
        days = alive + 1 if alive else 1
        user["streak"] = {"days": days, "last": today.isoformat()}
        return days

    # ------------------------------------------------------------------ 購入
    def add_machine(self, user_id: str, tier_id: str, now: datetime | None = None) -> dict[str, Any]:
        """加工機を1台追加する（生産アンカーは購入時刻）。コイン移動は呼び出し側。"""
        if tier_id not in MACHINE_TIERS:
            raise ItemError("その加工機は存在しません。")
        now = now or datetime.now(JST)
        with self._lock:
            user = self._user_locked(str(user_id))
            machine = {
                "tier": tier_id,
                "anchor": now.astimezone(JST).isoformat(),
                "cycles_left": int(MACHINE_TIERS[tier_id]["lifespan_cycles"]),
            }
            user["machines"].append(machine)
            self._mark_dirty()
            return copy.deepcopy(machine)

    def rollback_machine(self, user_id: str, machine: dict[str, Any]) -> None:
        """add_machine の巻き戻し（コイン控除に失敗したとき用）。"""
        with self._lock:
            machines = self._user_locked(str(user_id))["machines"]
            for index, existing in enumerate(machines):
                if existing == machine:
                    del machines[index]
                    break
            self._mark_dirty()

    # ------------------------------------------------------------------ claim
    def claim_production(self, user_id: str, now: datetime | None = None,
                         time_scale: float = 1.0) -> dict[str, Any]:
        """溜まった生産分を確定し、生産アイテムの集計を返す（所持への追加は呼び出し側）。

        1サイクルでも生産があれば claim 日としてストリークを進め、
        そのボーナス率で追加生産の抽選を行う。貯蔵上限を超えた時間は
        切り捨てる（アンカーは余り時間だけ残して進める）。
        決済したサイクル数だけ各加工機の寿命（cycles_left）が減り、
        0になった加工機は消費されて消える（戻り値の "exhausted" に
        ティアIDが入る）。ストリークのボーナス生産は追加の抽選であり、
        寿命は決済サイクル分しか減らない。
        time_scale は経過時間の倍率（加速オイル）。速く貯まる代わりに
        サイクル消化＝寿命の消費も同じ速さで進む（貯蔵上限は不変）。
        アンカーの余り時間は倍率で割り戻して実時間に換算する。
        """
        now = now or datetime.now(JST)
        scale = float(time_scale) if time_scale and time_scale > 0 else 1.0
        with self._lock:
            user = self._user_locked(str(user_id))
            plan = [
                (machine, self.pending_cycles(machine, now, scale))
                for machine in user["machines"]
            ]
            total_cycles = sum(count for _m, count in plan)
            if total_cycles <= 0:
                return {"items": {}, "cycles": 0, "streak_days":
                        self._streak_days_locked(user, now.date()),
                        "bonus_rate": 0.0, "exhausted": []}
            streak_days = self._advance_streak_locked(user, now)
            bonus_rate = streak_bonus_rate(streak_days)
            items: dict[str, int] = {}
            exhausted: list[str] = []
            survivors: list[dict[str, Any]] = []
            for machine, cycles in plan:
                if cycles <= 0:
                    survivors.append(machine)
                    continue
                tier = MACHINE_TIERS[machine["tier"]]
                for _ in range(cycles):
                    item_id = self._roll_production(tier)
                    items[item_id] = items.get(item_id, 0) + 1
                    if bonus_rate > 0 and self._rng.random() < bonus_rate:
                        bonus_item = self._roll_production(tier)
                        items[bonus_item] = items.get(bonus_item, 0) + 1
                machine["cycles_left"] = int(machine.get("cycles_left", 0)) - cycles
                if machine["cycles_left"] <= 0:
                    exhausted.append(machine["tier"])
                    continue
                cycle_seconds = tier["cycle_hours"] * 3600
                try:
                    anchor = datetime.fromisoformat(machine["anchor"])
                except ValueError:
                    anchor = now
                elapsed = (now - anchor).total_seconds()
                accrued = min(max(elapsed, 0.0) * scale, tier["storage_hours"] * 3600)
                remainder = accrued - cycles * cycle_seconds
                # 余りは倍率換算された時間なので、実時間へ割り戻す。
                machine["anchor"] = (now - timedelta(
                    seconds=max(remainder, 0.0) / scale)
                ).astimezone(JST).isoformat()
                survivors.append(machine)
            user["machines"] = survivors
            self._mark_dirty()
            return {"items": items, "cycles": total_cycles,
                    "streak_days": streak_days, "bonus_rate": bonus_rate,
                    "exhausted": exhausted}

    # ------------------------------------------------------------------ 委託加工
    def start_commission(self, item_store: ItemStore, user_id: str, item_a: str,
                         item_b: str, now: datetime | None = None) -> dict[str, Any]:
        """素材2個を預けて委託加工を開始する。素材はこの時点で消費される。

        レシピが無い・並行上限・素材不足は ItemError（所持と状態は不変）。
        """
        now = now or datetime.now(JST)
        if item_a not in ITEM_DEFS or item_b not in ITEM_DEFS:
            raise ItemError("そのアイテムは存在しません。")
        if craft_core.find_recipe(item_a, item_b) is None:
            raise ItemError("その組み合わせでは何も作れません。")
        with self._lock:
            user = self._user_locked(str(user_id))
            slots = self.commission_slots(user_id)
            if slots <= 0:
                raise ItemError("委託加工には加工機が必要です。")
            if len(user["commissions"]) >= slots:
                raise ItemError(f"委託加工は同時に{slots}件までです。")
            craft_core.consume_inputs(item_store, str(user_id), item_a, item_b, now)
            job = {
                "a": item_a, "b": item_b,
                "ready_at": (now + timedelta(hours=COMMISSION_HOURS)
                             ).astimezone(JST).isoformat(),
            }
            user["commissions"].append(job)
            self._mark_dirty()
            return copy.deepcopy(job)

    def claim_commissions(self, item_store: ItemStore, user_id: str,
                          now: datetime | None = None,
                          extra_rare_boost: float = 1.0) -> list[dict[str, Any]]:
        """完了した委託を引き取り、結果を所持に加える。未完了分は残す。

        抽選は通常合成と同じテーブルを COMMISSION_RARE_BOOST 倍率で引く。
        extra_rare_boost（合成触媒の効果）は委託倍率と乗算し、合計は
        craft 側の上限（RARE_BOOST_CAP）でキャップされる。
        戻り値: [{"inputs": (a, b), "item": ID, "count": n, "rare": bool}, ...]
        """
        now = now or datetime.now(JST)
        results: list[dict[str, Any]] = []
        with self._lock:
            user = self._user_locked(str(user_id))
            remaining = []
            for job in user["commissions"]:
                try:
                    ready_at = datetime.fromisoformat(job["ready_at"])
                except ValueError:
                    ready_at = now
                if ready_at > now:
                    remaining.append(job)
                    continue
                recipe = craft_core.find_recipe(job["a"], job["b"])
                if recipe is None:
                    continue
                item_id, count = craft_core.roll_outcome(
                    recipe, self._rng,
                    rare_boost=craft_core.combine_rare_boost(
                        COMMISSION_RARE_BOOST, extra_rare_boost))
                item_store.add(str(user_id), item_id, count, now=now)
                rare = any(
                    row_item == item_id and row_rare
                    for row_item, _c, _w, row_rare in recipe["outcomes"]
                )
                results.append({"inputs": craft_core.recipe_key(job["a"], job["b"]),
                                "item": item_id, "count": count, "rare": rare})
            if len(remaining) != len(user["commissions"]):
                user["commissions"] = remaining
                self._mark_dirty()
            return results
