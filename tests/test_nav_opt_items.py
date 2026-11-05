# -*- coding: utf-8 -*-
"""導線最適化 M10（アイテム名入力の選択式化）の固定テスト。"""
import types
import unittest


def _cog_with_inventory():
    from cogs.items import ItemsCog
    from core import items as items_core

    cog = ItemsCog(types.SimpleNamespace())
    cog.store = items_core.ItemStore()
    return cog


class ItemPickOptionsTest(unittest.TestCase):
    def test_buy_options_are_purchasable_only(self):
        from cogs.items import _item_pick_options
        from core import items as items_core

        cog = _cog_with_inventory()
        options = _item_pick_options(cog, 1, "buy")
        expected = [i for i, d in items_core.ITEM_DEFS.items() if d["purchasable"]]
        self.assertEqual([o.value for o in options], expected)
        self.assertTrue(all("AGO" in o.label for o in options))

    def test_sell_options_require_sell_price_and_ownership(self):
        from cogs.items import _item_pick_options
        from core import items as items_core

        cog = _cog_with_inventory()
        sellable = next(i for i, d in items_core.ITEM_DEFS.items()
                        if d["sell_price"] is not None)
        unsellable = next(i for i, d in items_core.ITEM_DEFS.items()
                          if d["sell_price"] is None)
        cog.store.add("1", sellable, 2)
        cog.store.add("1", unsellable, 3)
        options = _item_pick_options(cog, 1, "sell")
        self.assertEqual([o.value for o in options], [sellable])

    def test_use_options_are_inventory(self):
        from cogs.items import _item_pick_options
        from core import items as items_core

        cog = _cog_with_inventory()
        item_id = next(iter(items_core.ITEM_DEFS))
        cog.store.add("1", item_id, 1)
        options = _item_pick_options(cog, 1, "use")
        self.assertEqual([o.value for o in options], [item_id])
        self.assertEqual(_item_pick_options(cog, 2, "use"), [])


if __name__ == "__main__":
    unittest.main()
