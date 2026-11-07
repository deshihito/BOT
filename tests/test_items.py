"""core/general/items/items.py（アイテム基盤・ショップ・宝箱）と市場の手数料フックのテスト。

見るもの: 定義の整合（説明・価格があり「実装中」がない）、所持の増減と
期限切れの lazy 削除、購入／売却の保存則（コインと所持の対応、残高不足で
不変）、手数料パスの効果が市場の手数料計算に実際に効くこと、宝箱ドロップの
範囲と除外リスト遵守（シード固定）、保存と読み戻し、レジストリ登録。
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.general import action_registry
from core.general.items import items
from core.general.market import market
from cogs import general as wallet_module
# cog は冒頭で import する: 他テストの cog 再読込後だと wallet の
# INSUFFICIENT と同一性が崩れるため（test_giveaway と同じ流儀）。
from cogs.general import ItemsCog
from cogs.general import MarketCog


def _store(tmp: str, rng=None) -> items.ItemStore:
    return items.ItemStore(Path(tmp) / "items.json", rng=rng or random.Random(42))


class DefinitionTest(unittest.TestCase):
    def test_all_definitions_are_complete_and_implemented(self):
        for item_id, definition in items.ITEM_DEFS.items():
            self.assertTrue(definition["name"], item_id)
            self.assertTrue(definition["desc"], item_id)
            self.assertNotIn("実装中", definition["name"] + definition["desc"], item_id)
            self.assertIsInstance(definition["price"], int, item_id)
            self.assertGreaterEqual(definition["price"], 0, item_id)
            self.assertIn(definition["kind"],
                          {"material", "collectible", "consumable", "box"}, item_id)
            if definition["purchasable"]:
                self.assertGreater(definition["price"], 0, item_id)
            if definition["sell_price"] is not None:
                self.assertGreater(definition["sell_price"], 0, item_id)
                self.assertLess(definition["sell_price"], definition["price"], item_id)
            # 効果IDがあるなら実体（ハンドラ）も必ずある＝未実装アイテムを作らない。
            if definition["effect"] is not None:
                self.assertIn(definition["effect"], items.EFFECT_HANDLERS, item_id)
                self.assertIsNotNone(definition["duration_hours"], item_id)

    def test_required_v1_items_exist(self):
        for item_id in ("scrap", "metal_piece", "circuit_piece", "reinforced_alloy",
                        "mystery_crystal", "gold_scrap", "fee_pass", "treasure_box"):
            self.assertIn(item_id, items.ITEM_DEFS)
        self.assertFalse(items.ITEM_DEFS["reinforced_alloy"]["purchasable"])
        self.assertFalse(items.ITEM_DEFS["mystery_crystal"]["purchasable"])
        self.assertEqual(items.ITEM_DEFS["fee_pass"]["effect"], items.FEE_DISCOUNT_EFFECT)
        self.assertIsNotNone(items.ITEM_DEFS["gold_scrap"]["sell_price"])

    def test_box_tables_are_consistent(self):
        for row in items.BOX_DROPS:
            self.assertGreater(row["chance"], 0)
            self.assertLessEqual(row["chance"], 1)
            if row["kind"] == "item":
                self.assertIn(row["item"], items.ITEM_DEFS)
                self.assertNotIn(row["item"], items.BOX_NEVER_DROP)
                self.assertTrue(items.ITEM_DEFS[row["item"]]["box_drop"])
        # 期待値が価格を下回る（開け続けても増えない）こと。
        ev = items.box_expected_value()
        self.assertGreater(ev, 0)
        self.assertLess(ev, items.BOX_PRICE)


class StoreTest(unittest.TestCase):
    def test_add_remove_and_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            self.assertEqual(store.add("1", "scrap", 3), 3)
            self.assertEqual(store.add("1", "scrap", 2), 5)
            self.assertEqual(store.count("1", "scrap"), 5)
            self.assertEqual(store.remove("1", "scrap", 5), 0)
            self.assertEqual(store.count("1", "scrap"), 0)
            self.assertEqual(store.inventory("1"), {})

    def test_remove_insufficient_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.add("1", "metal_piece", 1)
            with self.assertRaises(items.ItemError):
                store.remove("1", "metal_piece", 2)
            self.assertEqual(store.count("1", "metal_piece"), 1)
            with self.assertRaises(items.ItemError):
                store.remove("1", "not_an_item", 1)

    def test_expired_entries_are_purged_lazily(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            now = datetime(2026, 1, 1, tzinfo=items.JST)
            store.add("1", "scrap", 2, expires_at=now - timedelta(hours=1), now=now)
            self.assertEqual(store.count("1", "scrap", now), 0)
            self.assertEqual(store.inventory("1", now), {})
            # 期限内なら残る。
            store.add("1", "scrap", 2, expires_at=now + timedelta(hours=1), now=now)
            self.assertEqual(store.count("1", "scrap", now), 2)

    def test_use_item_activates_effect_and_consumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            now = datetime(2026, 1, 1, tzinfo=items.JST)
            with self.assertRaises(items.ItemError):
                store.use_item("1", "fee_pass", now)  # 持っていない
            store.add("1", "fee_pass", 1)
            store.add("1", "scrap", 1)
            message = store.use_item("1", "fee_pass", now)
            self.assertIn("手数料", message)
            self.assertEqual(store.count("1", "fee_pass", now), 0)
            self.assertTrue(store.has_effect("1", items.FEE_DISCOUNT_EFFECT, now))
            expires = store.effect_expires("1", items.FEE_DISCOUNT_EFFECT, now)
            self.assertEqual(expires, now + timedelta(hours=24))
            # 期限が切れたら lazy に消える。
            self.assertFalse(store.has_effect(
                "1", items.FEE_DISCOUNT_EFFECT, now + timedelta(hours=24, seconds=1)))
            # 使う効果のない素材は使えない（所持も減らない）。
            with self.assertRaises(items.ItemError):
                store.use_item("1", "scrap", now)
            self.assertEqual(store.count("1", "scrap", now), 1)

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            now = datetime(2026, 1, 1, tzinfo=items.JST)
            store.add("7", "gold_scrap", 2)
            store.add("7", "fee_pass", 1)
            store.use_item("7", "fee_pass", now)
            store.flush()
            loaded = _store(tmp)
            self.assertEqual(loaded.count("7", "gold_scrap", now), 2)
            self.assertTrue(loaded.has_effect("7", items.FEE_DISCOUNT_EFFECT, now))


class _FakeWallet:
    def __init__(self, balances: dict[str, int]):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False, create_with=None):
        if user_id not in self.balances:
            if create_with is None:
                return None
            self.balances[user_id] = create_with
        if require_funds and self.balances[user_id] + delta < 0:
            return wallet_module.INSUFFICIENT
        self.balances[user_id] += delta
        return self.balances[user_id]


class _FakeBot:
    def __init__(self, cogs: dict):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


class ShopFlowTest(unittest.TestCase):
    def _cog(self, tmp: str, balances: dict[str, int]):
        wallet = _FakeWallet(balances)
        store = _store(tmp)
        bot = _FakeBot({"WalletCog": wallet})
        return ItemsCog(bot, store=store), wallet, store

    def test_buy_moves_coins_and_items_together(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, store = self._cog(tmp, {"1": 1000})
            message = asyncio.run(cog.execute_buy(1, "metal_piece", 2))
            self.assertIn("買いました", message)
            self.assertEqual(wallet.balances["1"], 1000 - 2 * 400)
            self.assertEqual(store.count("1", "metal_piece"), 2)

    def test_buy_with_insufficient_funds_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, store = self._cog(tmp, {"1": 100})
            message = asyncio.run(cog.execute_buy(1, "metal_piece", 1))
            self.assertIn("不足", message)
            self.assertEqual(wallet.balances["1"], 100)
            self.assertEqual(store.count("1", "metal_piece"), 0)

    def test_buy_rejects_unpurchasable(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, store = self._cog(tmp, {"1": 10 ** 9})
            message = asyncio.run(cog.execute_buy(1, "mystery_crystal", 1))
            self.assertIn("買えません", message)
            self.assertEqual(store.count("1", "mystery_crystal"), 0)

    def test_sell_buyback(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, store = self._cog(tmp, {"1": 0})
            store.add("1", "gold_scrap", 2)
            message = asyncio.run(cog.execute_sell(1, "gold_scrap", 1))
            self.assertIn("売りました", message)
            self.assertEqual(wallet.balances["1"], items.ITEM_DEFS["gold_scrap"]["sell_price"])
            self.assertEqual(store.count("1", "gold_scrap"), 1)
            # 素材も含めて全アイテムが売却できる（売却額は購入価格の半分）。
            store.add("1", "scrap", 1)
            before = wallet.balances["1"]
            message = asyncio.run(cog.execute_sell(1, "scrap", 1))
            self.assertIn("売りました", message)
            self.assertEqual(
                wallet.balances["1"] - before,
                items.ITEM_DEFS["scrap"]["price"] // 2)
            self.assertEqual(store.count("1", "scrap"), 0)


class FeePassMarketTest(unittest.TestCase):
    def test_fee_pass_halves_market_fee(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _store(tmp)
            market_store = market.MarketStore(Path(tmp) / "market.json", rng=random.Random(42))
            wallet = _FakeWallet({"1": 10 ** 9, "2": 10 ** 9})

            items_cog = ItemsCog(_FakeBot({"WalletCog": wallet}), store=item_store)
            bot = _FakeBot({"WalletCog": wallet, "ItemsCog": items_cog})
            market_cog = MarketCog(bot, store=market_store)

            # パスなし: 手数料は通常の1%（10,000 AGO → 100）。
            plain = asyncio.run(market_cog.execute_buy(1, 10_000))
            self.assertIn("手数料 100 AGO", plain)
            self.assertEqual(market_store.token_balance("1"), 99.0)

            # パスを使うと半額（50）になり、受け取る量も増える。
            item_store.add("2", "fee_pass", 1)
            item_store.use_item("2", "fee_pass")
            discounted = asyncio.run(market_cog.execute_buy(2, 10_000))
            self.assertIn("手数料 50 AGO", discounted)
            self.assertEqual(market_store.token_balance("2"), 99.5)

            # core 単体でも fee_rate の上書きが効く（売り側）。
            quote = market_store.quote_sell(10.0, fee_rate=market.FEE_RATE * 0.5)
            self.assertEqual(quote["fee"], 5)


class BoxTest(unittest.TestCase):
    def test_open_boxes_respects_never_drop_and_consumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, random.Random(1234))
            store.add("1", "treasure_box", 30)
            result = store.open_boxes("1")
            self.assertEqual(result["opened"], 30)
            self.assertEqual(store.count("1", "treasure_box"), 0)
            self.assertGreaterEqual(result["coins"], 0)
            for item_id, count in result["items"].items():
                self.assertNotIn(item_id, items.BOX_NEVER_DROP)
                self.assertTrue(items.ITEM_DEFS[item_id]["box_drop"])
                self.assertGreater(count, 0)
                self.assertEqual(store.count("1", item_id), count)
            with self.assertRaises(items.ItemError):
                store.open_boxes("1")

    def test_open_boxes_is_deterministic_with_seed(self):
        results = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                store = _store(tmp, random.Random(99))
                store.add("1", "treasure_box", 10)
                results.append(store.open_boxes("1"))
        self.assertEqual(results[0], results[1])

    def test_rolls_never_yield_box_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, random.Random(5))
            for _ in range(500):
                rolled = store.roll_box()
                self.assertNotIn("treasure_box", rolled["items"])


class RegistryTest(unittest.TestCase):
    def test_item_actions_registered_and_state_changers_blocked(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES

        specs = action_registry.build_general_actions(GENERAL_ACTIONS, GENERAL_GENRES)
        by_id = {spec.id: spec for spec in specs}
        for action_id in ("general:items", "general:item_buy",
                          "general:item_use", "general:box_open"):
            self.assertIn(action_id, by_id)
            self.assertEqual(by_id[action_id].genre, "money")
        for action_id in ("general:item_buy", "general:item_use", "general:box_open"):
            self.assertEqual(by_id[action_id].risk, "blocked")
            self.assertNotIn("aitools", by_id[action_id].surfaces)
        self.assertNotEqual(by_id["general:items"].risk, "blocked")


if __name__ == "__main__":
    unittest.main()
