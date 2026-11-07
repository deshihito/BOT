"""ボード系 Elo（core/game/game/elo.py）のテスト。"""
import tempfile
import unittest
from pathlib import Path

from core.game.game import elo
class EloMathTest(unittest.TestCase):
    def test_equal_ratings_change_by_half_k(self):
        dw, dl = elo.match_changes(1500.0, 1500.0)
        self.assertAlmostEqual(dw, 16.0)
        self.assertAlmostEqual(dl, -16.0)

    def test_underdog_win_gains_more(self):
        dw_fav, _ = elo.match_changes(1700.0, 1300.0)
        dw_dog, _ = elo.match_changes(1300.0, 1700.0)
        self.assertGreater(dw_dog, dw_fav)

    def test_draw_between_equals_is_zero(self):
        da, db = elo.draw_changes(1500.0, 1500.0)
        self.assertAlmostEqual(da, 0.0)
        self.assertAlmostEqual(db, 0.0)

    def test_draw_stronger_loses_points(self):
        da, db = elo.draw_changes(1700.0, 1300.0)
        self.assertLess(da, 0)
        self.assertGreater(db, 0)


class EloStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = elo.EloStore(Path(self.tmp.name) / "elo.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_record_match_and_top(self):
        result = self.store.record_match(100, "chess", 1, 2)
        self.assertAlmostEqual(result["winner"]["rating"], 1516.0)
        self.assertAlmostEqual(result["loser"]["rating"], 1484.0)
        rows = self.store.top(100, "chess")
        self.assertEqual(rows[0][0], 1)
        self.assertEqual(rows[0][2], 1)  # wins
        self.assertEqual(rows[1][3], 1)  # losses

    def test_games_and_guilds_are_separate(self):
        self.store.record_match(100, "chess", 1, 2)
        self.assertEqual(self.store.top(100, "shogi"), [])
        self.assertEqual(self.store.top(200, "chess"), [])

    def test_draw_counts(self):
        self.store.record_draw(100, "othello", 1, 2)
        rows = dict((r[0], r) for r in self.store.top(100, "othello"))
        self.assertEqual(rows[1][4], 1)
        self.assertEqual(rows[2][4], 1)

    def test_unknown_game_ignored(self):
        self.assertEqual(self.store.record_match(100, "uno", 1, 2), {})

    def test_persistence(self):
        self.store.record_match(100, "shogi", 5, 6)
        reloaded = elo.EloStore(Path(self.tmp.name) / "elo.json")
        self.assertAlmostEqual(reloaded.get(100, "shogi", 5)["rating"], 1516.0)


if __name__ == "__main__":
    unittest.main()
