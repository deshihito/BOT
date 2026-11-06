# -*- coding: utf-8 -*-
"""導線最適化ラウンド4の回帰テスト。

R4-1: マネージャンル（28件）が Discord のセレクト上限25件を超えたため、
GeneralPanel のアクションセレクトをページング化したことの固定。
"""
import unittest

from core.general.common import GENERAL_ACTIONS
from core.general.panel import (
    GeneralActionSelect,
    GeneralPanel,
    general_action_pages,
)


def _action_select(panel):
    return next(c for c in panel.children if isinstance(c, GeneralActionSelect))


def _buttons(panel):
    return {c.custom_id: c for c in panel.children if getattr(c, "custom_id", None)}


class MoneyGenrePagingTest(unittest.TestCase):
    def test_money_genre_exceeds_select_limit(self):
        # 前提の固定: マネーは上限25を超えている（ページングの根拠）。
        self.assertGreater(len(GENERAL_ACTIONS["money"]), 25)

    def test_pages_split_at_limit(self):
        pages = general_action_pages("money")
        self.assertEqual([len(p) for p in pages], [25, 3])
        flat = [value for page in pages for _label, value in page]
        self.assertEqual(flat, [value for _label, value in GENERAL_ACTIONS["money"]])

    def test_other_genres_single_page(self):
        for genre, actions in GENERAL_ACTIONS.items():
            if genre == "money":
                continue
            self.assertEqual(len(general_action_pages(genre)), 1, genre)
            self.assertLessEqual(len(actions), 25, genre)

    def test_first_page_options_within_limit(self):
        panel = GeneralPanel(None, genre="money")
        select = _action_select(panel)
        self.assertEqual(len(select.options), 25)
        self.assertIn("1/2", select.placeholder)
        buttons = _buttons(panel)
        self.assertTrue(buttons["panel:general:action_prev"].disabled)
        self.assertFalse(buttons["panel:general:action_next"].disabled)
        self.assertEqual(
            buttons["panel:general:action_indicator"].label, "1 / 2ページ")

    def test_second_page_has_overflow_actions(self):
        panel = GeneralPanel(None, genre="money")
        panel.action_page = 1
        panel.refresh()
        select = _action_select(panel)
        self.assertEqual(
            [o.value for o in select.options], ["role_shop", "gacha", "clan"])
        self.assertIn("2/2", select.placeholder)
        buttons = _buttons(panel)
        self.assertFalse(buttons["panel:general:action_prev"].disabled)
        self.assertTrue(buttons["panel:general:action_next"].disabled)

    def test_saved_action_opens_its_page(self):
        panel = GeneralPanel(
            None, shortcut_mode=True,
            shortcut_item={"action": {"genre": "money", "value": "clan"}})
        self.assertEqual(panel.action_page, 1)
        select = _action_select(panel)
        self.assertIn("clan", [o.value for o in select.options])

    def test_single_page_genre_has_no_pager(self):
        panel = GeneralPanel(None, genre="exp")
        ids = set(_buttons(panel))
        self.assertNotIn("panel:general:action_prev", ids)
        self.assertNotIn("panel:general:action_next", ids)
        self.assertNotIn("panel:general:action_indicator", ids)



if __name__ == "__main__":
    unittest.main()
