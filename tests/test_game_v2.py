# -*- coding: utf-8 -*-
"""ラウンド4の V2/ボタン上限/盤面画像の前提を検証する。"""
import unittest

import discord

from core.game.board_image import render_gauge, render_tiles
from core.game.game_guides import GAME_GUIDES, GAME_ORDER
from core.game.game_v2 import GamePanelView, assert_within_limits, count_buttons


class GamePanelV2Test(unittest.TestCase):
    def test_panel_is_native_layout_view_with_container(self):
        panel = GamePanelView("タイトル", "本文")
        self.assertIsInstance(panel, discord.ui.LayoutView)
        self.assertTrue(any(isinstance(item, discord.ui.Container) for item in panel.children))
        # V2 パネルに旧来 embed は混ざらない（LayoutView に embed 概念がないことの確認）
        self.assertFalse(hasattr(panel, "embed"))

    def test_button_limits(self):
        panel = GamePanelView("t", "b")
        buttons = [discord.ui.Button(label=f"{i:02d}") for i in range(5)]
        panel.add_row(*buttons)
        self.assertEqual(count_buttons(panel), 5)
        assert_within_limits(panel)

    def test_uniform_zero_padded_labels(self):
        # 価値観ゲージの目盛りラベルは 00〜10 のゼロ埋めで幅が均一
        labels = [f"{pos:02d}" for pos in range(11)]
        self.assertTrue(all(len(x) == 2 for x in labels))


class BoardImageTest(unittest.TestCase):
    def test_tiles_png(self):
        png = render_tiles([[("1", (200, 0, 0)), ("2", (0, 200, 0))]], title="t")
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 500)

    def test_gauge_png_with_and_without_center(self):
        self.assertTrue(render_gauge(5, guess=4, left="冷たい", right="熱い").startswith(b"\x89PNG"))
        self.assertTrue(render_gauge(None).startswith(b"\x89PNG"))


class Round4RegistrationTest(unittest.TestCase):
    NEW = ["justone", "ito", "insider", "gauge", "ruins", "hanabi", "hoshi", "liequiz"]

    def test_total_42_games(self):
        self.assertEqual(len(GAME_ORDER), 42)
        for game in self.NEW:
            self.assertIn(game, GAME_ORDER)
            self.assertIn(game, GAME_GUIDES)

    def test_party_genre_fits_one_select_page(self):
        from cogs.game import GAME_GENRE_BY_GAME, game_select_pages
        party = [g for g in GAME_ORDER if GAME_GENRE_BY_GAME[g] == "party"]
        self.assertEqual(len(party), 24)
        self.assertLessEqual(len(party), 25)
        pages = game_select_pages()
        self.assertEqual(sum(len(p) for p in pages), 42)
        self.assertTrue(all(len(p) <= 25 for p in pages))
        self.assertEqual(len(game_select_pages("party")), 1)

    def test_ranked_games_known(self):
        from core.game import party_ranking
        for game in ("insider", "hoshi", "liequiz", "gauge", "ruins"):
            self.assertIn(game, party_ranking.KNOWN_GAMES)


if __name__ == "__main__":
    unittest.main()
