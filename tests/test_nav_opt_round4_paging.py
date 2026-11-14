# -*- coding: utf-8 -*-
"""導線最適化ラウンド4の回帰テスト＋経済導線整理B（ジャンル分割）の固定。

R4-1: ジャンルが Discord のセレクト上限25件を超えた場合に備え、
GeneralPanel のアクションセレクトはページング化されている。
経済導線整理B（2026-11-14）で旧 money 36件を money / trade_craft /
play の3ジャンルへ分割し、全ジャンルが1ページに収まるようになった。
ページング機構そのものは合成ジャンルで固定し、実ジャンル側は
「全ジャンル25件以下・1ページ」を固定する。
"""
import unittest

from core.general.common import GENERAL_ACTIONS, GENERAL_GENRES
from core.general.panel import (
    GeneralActionSelect,
    GeneralPanel,
    general_action_pages,
)


def _action_select(panel):
    return next(c for c in panel.children if isinstance(c, GeneralActionSelect))


def _buttons(panel):
    return {c.custom_id: c for c in panel.children if getattr(c, "custom_id", None)}


#: 分割前の旧 money ジャンル36件（所属が変わるだけで増減しないことの固定）。
_OLD_MONEY_VALUES = {
    "money_panel", "daily_report", "status", "pay", "market", "token_buy",
    "token_sell", "items", "item_buy", "item_use", "box_open", "workshop",
    "machine_buy", "workshop_claim", "craft", "mining", "lottery",
    "lottery_buy", "steal", "slot", "double", "blackjack", "bj_duel", "dice",
    "coin_leaderboard", "role_shop", "gacha", "clan", "starter_claim",
    "daily_bonus_claim", "jailbreak", "item_sell", "role_shop_manage",
    "craft_commission", "gacha_party", "clan_manage",
}

_ECONOMY_GENRES = ("money", "trade_craft", "play")


class EconomyGenreSplitTest(unittest.TestCase):
    def test_genre_counts(self):
        self.assertEqual(len(GENERAL_ACTIONS["money"]), 10)
        self.assertEqual(len(GENERAL_ACTIONS["trade_craft"]), 15)
        self.assertEqual(len(GENERAL_ACTIONS["play"]), 11)

    def test_genre_labels_and_empty_descriptions(self):
        self.assertEqual(GENERAL_GENRES["trade_craft"], ("取引・生産", ""))
        self.assertEqual(GENERAL_GENRES["play"], ("あそぶ", ""))

    def test_split_preserves_all_actions_exactly_once(self):
        values = [
            value
            for genre in _ECONOMY_GENRES
            for _label, value in GENERAL_ACTIONS[genre]]
        self.assertEqual(set(values), _OLD_MONEY_VALUES)
        self.assertEqual(len(values), len(_OLD_MONEY_VALUES))

    def test_all_genres_fit_single_page(self):
        for genre, actions in GENERAL_ACTIONS.items():
            self.assertLessEqual(len(actions), 25, genre)
            self.assertEqual(len(general_action_pages(genre)), 1, genre)

    def test_money_panel_has_no_pager(self):
        panel = GeneralPanel(None, genre="money")
        select = _action_select(panel)
        self.assertEqual(
            [o.value for o in select.options],
            [value for _label, value in GENERAL_ACTIONS["money"]])
        ids = set(_buttons(panel))
        self.assertNotIn("panel:general:action_prev", ids)
        self.assertNotIn("panel:general:action_next", ids)
        self.assertNotIn("panel:general:action_indicator", ids)

    def test_saved_action_opens_first_page(self):
        panel = GeneralPanel(
            None, shortcut_mode=True,
            shortcut_item={"action": {"genre": "money", "value": "clan"}})
        self.assertEqual(panel.action_page, 0)
        select = _action_select(panel)
        self.assertIn("clan", [o.value for o in select.options])


class PagingMachineryTest(unittest.TestCase):
    """ページング機構そのものの固定（合成ジャンル36件で検証する）。"""

    GENRE = "__paging_test__"

    def setUp(self):
        GENERAL_ACTIONS[self.GENRE] = [
            (f"機能{i}", f"v{i}") for i in range(36)]

    def tearDown(self):
        GENERAL_ACTIONS.pop(self.GENRE, None)

    def test_pages_split_at_limit(self):
        pages = general_action_pages(self.GENRE)
        self.assertEqual([len(p) for p in pages], [25, 11])
        flat = [value for page in pages for _label, value in page]
        self.assertEqual(
            flat, [value for _label, value in GENERAL_ACTIONS[self.GENRE]])

    def test_first_page_select(self):
        select = GeneralActionSelect(None, self.GENRE, page=0)
        self.assertEqual(len(select.options), 25)
        self.assertIn("1/2", select.placeholder)

    def test_second_page_select_has_overflow_actions(self):
        select = GeneralActionSelect(None, self.GENRE, page=1)
        self.assertEqual(
            [o.value for o in select.options],
            [f"v{i}" for i in range(25, 36)])
        self.assertIn("2/2", select.placeholder)

    def test_panel_pager_buttons(self):
        panel = GeneralPanel(None, genre=self.GENRE)
        buttons = _buttons(panel)
        self.assertTrue(buttons["panel:general:action_prev"].disabled)
        self.assertFalse(buttons["panel:general:action_next"].disabled)
        self.assertEqual(
            buttons["panel:general:action_indicator"].label, "1 / 2ページ")
        panel.action_page = 1
        panel.refresh()
        buttons = _buttons(panel)
        self.assertFalse(buttons["panel:general:action_prev"].disabled)
        self.assertTrue(buttons["panel:general:action_next"].disabled)

    def test_saved_action_opens_its_page(self):
        panel = GeneralPanel(
            None, shortcut_mode=True,
            shortcut_item={"action": {"genre": self.GENRE, "value": "v30"}})
        self.assertEqual(panel.action_page, 1)
        select = _action_select(panel)
        self.assertIn("v30", [o.value for o in select.options])


if __name__ == "__main__":
    unittest.main()
