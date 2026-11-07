# -*- coding: utf-8 -*-
"""植物栽培の中核（種類定義・成長計算・保存）。

パン経済のような売買は一切なく、植えるのも収穫も無料の「純粋な育成枠」。
成長は実時間の経過で進むが、バックグラウンドタスクは持たず、参照・操作の
たびに「前回確定した時刻からの経過」で遅延計算する（Pi の負荷配慮）。
放置しても植物は枯れない（成長が止まるだけ）。

成長計算はすべて時刻（UNIX秒）を引数に取る純粋関数で、単体テストから
時刻を注入できる。保存は data/garden.json（環境変数 GARDEN_DATA_PATH で
変更可）に、メモリ主体＋バッチフラッシュ＋原子差し替え（items と同じ流儀）。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from core.store_flush import DirtyFlushMixin
from core.support import data_paths

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 定数（バランスの根拠は各コメント）
# ---------------------------------------------------------------------------

#: 鉢（区画）の数。パネル1枚＋画像1枚に収まる上限として3。
POT_COUNT = 3

#: 水やり1回で進む成長（2時間分）。草（12時間）なら水やりを挟むと
#: 半日待ちが数時間に縮む体感が得られ、木・盆栽では誤差程度に収まる。
WATER_BOOST_SECONDS = 2 * 3600
#: 水やりのクールダウン（鉢ごと、4時間）。1日数回の世話が上限になり、
#: 連打で成熟を即完了させることはできない。
WATER_COOLDOWN_SECONDS = 4 * 3600

#: 盆栽の剪定クールダウン（24時間＝1日1回のお手入れ）。
PRUNE_COOLDOWN_SECONDS = 24 * 3600
#: 剪定1回で得る樹形値。毎日剪定しても国宝級（100）まで約10日かかる。
PRUNE_FORM_POINTS = 10.0
#: 成木後の水やりで得る樹形値（剪定より小さく、補助的な位置づけ）。
WATER_FORM_POINTS = 2.0
#: 成木後に成長が進んだ分（経過時間）から得る樹形値（1日あたり）。
#: 世話をしなくても年月で少しずつ格が上がる。
FORM_PASSIVE_PER_DAY = 1.0

#: 種類定義（テーブル駆動。種類の追加はここに1エントリ足すだけ）。
#: mature_seconds は「成熟（木・盆栽は成木）までにかかる成長秒数」。
SPECIES: dict[str, dict[str, Any]] = {
    "grass": {
        "name": "草",
        "mature_seconds": 12 * 3600,  # 半日。朝植えて夜に収穫できる回転の速さ
    },
    "tree": {
        "name": "木",
        "mature_seconds": 4 * 24 * 3600,  # 4日。週末をまたぐ育成感
        "fruit_cycle_seconds": 24 * 3600,  # 実は1日1個
    },
    "bonsai": {
        "name": "盆栽",
        "mature_seconds": 7 * 24 * 3600,  # 成木まで1週間。その後も育ち続ける
    },
}

#: 成長段階（成熟までの進捗率の帯）。最後は成熟。
STAGE_SEED = "seed"
STAGE_SPROUT = "sprout"
STAGE_GROWING = "growing"
STAGE_MATURE = "mature"
_STAGE_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (0.45, STAGE_GROWING),
    (0.12, STAGE_SPROUT),
    (0.0, STAGE_SEED),
)
_STAGE_LABELS = {
    STAGE_SEED: "種",
    STAGE_SPROUT: "芽",
    STAGE_GROWING: "成長中",
    STAGE_MATURE: "成熟",
}

#: 盆栽の樹形（植えたときに決まる個性）。
BONSAI_TRAITS: tuple[str, ...] = ("直幹", "斜幹", "曲幹", "懸崖")

#: 盆栽の樹形値の帯（下限ポイント, ラベル）。到達した帯のうち最大のものが現在の格。
BONSAI_FORM_BANDS: tuple[tuple[float, str], ...] = (
    (100.0, "国宝級"),
    (60.0, "逸品"),
    (30.0, "名品"),
    (10.0, "佳作"),
    (0.0, "若木"),
)

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

_RECORD_KEYS = ("grass_harvests", "tree_fruits", "waterings", "prunings", "planted")


# ---------------------------------------------------------------------------
# 植物レコードと成長計算（純粋関数群）
# ---------------------------------------------------------------------------
#
# 植物レコード（JSON にそのまま保存する dict）:
#   species: 種類ID / planted_at: 植えた時刻 / growth: 確定済み成長秒
#   updated_at: growth を確定した時刻 / last_watered_at: 最終水やり
#   matured_at: 成熟した時刻（未成熟は None）
#   fruit_ready_at: 木の実がなる時刻（木以外・未成熟は None）
#   trait: 盆栽の樹形（盆栽以外は None）
#   form: 盆栽の樹形値（確定分。水やり・剪定の加算のみ。経過分は都度計算）
#   last_prune_at: 最終剪定時刻

def new_plant(species_id: str, now: int, rng: random.Random | None = None) -> dict[str, Any]:
    """植えた直後の植物レコードを作る。盆栽は樹形を1つ抽選する。"""
    if species_id not in SPECIES:
        raise ValueError(f"unknown species: {species_id}")
    rng = rng or random.Random()
    return {
        "species": species_id,
        "planted_at": int(now),
        "growth": 0.0,
        "updated_at": int(now),
        "last_watered_at": None,
        "matured_at": None,
        "fruit_ready_at": None,
        "trait": rng.choice(BONSAI_TRAITS) if species_id == "bonsai" else None,
        "form": 0.0,
        "last_prune_at": None,
    }


def mature_seconds(plant: dict[str, Any]) -> float:
    return float(SPECIES[plant["species"]]["mature_seconds"])


def effective_growth(plant: dict[str, Any], now: int) -> float:
    """現時点の実効成長秒（確定分＋前回確定からの経過）。"""
    elapsed = max(0, int(now) - int(plant["updated_at"]))
    return float(plant["growth"]) + elapsed


def stage_of(plant: dict[str, Any], now: int) -> str:
    """現在の成長段階キー（seed / sprout / growing / mature）。"""
    growth = effective_growth(plant, now)
    cap = mature_seconds(plant)
    if growth >= cap:
        return STAGE_MATURE
    ratio = growth / cap if cap > 0 else 1.0
    for threshold, stage in _STAGE_THRESHOLDS:
        if ratio >= threshold:
            return stage
    return STAGE_SEED


def stage_label(plant: dict[str, Any], now: int) -> str:
    stage = stage_of(plant, now)
    if stage == STAGE_MATURE and plant["species"] == "bonsai":
        return "成木"
    return _STAGE_LABELS[stage]


def settle_plant(plant: dict[str, Any], now: int) -> bool:
    """成長を now 時点で確定させ、成熟・結実の時刻を materialize する。

    戻り値は「レコードが変化したか」。表示だけなら呼ばなくてもよいが、
    成熟した瞬間の時刻（木の実の起点）を正しく残すため、操作時と
    パネル表示時に通す。
    """
    changed = False
    now = int(now)
    old_growth = float(plant["growth"])
    old_updated = int(plant["updated_at"])
    growth = old_growth + max(0, now - old_updated)
    cap = mature_seconds(plant)
    if plant.get("matured_at") is None and growth >= cap:
        # 成熟した正確な時刻を逆算する。経過で跨いだ場合は
        # 「前回確定時刻＋成熟に足りなかった成長ぶん」、水やりブーストで
        # 既に跨いでいた場合はブーストを確定した時刻が成熟時刻。
        if old_growth >= cap:
            plant["matured_at"] = old_updated
        else:
            plant["matured_at"] = old_updated + int(cap - old_growth)
        changed = True
        if plant["species"] == "tree" and plant.get("fruit_ready_at") is None:
            plant["fruit_ready_at"] = plant["matured_at"]
    if growth != old_growth or old_updated != now:
        plant["growth"] = growth
        plant["updated_at"] = now
        changed = True
    return changed


def seconds_to_next_stage(plant: dict[str, Any], now: int) -> int | None:
    """次の段階まであと何秒か。成熟済みは None。"""
    growth = effective_growth(plant, now)
    cap = mature_seconds(plant)
    if growth >= cap:
        return None
    ratio = growth / cap if cap > 0 else 1.0
    for threshold in (0.12, 0.45, 1.0):
        if ratio < threshold:
            return max(0, int(threshold * cap - growth))
    return None


def can_water(plant: dict[str, Any], now: int) -> bool:
    """水やり可能か（クールダウン明け、かつ水やりに意味がある状態）。"""
    last = plant.get("last_watered_at")
    if last is not None and int(now) - int(last) < WATER_COOLDOWN_SECONDS:
        return False
    # 成熟した草・木への水やりは効果がないので不可。盆栽は成木後も
    # 樹形値が付くため常時可。
    if stage_of(plant, now) == STAGE_MATURE and plant["species"] != "bonsai":
        return False
    return True


def water_cooldown_left(plant: dict[str, Any], now: int) -> int:
    last = plant.get("last_watered_at")
    if last is None:
        return 0
    return max(0, WATER_COOLDOWN_SECONDS - (int(now) - int(last)))


def apply_water(plant: dict[str, Any], now: int) -> bool:
    """水やりを適用する（成長ブースト＋盆栽は樹形値）。不可なら False。"""
    if not can_water(plant, now):
        return False
    was_mature = stage_of(plant, now) == STAGE_MATURE
    settle_plant(plant, now)
    plant["growth"] = float(plant["growth"]) + WATER_BOOST_SECONDS
    plant["last_watered_at"] = int(now)
    if plant["species"] == "bonsai" and was_mature:
        plant["form"] = float(plant["form"]) + WATER_FORM_POINTS
    settle_plant(plant, now)  # ブーストで成熟を跨いだ場合の時刻確定
    return True


def form_points(plant: dict[str, Any], now: int) -> float:
    """盆栽の樹形値（確定分＋成木後の経過成長ぶん）。盆栽以外は 0。"""
    if plant["species"] != "bonsai":
        return 0.0
    points = float(plant["form"])
    growth = effective_growth(plant, now)
    beyond = growth - mature_seconds(plant)
    if beyond > 0:
        points += beyond / 86400.0 * FORM_PASSIVE_PER_DAY
    return points


def form_band(points: float) -> tuple[str, float | None]:
    """樹形値の帯ラベルと、次の帯までの残りポイント（最上位は None）。"""
    for index, (threshold, label) in enumerate(BONSAI_FORM_BANDS):
        if points >= threshold:
            if index == 0:
                return label, None
            return label, BONSAI_FORM_BANDS[index - 1][0] - points
    return BONSAI_FORM_BANDS[-1][1], BONSAI_FORM_BANDS[-2][0] - points


def can_prune(plant: dict[str, Any], now: int) -> bool:
    """剪定可能か（盆栽が成木後、クールダウン明け）。"""
    if plant["species"] != "bonsai":
        return False
    if stage_of(plant, now) != STAGE_MATURE:
        return False
    last = plant.get("last_prune_at")
    return last is None or int(now) - int(last) >= PRUNE_COOLDOWN_SECONDS


def prune_cooldown_left(plant: dict[str, Any], now: int) -> int:
    last = plant.get("last_prune_at")
    if last is None:
        return 0
    return max(0, PRUNE_COOLDOWN_SECONDS - (int(now) - int(last)))


def apply_prune(plant: dict[str, Any], now: int) -> bool:
    if not can_prune(plant, now):
        return False
    settle_plant(plant, now)
    plant["form"] = float(plant["form"]) + PRUNE_FORM_POINTS
    plant["last_prune_at"] = int(now)
    return True


def _implied_matured_at(plant: dict[str, Any], now: int) -> int | None:
    """成熟時刻（確定値が無ければ成長の経過から逆算した推定値）。"""
    if plant.get("matured_at") is not None:
        return int(plant["matured_at"])
    cap = mature_seconds(plant)
    if effective_growth(plant, now) < cap:
        return None
    growth = float(plant["growth"])
    updated = int(plant["updated_at"])
    if growth >= cap:
        return updated
    return updated + int(cap - growth)


def _fruit_ready_at(plant: dict[str, Any], now: int) -> int | None:
    """実がなる時刻。確定値が無ければ成熟時刻（最初の実は成熟と同時）。"""
    if plant.get("fruit_ready_at") is not None:
        return int(plant["fruit_ready_at"])
    return _implied_matured_at(plant, now)


def fruit_ready(plant: dict[str, Any], now: int) -> bool:
    """木に実がなっているか。"""
    if plant["species"] != "tree":
        return False
    ready_at = _fruit_ready_at(plant, now)
    return ready_at is not None and int(now) >= ready_at


def fruit_in_seconds(plant: dict[str, Any], now: int) -> int | None:
    """次の実まであと何秒か。未成熟・実がなっている場合は None。"""
    if plant["species"] != "tree" or fruit_ready(plant, now):
        return None
    ready_at = _fruit_ready_at(plant, now)
    if ready_at is None:
        return None
    return max(0, ready_at - int(now))


def apply_pick_fruit(plant: dict[str, Any], now: int) -> bool:
    """実を取る。次の実は周期後。取れなければ False。"""
    settle_plant(plant, now)
    if not fruit_ready(plant, now):
        return False
    cycle = int(SPECIES["tree"]["fruit_cycle_seconds"])
    plant["fruit_ready_at"] = int(now) + cycle
    return True


@dataclass(frozen=True)
class PlantStatus:
    """表示用の植物スナップショット（plant_status の戻り値）。"""

    species: str
    species_name: str
    stage: str
    stage_label: str
    seconds_to_next_stage: int | None
    can_water: bool
    water_cooldown_left: int
    fruit_ready: bool
    fruit_in_seconds: int | None
    form_points: float
    form_band: str | None
    points_to_next_band: float | None
    can_prune: bool
    prune_cooldown_left: int
    trait: str | None


def plant_status(plant: dict[str, Any], now: int) -> PlantStatus:
    """植物レコードから表示用ステータスを組み立てる（純粋・無副作用）。"""
    species = plant["species"]
    points = form_points(plant, now)
    band, to_next = form_band(points) if species == "bonsai" else (None, None)
    return PlantStatus(
        species=species,
        species_name=SPECIES[species]["name"],
        stage=stage_of(plant, now),
        stage_label=stage_label(plant, now),
        seconds_to_next_stage=seconds_to_next_stage(plant, now),
        can_water=can_water(plant, now),
        water_cooldown_left=water_cooldown_left(plant, now),
        fruit_ready=fruit_ready(plant, now),
        fruit_in_seconds=fruit_in_seconds(plant, now),
        form_points=points,
        form_band=band,
        points_to_next_band=to_next,
        can_prune=can_prune(plant, now),
        prune_cooldown_left=prune_cooldown_left(plant, now),
        trait=plant.get("trait"),
    )


def format_duration(seconds: int | float) -> str:
    """「あと約◯◯」表示用のざっくりした時間表記。"""
    seconds = int(seconds)
    if seconds < 60:
        return "まもなく"
    if seconds < 3600:
        return f"約{max(1, round(seconds / 60))}分"
    if seconds < 86400:
        hours = seconds / 3600
        return f"約{hours:.0f}時間" if hours >= 2 else f"約{hours:.1f}時間"
    days = seconds / 86400
    return f"約{days:.0f}日" if days >= 2 else f"約{days:.1f}日"


# ---------------------------------------------------------------------------
# 保存（ユーザー単位・全ギルド共通）
# ---------------------------------------------------------------------------

def default_path() -> Path:
    override = (os.getenv("GARDEN_DATA_PATH") or "").strip()
    if override:
        return Path(override)
    return data_paths.data_path("garden.json")


_DEFAULT_PATH = default_path()


def _empty_records() -> dict[str, int]:
    return {key: 0 for key in _RECORD_KEYS}


def _empty_user() -> dict[str, Any]:
    return {"pots": [None] * POT_COUNT, "records": _empty_records()}


def _clean_plant(raw: Any) -> dict[str, Any] | None:
    """保存データの植物レコードを検証して正規化する。不正なら None（空き鉢）。"""
    if not isinstance(raw, dict):
        return None
    species = raw.get("species")
    if species not in SPECIES:
        return None
    try:
        plant = {
            "species": species,
            "planted_at": int(raw.get("planted_at") or 0),
            "growth": float(raw.get("growth") or 0.0),
            "updated_at": int(raw.get("updated_at") or raw.get("planted_at") or 0),
            "last_watered_at": raw.get("last_watered_at"),
            "matured_at": raw.get("matured_at"),
            "fruit_ready_at": raw.get("fruit_ready_at"),
            "trait": None,  # 下で種類に応じて正規化する
            "form": float(raw.get("form") or 0.0),
            "last_prune_at": raw.get("last_prune_at"),
        }
    except (TypeError, ValueError):
        return None
    if species == "bonsai":
        plant["trait"] = raw.get("trait") if raw.get("trait") in BONSAI_TRAITS else BONSAI_TRAITS[0]
    for key in ("last_watered_at", "matured_at", "fruit_ready_at", "last_prune_at"):
        if plant[key] is not None:
            try:
                plant[key] = int(plant[key])
            except (TypeError, ValueError):
                plant[key] = None
    return plant


def _clean_user(raw: Any) -> dict[str, Any]:
    user = _empty_user()
    if not isinstance(raw, dict):
        return user
    pots = raw.get("pots")
    if isinstance(pots, list):
        cleaned = [_clean_plant(p) for p in pots[:POT_COUNT]]
        cleaned += [None] * (POT_COUNT - len(cleaned))
        user["pots"] = cleaned
    records = raw.get("records")
    if isinstance(records, dict):
        for key in _RECORD_KEYS:
            try:
                user["records"][key] = max(0, int(records.get(key) or 0))
            except (TypeError, ValueError):
                user["records"][key] = 0
    return user


def _clean_state(raw: Any) -> dict[str, Any]:
    state: dict[str, Any] = {"version": 1, "users": {}}
    if isinstance(raw, dict) and isinstance(raw.get("users"), dict):
        for user_id, entry in raw["users"].items():
            state["users"][str(user_id)] = _clean_user(entry)
    return state


class GardenStore(DirtyFlushMixin):
    """植物栽培の保存（同期 API、メモリ主体＋バッチフラッシュ）。"""

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
        raw = data_paths.read_json(self._path)
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
            logger.exception("garden: 状態の保存に失敗しました path=%s", self._path)

    # ------------------------------------------------------------------ 参照
    def _ensure_user_locked(self, user_id: str) -> dict[str, Any]:
        user = self._state["users"].get(user_id)
        if user is None:
            user = _empty_user()
            self._state["users"][user_id] = user
        return user

    def snapshot(self, user_id: str | int) -> dict[str, Any]:
        """ユーザーの庭のディープコピー（表示用）。"""
        with self._lock:
            user = self._state["users"].get(str(user_id))
            return copy.deepcopy(user) if user is not None else _empty_user()

    def settle_user(self, user_id: str | int, now: int) -> bool:
        """全鉢の成長を確定する。変化があれば dirty にする。"""
        with self._lock:
            user = self._ensure_user_locked(str(user_id))
            changed = False
            for plant in user["pots"]:
                if plant is not None and settle_plant(plant, now):
                    changed = True
            if changed:
                self._mark_dirty()
            return changed

    def mutate(self, user_id: str | int, fn: Callable[[dict[str, Any]], Any]) -> Any:
        """ユーザーの庭に変更関数を適用し、dirty を付けて結果を返す。"""
        with self._lock:
            user = self._ensure_user_locked(str(user_id))
            result = fn(user)
            self._mark_dirty()
            return result

    # ------------------------------------------------------------------ 操作
    def plant(self, user_id: str | int, pot_index: int, species_id: str, now: int) -> bool:
        """空き鉢に植える。埋まっていれば False。"""
        def _op(user: dict[str, Any]) -> bool:
            if not (0 <= pot_index < POT_COUNT) or user["pots"][pot_index] is not None:
                return False
            user["pots"][pot_index] = new_plant(species_id, now, self._rng)
            user["records"]["planted"] += 1
            return True
        return bool(self.mutate(user_id, _op))

    def clear_pot(self, user_id: str | int, pot_index: int) -> bool:
        def _op(user: dict[str, Any]) -> bool:
            if not (0 <= pot_index < POT_COUNT) or user["pots"][pot_index] is None:
                return False
            user["pots"][pot_index] = None
            return True
        return bool(self.mutate(user_id, _op))

    def water(self, user_id: str | int, pot_index: int, now: int) -> bool:
        def _op(user: dict[str, Any]) -> bool:
            plant = user["pots"][pot_index] if 0 <= pot_index < POT_COUNT else None
            if plant is None or not apply_water(plant, now):
                return False
            user["records"]["waterings"] += 1
            return True
        return bool(self.mutate(user_id, _op))

    def prune(self, user_id: str | int, pot_index: int, now: int) -> bool:
        def _op(user: dict[str, Any]) -> bool:
            plant = user["pots"][pot_index] if 0 <= pot_index < POT_COUNT else None
            if plant is None or not apply_prune(plant, now):
                return False
            user["records"]["prunings"] += 1
            return True
        return bool(self.mutate(user_id, _op))

    def harvest_grass(self, user_id: str | int, pot_index: int, now: int) -> bool:
        """成熟した草を収穫する（鉢は空く）。"""
        def _op(user: dict[str, Any]) -> bool:
            plant = user["pots"][pot_index] if 0 <= pot_index < POT_COUNT else None
            if plant is None or plant["species"] != "grass":
                return False
            settle_plant(plant, now)
            if stage_of(plant, now) != STAGE_MATURE:
                return False
            user["pots"][pot_index] = None
            user["records"]["grass_harvests"] += 1
            return True
        return bool(self.mutate(user_id, _op))

    def pick_fruit(self, user_id: str | int, pot_index: int, now: int) -> bool:
        def _op(user: dict[str, Any]) -> bool:
            plant = user["pots"][pot_index] if 0 <= pot_index < POT_COUNT else None
            if plant is None or not apply_pick_fruit(plant, now):
                return False
            user["records"]["tree_fruits"] += 1
            return True
        return bool(self.mutate(user_id, _op))
