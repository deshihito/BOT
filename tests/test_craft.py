"""core/craft.py（合成レシピ・即時合成）と委託加工の重み付けのテスト。

見るもの: レシピ定義の整合（参照アイテムが全て実在、重みが正、入力ペアの
重複なし）、隠しレシピが一覧に出ず合成はできること、チェーンの最終
到達点（アゴコア）が上位素材同士からしか生まれないこと、合成の保存則
（素材不足で無変更、同素材2個の扱い、消費と成果物の対応）、シード固定で
結果がテーブルの範囲内に収まること、委託加工のレア重み倍率が効くこと。
"""
from __future__ import annotations

import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import craft, items


def _store(tmp: str, rng=None) -> items.ItemStore:
    return items.ItemStore(Path(tmp) / "items.json", rng=rng or random.Random(42))


class RecipeDefinitionTest(unittest.TestCase):
    def test_all_references_exist_and_weights_are_positive(self):
        for recipe in craft.RECIPES:
            a, b = recipe["inputs"]
            self.assertIn(a, items.ITEM_DEFS, recipe)
            self.assertIn(b, items.ITEM_DEFS, recipe)
            self.assertTrue(recipe["outcomes"], recipe)
            for item_id, count, weight, _rare in recipe["outcomes"]:
                self.assertIn(item_id, items.ITEM_DEFS, recipe)
                self.assertGreater(count, 0, recipe)
                self.assertGreater(weight, 0, recipe)
            # 各レシピに最低1つはレア結果がある（委託加工の倍率が常に意味を持つ）。
            self.assertTrue(any(row[3] for row in recipe["outcomes"]), recipe)

    def test_no_duplicate_input_pairs(self):
        keys = [craft.recipe_key(*recipe["inputs"]) for recipe in craft.RECIPES]
        self.assertEqual(len(keys), len(set(keys)))

    def test_find_recipe_is_order_insensitive(self):
        self.assertIsNotNone(craft.find_recipe("scrap", "metal_piece"))
        self.assertIs(
            craft.find_recipe("scrap", "metal_piece"),
            craft.find_recipe("metal_piece", "scrap"))
        self.assertIsNone(craft.find_recipe("scrap", "fee_pass"))
        self.assertIsNone(craft.find_recipe("treasure_box", "scrap"))

    def test_hidden_recipes_are_not_listed_but_exist(self):
        public_keys = {craft.recipe_key(*r["inputs"]) for r in craft.public_recipes()}
        hidden_keys = {craft.recipe_key(*r["inputs"]) for r in craft.hidden_recipes()}
        self.assertTrue(hidden_keys)
        self.assertFalse(public_keys & hidden_keys)
        self.assertEqual(len(public_keys) + len(hidden_keys), len(craft.RECIPES))
        for key in hidden_keys:
            self.assertIsNotNone(craft.find_recipe(*key))

    def test_ago_core_only_comes_from_upper_tier_inputs(self):
        upper = {"reinforced_frame", "reinforced_alloy", "mystery_crystal",
                 "precision_parts"}
        producers = [
            recipe for recipe in craft.RECIPES
            if any(row[0] == "ago_core" for row in recipe["outcomes"])
        ]
        self.assertTrue(producers)
        for recipe in producers:
            self.assertTrue(set(recipe["inputs"]) <= upper, recipe)
        self.assertIn("ago_core", items.ITEM_DEFS)
        self.assertEqual(items.ITEM_DEFS["ago_core"]["kind"], "collectible")
        self.assertFalse(items.ITEM_DEFS["ago_core"]["purchasable"])
        self.assertGreater(items.ITEM_DEFS["ago_core"]["sell_price"], 0)

    def test_new_materials_exist_and_are_not_purchasable(self):
        for item_id in ("alloy_plate", "circuit_board", "precision_parts",
                        "reinforced_frame"):
            self.assertIn(item_id, items.ITEM_DEFS)
            self.assertEqual(items.ITEM_DEFS[item_id]["kind"], "material")
            self.assertFalse(items.ITEM_DEFS[item_id]["purchasable"])


class ExecuteCraftTest(unittest.TestCase):
    def test_craft_consumes_inputs_and_adds_outcome(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "scrap", 2)
            result = craft.execute_craft(
                store, "1", "scrap", "scrap", rng=random.Random(7))
            recipe = craft.find_recipe("scrap", "scrap")
            self.assertIn(result["item"],
                          {row[0] for row in recipe["outcomes"]})
            expected = 2 - 2 + (result["count"] if result["item"] == "scrap" else 0)
            self.assertEqual(store.count("1", "scrap"), expected)
            if result["item"] != "scrap":
                self.assertEqual(store.count("1", result["item"]), result["count"])

    def test_same_material_pair_needs_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "scrap", 1)
            with self.assertRaises(items.ItemError):
                craft.execute_craft(store, "1", "scrap", "scrap", rng=random.Random(7))
            self.assertEqual(store.count("1", "scrap"), 1)

    def test_insufficient_materials_change_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "scrap", 1)
            with self.assertRaises(items.ItemError):
                craft.execute_craft(
                    store, "1", "scrap", "metal_piece", rng=random.Random(7))
            self.assertEqual(store.inventory("1"), {"scrap": 1})

    def test_unknown_combination_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "scrap", 1)
            store.add("1", "fee_pass", 1)
            with self.assertRaises(items.ItemError):
                craft.execute_craft(
                    store, "1", "scrap", "fee_pass", rng=random.Random(7))
            self.assertEqual(store.inventory("1"), {"scrap": 1, "fee_pass": 1})

    def test_hidden_recipe_can_be_crafted(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "gold_scrap", 2)
            result = craft.execute_craft(
                store, "1", "gold_scrap", "gold_scrap", rng=random.Random(3))
            self.assertIn(result["item"], {"mystery_crystal", "gold_scrap", "scrap"})
            self.assertEqual(store.count("1", "gold_scrap"),
                             2 - 2 + (1 if result["item"] == "gold_scrap" else 0))

    def test_rolls_stay_within_table(self):
        recipe = craft.find_recipe("reinforced_frame", "reinforced_alloy")
        allowed = {row[0] for row in recipe["outcomes"]}
        rng = random.Random(1234)
        for _ in range(500):
            item_id, count = craft.roll_outcome(recipe, rng)
            self.assertIn(item_id, allowed)
            self.assertEqual(count, 1)


class _FixedRandom(random.Random):
    """random() が常に固定値を返す rng（テーブルの端を踏むため）。"""

    def __init__(self, value: float):
        super().__init__()
        self._value = value

    def random(self) -> float:
        return self._value


class CommissionBoostTest(unittest.TestCase):
    def test_boost_doubles_only_rare_weights(self):
        recipe = craft.find_recipe("scrap", "scrap")
        base = craft.outcome_weights(recipe)
        boosted = craft.outcome_weights(recipe, rare_boost=2.0)
        for row, base_w, boosted_w in zip(recipe["outcomes"], base, boosted):
            if row[3]:
                self.assertEqual(boosted_w, base_w * 2.0)
            else:
                self.assertEqual(boosted_w, base_w)

    def test_boost_raises_rare_share(self):
        recipe = craft.find_recipe("scrap", "scrap")

        def rare_share(boost: float) -> float:
            weights = craft.outcome_weights(recipe, rare_boost=boost)
            rare = sum(w for row, w in zip(recipe["outcomes"], weights) if row[3])
            return rare / sum(weights)

        self.assertGreater(rare_share(2.0), rare_share(1.0))

    def test_roll_with_extreme_rng_hits_table_edges(self):
        recipe = craft.find_recipe("scrap", "scrap")
        first = recipe["outcomes"][0][0]
        last = recipe["outcomes"][-1][0]
        self.assertEqual(craft.roll_outcome(recipe, _FixedRandom(0.0))[0], first)
        self.assertEqual(craft.roll_outcome(recipe, _FixedRandom(0.999999))[0], last)

    def test_boosted_rolls_produce_more_rare_results(self):
        recipe = craft.find_recipe("metal_piece", "metal_piece")
        rare_items = {row[0] for row in recipe["outcomes"] if row[3]}

        def rare_count(boost: float) -> int:
            rng = random.Random(42)
            return sum(
                1 for _ in range(2000)
                if craft.roll_outcome(recipe, rng, rare_boost=boost)[0] in rare_items)

        self.assertGreater(rare_count(2.0), rare_count(1.0))


if __name__ == "__main__":
    unittest.main()
