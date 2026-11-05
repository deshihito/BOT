# -*- coding: utf-8 -*-
"""導線最適化 M3（/game 1段化）の固定テスト。"""
import unittest


class GameHubOneStepTest(unittest.TestCase):
    def test_hub_shows_all_games_without_genre(self):
        from cogs.game import GameHubView, GameSelect, GameGenreSelect
        from core.game_guides import GAME_ORDER

        view = GameHubView(None)
        selects = [c for c in view.children if isinstance(c, GameSelect)]
        genres = [c for c in view.children if isinstance(c, GameGenreSelect)]
        self.assertEqual(len(genres), 1)  # ジャンルは絞り込みとして残る
        self.assertEqual(len(selects), 1)
        self.assertEqual(len(selects[0].options), len(GAME_ORDER))
        self.assertLessEqual(len(selects[0].options), 25)

    def test_hub_genre_filter_narrows_games(self):
        from cogs.game import GameHubView, GameSelect

        view = GameHubView(None)
        view.genre = "solo"
        view.refresh()
        selects = [c for c in view.children if isinstance(c, GameSelect)]
        self.assertEqual(len(selects), 1)
        values = [o.value for o in selects[0].options]
        self.assertEqual(sorted(values), ["flash", "guess", "shinkei", "wordle"])

    def test_custom_ids_unchanged(self):
        # PR-B 不変条件: 固定 custom_id は変更しない
        from cogs.game import GameHubView

        view = GameHubView(None)
        ids = [c.custom_id for c in view.children if getattr(c, "custom_id", None)]
        self.assertIn("panel:game:genre", ids)
        self.assertIn("panel:game:select", ids)


if __name__ == "__main__":
    unittest.main()
