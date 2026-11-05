"""HCD監査 quick fix #7（モーダルの入力手がかり）の回帰テスト。

- TradeModal: 買う/売るの両方に placeholder（例と形式）があること
- ItemAmountModal: アイテム名と数量に placeholder があり、
  「1固定です」の注意が use のときだけ表示されること
"""

from __future__ import annotations

import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from cogs.items import ItemAmountModal  # noqa: E402
from cogs.market import TradeModal  # noqa: E402


class TradeModalPlaceholderTest(unittest.TestCase):
    def test_buy_and_sell_have_placeholders(self):
        for side in ("buy", "sell"):
            modal = TradeModal(types.SimpleNamespace(), side)
            self.assertTrue(modal.amount.placeholder, side)
            self.assertIn("例:", modal.amount.placeholder)


class ItemAmountModalPlaceholderTest(unittest.TestCase):
    def test_item_and_amount_have_placeholders(self):
        for action in ("buy", "sell", "use"):
            modal = ItemAmountModal(types.SimpleNamespace(), action)
            self.assertTrue(modal.item.placeholder, action)
            self.assertTrue(modal.amount.placeholder, action)

    def test_fixed_amount_note_only_for_use(self):
        use_modal = ItemAmountModal(types.SimpleNamespace(), "use")
        self.assertIn("1固定", use_modal.amount.placeholder)
        for action in ("buy", "sell"):
            modal = ItemAmountModal(types.SimpleNamespace(), action)
            self.assertNotIn("1固定", modal.amount.placeholder)


if __name__ == "__main__":
    unittest.main()
