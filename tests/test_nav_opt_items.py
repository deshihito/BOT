# -*- coding: utf-8 -*-
"""導線最適化 M10（アイテム名入力の選択式化）の固定テスト。"""
import types
import unittest


def _cog_with_inventory():
    from cogs.items import ItemsCog
    from core.general.items import items as items_core
    cog = ItemsCog(types.SimpleNamespace())
    cog.store = items_core.ItemStore()
    return cog


class ItemPickOptionsTest(unittest.TestCase):
    def test_buy_options_are_purchasable_only(self):
        from cogs.items import _item_pick_options
        from core.general.items import items as items_core
        cog = _cog_with_inventory()
        options = _item_pick_options(cog, 1, "buy")
        expected = [i for i, d in items_core.ITEM_DEFS.items() if d["purchasable"]]
        self.assertEqual([o.value for o in options], expected)
        self.assertTrue(all("AGO" in o.label for o in options))

    def test_sell_options_include_all_owned_items(self):
        # 全アイテム売却可能（売却額は購入価格の半分）になったため、
        # 売却候補は所持している全アイテムになる。
        from cogs.items import _item_pick_options
        from core.general.items import items as items_core
        cog = _cog_with_inventory()
        first, second = list(items_core.ITEM_DEFS)[:2]
        cog.store.add("1", first, 2)
        cog.store.add("1", second, 3)
        options = _item_pick_options(cog, 1, "sell")
        self.assertEqual(
            [o.value for o in options], sorted([first, second]))
        # 他人の所持は候補に出ない。
        self.assertEqual(_item_pick_options(cog, 2, "sell"), [])

    def test_use_options_are_inventory(self):
        from cogs.items import _item_pick_options
        from core.general.items import items as items_core
        cog = _cog_with_inventory()
        item_id = next(iter(items_core.ITEM_DEFS))
        cog.store.add("1", item_id, 1)
        options = _item_pick_options(cog, 1, "use")
        self.assertEqual([o.value for o in options], [item_id])
        self.assertEqual(_item_pick_options(cog, 2, "use"), [])


if __name__ == "__main__":
    unittest.main()
