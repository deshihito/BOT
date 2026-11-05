# -*- coding: utf-8 -*-
"""アイテム基盤（定義・インベントリ・ショップ・宝箱）の単一の置き場。

パンBot 資産移植 Phase 2。原典の「アイテム辞書＋所持 {count, expires}＋
期限切れの自動削除＋宝箱のドロップテーブル分離」という構造を採るが、
中身（名前・説明・価格）は AGO 用に新規作成し、効果が未実装のアイテムは
作らない（原典で説明が「実装中」のままだった11種の轍を踏まない）。

設計の要点:
- 所持はユーザー単位・全ギルド共通。保存は core/market.py と同じ流儀:
  専用 JSON（既定 data/items.json、環境変数 ITEMS_DATA_PATH で変更可）に、
  メモリ主体＋バッチフラッシュ＋原子差し替え。市場とはファイルを分ける。
- AGO コインの増減そのものはここでは行わない（cogs/wallet.py の安全な
  残高更新経路に委ねる）。ここで扱うのは所持・効果・抽選までで、購入／売却／
  宝箱コインの実移動は呼び出し側（cogs/items.py）が wallet 経由で行う。
- 効果は2層に分ける:
  1. 能動効果（使うと発動）: EFFECT_HANDLERS に「効果ID → ハンドラ」を登録
     する方式。ハンドラは (store, user_id, item_def, now) を受け取り、
     発動結果の文言を返す。Phase 3 の合成・既存ゲームはこちらに登録する。
  2. 受動効果（発動中かどうかを他システムが引く）: has_effect(user_id, 効果ID)。
     市場手数料の割引（FEE_DISCOUNT_EFFECT）が最初の接続例で、cogs/market.py
     が売買時に引いて手数料率を決める。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))

# ---------------------------------------------------------------------------
# 経済定数（Phase 2 の暫定値。価格の絶対値は AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: コインの単位表記（cogs/wallet.py と同じ）。
COIN_NAME = "AGO"

#: 手数料パスの効果IDと割引率（有効期間中、市場手数料がこの倍率になる）。
FEE_DISCOUNT_EFFECT = "fee_discount"
FEE_DISCOUNT_MULTIPLIER = 0.5

#: 宝箱1個の価格（ショップ購入）。
BOX_PRICE = 1000

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

# ---------------------------------------------------------------------------
# アイテム定義（宣言的辞書）
#
# id / name / desc / price / duration_hours / kind / purchasable / sell_price
# - price: ショップ購入価格（購入不可アイテムは Phase 3 の合成・工房での
#   価値の目安として持つ。いずれも暫定値・実測後に調整）
# - duration_hours: 「使う」と発動して効果が続く時間。None は時間効果なし
# - kind: material（素材）/ collectible（換金コレクション）/
#   consumable（消費）/ box（宝箱）
# - purchasable: ショップで買えるか（上位素材・レアは False = 合成・宝箱でのみ）
# - sell_price: ショップが買い戻す固定価格。None は売却不可
# - effect: 能動効果の効果ID（EFFECT_HANDLERS に実体があるものだけ）
# - box_drop: 宝箱の抽選候補に入れてよいか（BOX_NEVER_DROP と二重に守る）
# ---------------------------------------------------------------------------

ITEM_DEFS: dict[str, dict[str, Any]] = {
    "scrap": {
        "name": "スクラップ",
        "desc": "あらゆる加工の出発点になる最下位の素材。合成で上位の素材に化ける。",
        "price": 50,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "sell_price": None,
        "effect": None,
        "box_drop": True,
    },
    "metal_piece": {
        "name": "金属片",
        "desc": "基本的な加工素材。合成の材料として幅広く使う。",
        "price": 400,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "sell_price": None,
        "effect": None,
        "box_drop": True,
    },
    "circuit_piece": {
        "name": "回路片",
        "desc": "精密な加工に使う素材。金属片より一段上の材料。",
        "price": 1200,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "sell_price": None,
        "effect": None,
        "box_drop": True,
    },
    "reinforced_alloy": {
        "name": "強化合金",
        "desc": "合成でしか作れない上位素材。ショップでは買えない。",
        "price": 5000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": True,
    },
    "mystery_crystal": {
        "name": "謎の結晶",
        "desc": "素性の知れないレア素材。宝箱からごく稀に出る。",
        "price": 20000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": True,
    },
    "alloy_plate": {
        "name": "合金プレート",
        "desc": "金属片を合成して作る中間素材。丈夫な部品の土台になる。",
        "price": 2500,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": False,
    },
    "circuit_board": {
        "name": "電子基板",
        "desc": "回路片を組み上げた中間素材。精密部品の材料になる。",
        "price": 3500,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": False,
    },
    "precision_parts": {
        "name": "精密部品",
        "desc": "誤差の少ない上位素材。最終工程の合成に欠かせない。",
        "price": 6000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": False,
    },
    "reinforced_frame": {
        "name": "強化フレーム",
        "desc": "強化合金を組んだ骨格材。アゴコア合成の直前に位置する素材。",
        "price": 9000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "sell_price": None,
        "effect": None,
        "box_drop": False,
    },
    "ago_core": {
        "name": "アゴコア",
        "desc": "合成チェーンの最終到達点。コレクションとして持ち続けるもよし、ショップに高額で売るもよし。",
        "price": 100000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": False,
        "sell_price": 50000,
        "effect": None,
        "box_drop": False,
    },
    "gold_scrap": {
        "name": "金のスクラップ",
        "desc": "金色に光る換金用コレクション。ショップに固定価格で売却できる。",
        "price": 10000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": True,
        "sell_price": 5000,
        "effect": None,
        "box_drop": True,
    },
    "fee_pass": {
        "name": "手数料パス",
        "desc": "使うと24時間、市場の売買手数料が半額になる。",
        "price": 3000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "sell_price": None,
        "effect": FEE_DISCOUNT_EFFECT,
        "box_drop": True,
    },
    "treasure_box": {
        "name": "宝箱",
        "desc": "開けるとコインや素材が出る。まとめて開封できる。",
        "price": BOX_PRICE,
        "duration_hours": None,
        "kind": "box",
        "purchasable": True,
        "sell_price": None,
        "effect": None,
        "box_drop": False,
    },
}

# ---------------------------------------------------------------------------
# 宝箱ドロップ（宣言的テーブル。原典 BOX_DROP_RATES / BOX_NEVER_DROP の分離を採用）
#
# 1個あたりの抽選は各行が独立。コインは常時出る行として置く。
# 期待値（価格換算）は宝箱価格 1000 AGO の約7割に抑えてある
# （コイン平均165＋素材・換金・パスの期待値 合計 約690）＝開け続けて増えない。
# ---------------------------------------------------------------------------

#: 宝箱から絶対に出ないアイテム（定義側 box_drop=False と二重の防御）。
BOX_NEVER_DROP = frozenset({"treasure_box"})

#: kind="coins" の行は item ではなくコイン（min〜max の一様分布）。
BOX_DROPS: tuple[dict[str, Any], ...] = (
    {"kind": "coins", "chance": 1.0, "min": 30, "max": 300},
    {"kind": "item", "item": "scrap", "chance": 0.35, "min": 1, "max": 3},
    {"kind": "item", "item": "metal_piece", "chance": 0.15, "min": 1, "max": 1},
    {"kind": "item", "item": "circuit_piece", "chance": 0.06, "min": 1, "max": 1},
    {"kind": "item", "item": "fee_pass", "chance": 0.04, "min": 1, "max": 1},
    {"kind": "item", "item": "gold_scrap", "chance": 0.02, "min": 1, "max": 1},
    {"kind": "item", "item": "reinforced_alloy", "chance": 0.015, "min": 1, "max": 1},
    {"kind": "item", "item": "mystery_crystal", "chance": 0.003, "min": 1, "max": 1},
)


def box_expected_value() -> float:
    """宝箱1個の期待値（AGO 換算）。コインは額面、アイテムは売却価格→購入価格の順で評価。"""
    total = 0.0
    for row in BOX_DROPS:
        if row["kind"] == "coins":
            total += row["chance"] * (row["min"] + row["max"]) / 2
        else:
            item = ITEM_DEFS[row["item"]]
            value = item["sell_price"] if item["sell_price"] is not None else item["price"]
            total += row["chance"] * (row["min"] + row["max"]) / 2 * value
    return total


def item_def(item_id: str) -> dict[str, Any] | None:
    return ITEM_DEFS.get(item_id)


def resolve_item_id(text: str) -> str | None:
    """アイテムIDまたは名前からIDを引く（モーダル入力用）。"""
    text = (text or "").strip()
    if text in ITEM_DEFS:
        return text
    for item_id, definition in ITEM_DEFS.items():
        if definition["name"] == text:
            return item_id
    return None


class ItemError(Exception):
    """アイテム操作が成立しない理由（ユーザ向け文言をそのまま持つ）。"""


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "items.json"


def default_path() -> Path:
    return Path(os.environ.get("ITEMS_DATA_PATH") or _DEFAULT_PATH)


def _empty_state() -> dict[str, Any]:
    return {"users": {}, "effects": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entries in users.items():
            if not isinstance(entries, dict):
                continue
            cleaned = {}
            for item_id, entry in entries.items():
                if item_id not in ITEM_DEFS or not isinstance(entry, dict):
                    continue
                count = entry.get("count")
                if not isinstance(count, (int, float)) or int(count) <= 0:
                    continue
                expires = entry.get("expires")
                cleaned[item_id] = {
                    "count": int(count),
                    "expires": expires if isinstance(expires, str) else None,
                }
            if cleaned:
                state["users"][str(uid)] = cleaned
    effects = raw.get("effects")
    if isinstance(effects, dict):
        for uid, user_effects in effects.items():
            if not isinstance(user_effects, dict):
                continue
            cleaned = {
                str(k): v for k, v in user_effects.items() if isinstance(v, str)
            }
            if cleaned:
                state["effects"][str(uid)] = cleaned
    return state


# ---------------------------------------------------------------------------
# 能動効果ハンドラ（Phase 3・既存ゲームからの接続口）
#
# ハンドラは (store, user_id, item_def, now) を受け取り、発動結果の文言を返す。
# アイテムの消費（count の減算）は use_item 側が先に行う。時間効果は
# item_def["duration_hours"] から store が自動で期限を記録するので、
# ハンドラは「効果IDごとの追加処理」だけを書けばよい。
# ---------------------------------------------------------------------------

EffectHandler = Callable[["ItemStore", str, dict[str, Any], datetime], str]
EFFECT_HANDLERS: dict[str, EffectHandler] = {}


def register_effect(effect_id: str) -> Callable[[EffectHandler], EffectHandler]:
    def decorator(func: EffectHandler) -> EffectHandler:
        EFFECT_HANDLERS[effect_id] = func
        return func

    return decorator


@register_effect(FEE_DISCOUNT_EFFECT)
def _fee_discount_handler(store: "ItemStore", user_id: str, definition: dict[str, Any],
                          now: datetime) -> str:
    hours = definition.get("duration_hours") or 0
    return f"{definition['name']}を使いました。{hours}時間、市場の売買手数料が半額になります。"


class ItemStore:
    """所持・効果・宝箱抽選と JSON 保存（同期 API、メモリ主体）。

    コインの実移動は行わない。購入／売却／宝箱コインの受け渡しは
    呼び出し側（cogs/items.py）が wallet の安全な経路で行い、失敗したら
    rollback_* でこちらの変更を巻き戻す（core/market.py と同じ組み立て）。
    """

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
            logger.exception("items: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 所持
    def _purge_user_locked(self, user_id: str, now: datetime) -> None:
        """期限切れの所持と効果を参照時に落とす（lazy 削除）。"""
        entries = self._state["users"].get(user_id)
        if entries:
            for item_id in list(entries):
                expires = entries[item_id].get("expires")
                if expires:
                    try:
                        expired = datetime.fromisoformat(expires) <= now
                    except ValueError:
                        expired = True
                    if expired:
                        del entries[item_id]
            if not entries:
                self._state["users"].pop(user_id, None)
        effects = self._state["effects"].get(user_id)
        if effects:
            for effect_id in list(effects):
                try:
                    expired = datetime.fromisoformat(effects[effect_id]) <= now
                except ValueError:
                    expired = True
                if expired:
                    del effects[effect_id]
            if not effects:
                self._state["effects"].pop(user_id, None)

    def count(self, user_id: str, item_id: str, now: datetime | None = None) -> int:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entry = self._state["users"].get(str(user_id), {}).get(item_id)
            return int(entry["count"]) if entry else 0

    def inventory(self, user_id: str, now: datetime | None = None) -> dict[str, int]:
        """所持一覧 {item_id: count}（期限切れは落とした後の状態）。"""
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            return {
                item_id: int(entry["count"])
                for item_id, entry in self._state["users"].get(str(user_id), {}).items()
            }

    def add(self, user_id: str, item_id: str, amount: int = 1, *,
            expires_at: datetime | None = None, now: datetime | None = None) -> int:
        """所持を増やす。expires_at は将来の消費期限つき配布用（Phase 3 向け）。"""
        if item_id not in ITEM_DEFS:
            raise ItemError("そのアイテムは存在しません。")
        if amount <= 0:
            raise ItemError("数量を正しく入力してください。")
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entries = self._state["users"].setdefault(str(user_id), {})
            entry = entries.setdefault(item_id, {"count": 0, "expires": None})
            entry["count"] += amount
            if expires_at is not None:
                entry["expires"] = expires_at.astimezone(JST).isoformat()
            self._mark_dirty()
            return int(entry["count"])

    def remove(self, user_id: str, item_id: str, amount: int = 1,
               now: datetime | None = None) -> int:
        """所持を減らす（使い切り・消費）。不足したら ItemError で何も変えない。"""
        if item_id not in ITEM_DEFS:
            raise ItemError("そのアイテムは存在しません。")
        if amount <= 0:
            raise ItemError("数量を正しく入力してください。")
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entries = self._state["users"].get(str(user_id), {})
            entry = entries.get(item_id)
            if entry is None or int(entry["count"]) < amount:
                raise ItemError(f"{ITEM_DEFS[item_id]['name']}が不足しています。")
            entry["count"] -= amount
            remaining = int(entry["count"])
            if remaining <= 0:
                del entries[item_id]
                if not entries:
                    self._state["users"].pop(str(user_id), None)
            self._mark_dirty()
            return remaining

    # ------------------------------------------------------------------ 効果
    def effect_expires(self, user_id: str, effect_id: str,
                       now: datetime | None = None) -> datetime | None:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            raw = self._state["effects"].get(str(user_id), {}).get(effect_id)
            if not raw:
                return None
            try:
                return datetime.fromisoformat(raw)
            except ValueError:
                return None

    def has_effect(self, user_id: str, effect_id: str, now: datetime | None = None) -> bool:
        return self.effect_expires(user_id, effect_id, now) is not None

    def active_effects(self, user_id: str, now: datetime | None = None) -> dict[str, datetime]:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            result = {}
            for effect_id, raw in self._state["effects"].get(str(user_id), {}).items():
                try:
                    result[effect_id] = datetime.fromisoformat(raw)
                except ValueError:
                    continue
            return result

    def _activate_effect_locked(self, user_id: str, effect_id: str,
                                duration_hours: float, now: datetime) -> None:
        expires = now + timedelta(hours=duration_hours)
        current = self._state["effects"].get(user_id, {}).get(effect_id)
        if current:
            try:
                # 既に発動中なら残り時間に積み増す（原典の expires 上書き回避に相当）。
                expires = max(expires, datetime.fromisoformat(current) + timedelta(hours=duration_hours))
            except ValueError:
                pass
        self._state["effects"].setdefault(user_id, {})[effect_id] = expires.astimezone(JST).isoformat()

    def use_item(self, user_id: str, item_id: str, now: datetime | None = None) -> str:
        """アイテムを1個使って能動効果を発動する。発動結果の文言を返す。"""
        now = now or datetime.now(JST)
        definition = ITEM_DEFS.get(item_id)
        if definition is None:
            raise ItemError("そのアイテムは存在しません。")
        effect_id = definition.get("effect")
        handler = EFFECT_HANDLERS.get(effect_id) if effect_id else None
        if handler is None:
            raise ItemError(f"{definition['name']}は使う効果がありません。")
        with self._lock:
            # remove は RLock で再入する。消費に失敗したら効果は付けない。
            self.remove(user_id, item_id, 1, now)
            duration = definition.get("duration_hours")
            if duration:
                self._activate_effect_locked(str(user_id), effect_id, float(duration), now)
            message = handler(self, str(user_id), definition, now)
            self._mark_dirty()
            return message

    def rollback_use(self, user_id: str, item_id: str, now: datetime | None = None) -> None:
        """use_item の巻き戻し（効果の期限は元に戻さず、アイテムだけ返す簡易版）。"""
        self.add(user_id, item_id, 1, now=now)

    # ------------------------------------------------------------------ 宝箱
    def roll_box(self, rng: random.Random | None = None) -> dict[str, Any]:
        """宝箱1個の抽選結果 {"coins": int, "items": {item_id: count}}（状態は変えない）。"""
        rng = rng or self._rng
        coins = 0
        items: dict[str, int] = {}
        for row in BOX_DROPS:
            if rng.random() >= row["chance"]:
                continue
            amount = rng.randint(row["min"], row["max"])
            if row["kind"] == "coins":
                coins += amount
            else:
                item_id = row["item"]
                # 除外リストと定義フラグのどちらかで止まっていたら出さない。
                if item_id in BOX_NEVER_DROP or not ITEM_DEFS[item_id].get("box_drop", True):
                    continue
                items[item_id] = items.get(item_id, 0) + amount
        return {"coins": coins, "items": items}

    def open_boxes(self, user_id: str, amount: int | None = None,
                   now: datetime | None = None) -> dict[str, Any]:
        """宝箱を amount 個（None = 全て）開ける。集約結果を返す。

        コインの実付与は呼び出し側が行う。失敗時は rollback_open で巻き戻す。
        """
        now = now or datetime.now(JST)
        with self._lock:
            held = self.count(user_id, "treasure_box", now)
            if held <= 0:
                raise ItemError("宝箱を持っていません。")
            opening = held if amount is None else min(amount, held)
            if opening <= 0:
                raise ItemError("数量を正しく入力してください。")
            self.remove(user_id, "treasure_box", opening, now)
            coins = 0
            items: dict[str, int] = {}
            for _ in range(opening):
                rolled = self.roll_box()
                coins += rolled["coins"]
                for item_id, count in rolled["items"].items():
                    items[item_id] = items.get(item_id, 0) + count
            for item_id, count in items.items():
                self.add(user_id, item_id, count, now=now)
            self._mark_dirty()
            return {"opened": opening, "coins": coins, "items": items}

    def rollback_open(self, user_id: str, result: dict[str, Any],
                      now: datetime | None = None) -> None:
        """open_boxes の巻き戻し（コイン付与に失敗したとき用）。"""
        now = now or datetime.now(JST)
        with self._lock:
            for item_id, count in result.get("items", {}).items():
                try:
                    self.remove(user_id, item_id, count, now)
                except ItemError:
                    logger.exception("items: 宝箱の巻き戻しで所持が合いません user=%s item=%s",
                                     user_id, item_id)
            self.add(user_id, "treasure_box", int(result.get("opened", 0)), now=now)
