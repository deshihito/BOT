# -*- coding: utf-8 -*-
"""合成（クラフト）のレシピ定義と実行ロジックの単一の置き場。

パンBot 資産移植 Phase 3。原典の「2アイテム合成＋確率テーブル＋
ハズレ素材に出口がある段階式チェーン」という構造を採るが、レシピの
中身（名前・組み合わせ・確率）は AGO 用に新規作成する。チェーンの
最終到達点は原典のロールではなく、レアアイテム「アゴコア」
（コレクション＋高額 buyback）に替えてある。

設計の要点:
- レシピは宣言的定義（入力ペアは順序なし、結果は重み付きテーブル）。
  失敗時は主にスクラップ等の低位素材が返るので、素材が消えて
  終わりにならない（原典の「ゴミに出口がある」感触の再現）。
- 合成は ItemStore の remove → add で行い、保存則を保つ。素材不足は
  remove の前に所持数を数えて判定し、ItemError で何も変えない。
- コイン手数料は v1 では取らない。素材の消費自体がシンクになる。
- 一部のレシピは hidden=True で、ヘルプ（パネルのレシピ一覧）には
  載せない（原典の隠し組み合わせの流儀）。合成自体は可能。
- 委託加工（core/workshop.py）は同じテーブルを rare 重み倍率つきで
  引く。rare=True の結果行が「レア結果」で、倍率の対象になる。
"""
from __future__ import annotations

import random
from datetime import datetime
from typing import Any

from core.items import ITEM_DEFS, ItemError, ItemStore

# ---------------------------------------------------------------------------
# レシピ定義（宣言的テーブル）
#
# inputs: 素材2種（順序なし。同じ素材2個の場合は同じIDを2回書く）
# outcomes: (結果アイテムID, 個数, 重み, レアか) のタプル。重みは相対値
# hidden: True のレシピはパネルの一覧に出さない
# ---------------------------------------------------------------------------

RECIPES: tuple[dict[str, Any], ...] = (
    # --- 下位: スクラップ起点。失敗作もスクラップとして戻る ---
    {"inputs": ("scrap", "scrap"), "hidden": False, "outcomes": (
        ("metal_piece", 1, 50, False), ("scrap", 1, 35, False),
        ("gold_scrap", 1, 15, True))},
    {"inputs": ("scrap", "metal_piece"), "hidden": False, "outcomes": (
        ("circuit_piece", 1, 35, False), ("metal_piece", 1, 35, False),
        ("scrap", 1, 25, False), ("gold_scrap", 1, 5, True))},
    {"inputs": ("scrap", "circuit_piece"), "hidden": False, "outcomes": (
        ("circuit_piece", 1, 45, False), ("metal_piece", 1, 30, False),
        ("scrap", 1, 15, False), ("precision_parts", 1, 10, True))},
    {"inputs": ("scrap", "gold_scrap"), "hidden": False, "outcomes": (
        ("metal_piece", 1, 60, False), ("scrap", 1, 30, False),
        ("gold_scrap", 1, 10, True))},
    # --- 中位: 金属片・回路片から中間素材へ ---
    {"inputs": ("metal_piece", "metal_piece"), "hidden": False, "outcomes": (
        ("circuit_piece", 1, 50, False), ("metal_piece", 1, 30, False),
        ("alloy_plate", 1, 20, True))},
    {"inputs": ("metal_piece", "circuit_piece"), "hidden": False, "outcomes": (
        ("circuit_board", 1, 45, False), ("circuit_piece", 1, 35, False),
        ("alloy_plate", 1, 20, True))},
    {"inputs": ("metal_piece", "gold_scrap"), "hidden": False, "outcomes": (
        ("circuit_piece", 1, 40, False), ("metal_piece", 1, 40, False),
        ("gold_scrap", 1, 20, True))},
    {"inputs": ("circuit_piece", "circuit_piece"), "hidden": False, "outcomes": (
        ("circuit_board", 1, 40, False), ("circuit_piece", 1, 35, False),
        ("precision_parts", 1, 25, True))},
    {"inputs": ("alloy_plate", "alloy_plate"), "hidden": False, "outcomes": (
        ("reinforced_frame", 1, 45, False), ("alloy_plate", 1, 35, False),
        ("reinforced_alloy", 1, 20, True))},
    {"inputs": ("circuit_board", "circuit_board"), "hidden": False, "outcomes": (
        ("precision_parts", 1, 50, False), ("circuit_board", 1, 35, False),
        ("reinforced_alloy", 1, 15, True))},
    # --- 上位: 中間素材から強化合金・強化フレーム・精密部品へ ---
    {"inputs": ("alloy_plate", "metal_piece"), "hidden": False, "outcomes": (
        ("reinforced_frame", 1, 40, False), ("alloy_plate", 1, 35, False),
        ("reinforced_alloy", 1, 25, True))},
    {"inputs": ("alloy_plate", "circuit_board"), "hidden": False, "outcomes": (
        ("reinforced_frame", 1, 35, False), ("precision_parts", 1, 30, False),
        ("reinforced_alloy", 1, 20, True), ("scrap", 1, 15, False))},
    {"inputs": ("circuit_board", "circuit_piece"), "hidden": False, "outcomes": (
        ("precision_parts", 1, 45, False), ("circuit_board", 1, 35, False),
        ("reinforced_alloy", 1, 20, True))},
    {"inputs": ("precision_parts", "precision_parts"), "hidden": False, "outcomes": (
        ("reinforced_alloy", 1, 40, False), ("precision_parts", 1, 52, False),
        ("mystery_crystal", 1, 8, True))},
    {"inputs": ("precision_parts", "circuit_board"), "hidden": False, "outcomes": (
        ("reinforced_alloy", 1, 35, False), ("precision_parts", 1, 40, False),
        ("circuit_board", 1, 20, False), ("mystery_crystal", 1, 5, True))},
    {"inputs": ("reinforced_alloy", "metal_piece"), "hidden": False, "outcomes": (
        ("reinforced_frame", 1, 50, False), ("reinforced_alloy", 1, 25, False),
        ("alloy_plate", 1, 20, False), ("mystery_crystal", 1, 5, True))},
    {"inputs": ("reinforced_alloy", "circuit_piece"), "hidden": False, "outcomes": (
        ("precision_parts", 1, 35, False), ("reinforced_alloy", 1, 40, False),
        ("reinforced_frame", 1, 20, False), ("mystery_crystal", 1, 5, True))},
    # --- 最終: アゴコアへの到達（隠し含む） ---
    {"inputs": ("reinforced_frame", "precision_parts"), "hidden": True, "outcomes": (
        ("ago_core", 1, 15, True), ("reinforced_frame", 1, 45, False),
        ("precision_parts", 1, 40, False))},
    {"inputs": ("reinforced_frame", "reinforced_alloy"), "hidden": False, "outcomes": (
        ("ago_core", 1, 25, True), ("reinforced_frame", 1, 40, False),
        ("reinforced_alloy", 1, 35, False))},
    {"inputs": ("mystery_crystal", "reinforced_alloy"), "hidden": True, "outcomes": (
        ("ago_core", 1, 30, True), ("reinforced_alloy", 1, 50, False),
        ("mystery_crystal", 1, 20, False))},
    {"inputs": ("mystery_crystal", "precision_parts"), "hidden": True, "outcomes": (
        ("ago_core", 1, 10, True), ("precision_parts", 1, 65, False),
        ("mystery_crystal", 1, 25, False))},
    {"inputs": ("gold_scrap", "gold_scrap"), "hidden": True, "outcomes": (
        ("mystery_crystal", 1, 10, True), ("gold_scrap", 1, 50, False),
        ("scrap", 1, 40, False))},
)


def recipe_key(item_a: str, item_b: str) -> tuple[str, str]:
    """入力ペアの正規化キー（順序なし）。"""
    return (item_a, item_b) if item_a <= item_b else (item_b, item_a)


_RECIPES_BY_KEY: dict[tuple[str, str], dict[str, Any]] = {
    recipe_key(*recipe["inputs"]): recipe for recipe in RECIPES
}


def find_recipe(item_a: str, item_b: str) -> dict[str, Any] | None:
    """素材2種からレシピを引く。無ければ None（隠しレシピも対象）。"""
    return _RECIPES_BY_KEY.get(recipe_key(item_a, item_b))


def public_recipes() -> tuple[dict[str, Any], ...]:
    """ヘルプ表示用のレシピ一覧（隠しレシピは含まない）。"""
    return tuple(recipe for recipe in RECIPES if not recipe["hidden"])


def hidden_recipes() -> tuple[dict[str, Any], ...]:
    return tuple(recipe for recipe in RECIPES if recipe["hidden"])


def craftable_item_ids() -> frozenset[str]:
    """いずれかのレシピの入力に使えるアイテムIDの集合。"""
    ids: set[str] = set()
    for recipe in RECIPES:
        ids.update(recipe["inputs"])
    return frozenset(ids)


def outcome_weights(recipe: dict[str, Any], rare_boost: float = 1.0) -> list[float]:
    """結果テーブルの実効重み。rare_boost はレア結果の重み倍率（委託加工用）。"""
    return [
        float(weight) * (rare_boost if rare else 1.0)
        for _item_id, _count, weight, rare in recipe["outcomes"]
    ]


def roll_outcome(recipe: dict[str, Any], rng: random.Random,
                 rare_boost: float = 1.0) -> tuple[str, int]:
    """結果テーブルを1回引く。(アイテムID, 個数) を返す（状態は変えない）。"""
    weights = outcome_weights(recipe, rare_boost)
    total = sum(weights)
    pick = rng.random() * total
    cumulative = 0.0
    for (item_id, count, _weight, _rare), effective in zip(recipe["outcomes"], weights):
        cumulative += effective
        if pick < cumulative:
            return item_id, count
    item_id, count, _w, _r = recipe["outcomes"][-1]
    return item_id, count


def consume_inputs(store: ItemStore, user_id: str, item_a: str, item_b: str,
                   now: datetime | None) -> None:
    """素材2個を消費する。不足したら ItemError で何も変えない。"""
    if item_a == item_b:
        if store.count(user_id, item_a, now) < 2:
            raise ItemError(f"{ITEM_DEFS[item_a]['name']}が2個必要です。")
        store.remove(user_id, item_a, 2, now)
        return
    for item_id in (item_a, item_b):
        if store.count(user_id, item_id, now) < 1:
            raise ItemError(f"{ITEM_DEFS[item_id]['name']}が不足しています。")
    removed: list[str] = []
    try:
        for item_id in (item_a, item_b):
            store.remove(user_id, item_id, 1, now)
            removed.append(item_id)
    except ItemError:
        for item_id in removed:
            store.add(user_id, item_id, 1, now=now)
        raise


def execute_craft(store: ItemStore, user_id: str, item_a: str, item_b: str,
                  rng: random.Random | None = None,
                  now: datetime | None = None) -> dict[str, Any]:
    """即時合成を1回実行する。素材を消費し、結果を所持に加える。

    レシピが無い組み合わせ・素材不足は ItemError（所持は不変）。
    戻り値: {"inputs": (a, b), "item": 結果ID, "count": 個数, "rare": bool}
    """
    if item_a not in ITEM_DEFS or item_b not in ITEM_DEFS:
        raise ItemError("そのアイテムは存在しません。")
    recipe = find_recipe(item_a, item_b)
    if recipe is None:
        raise ItemError("その組み合わせでは何も作れません。")
    consume_inputs(store, user_id, item_a, item_b, now)
    item_id, count = roll_outcome(recipe, rng or random.Random())
    store.add(user_id, item_id, count, now=now)
    rare = any(
        row_item == item_id and row_rare
        for row_item, _c, _w, row_rare in recipe["outcomes"]
    )
    return {"inputs": recipe_key(item_a, item_b), "item": item_id,
            "count": count, "rare": rare, "recipe": recipe}
