"""マインスイーパー（core/minesweeper.py + game_records の sweeper）のテスト。"""

import random
import unittest

from core import game_records
from core.minesweeper import COLS, ROWS, MinesweeperBoard


class BoardTest(unittest.TestCase):
    def make(self, difficulty="normal"):
        return MinesweeperBoard(difficulty, rng=random.Random(42))

    def test_first_open_is_always_safe_and_places_mines(self):
        for seed in range(30):
            board = MinesweeperBoard("hard", rng=random.Random(seed))
            board.open((0, 0))
            self.assertIsNone(board.exploded)
            self.assertEqual(len(board.mines), 8)
            self.assertNotIn((0, 0), board.mines)

    def test_open_number_cell_does_not_flood_wrongly(self):
        board = self.make()
        board.open((2, 2))
        self.assertTrue(board.opened)

    def test_flag_toggle(self):
        board = self.make()
        board.open((0, 0))
        cell = next((r, c) for r in range(ROWS) for c in range(COLS) if (r, c) not in board.opened)
        self.assertTrue(board.toggle_flag(cell))
        self.assertIn(cell, board.flags)
        self.assertEqual(board.open(cell), set())  # 旗のあるマスは開けない
        self.assertFalse(board.toggle_flag(cell))

    def test_explosion(self):
        board = self.make()
        board.open((0, 0))
        mine = next(iter(board.mines))
        board.open(mine)
        self.assertEqual(board.exploded, mine)
        self.assertFalse(board.cleared)

    def test_clear_detection(self):
        board = self.make("easy")
        board.open((0, 0))
        for r in range(ROWS):
            for c in range(COLS):
                if (r, c) not in board.mines:
                    board.open((r, c))
        self.assertTrue(board.cleared)
        self.assertIsNone(board.exploded)


class SweeperRecordTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.TemporaryDirectory()
        self.store = game_records.GameRecordsStore(Path(self.tmp.name) / "records.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_best_time_keeps_fastest(self):
        self.store.record_sweeper(7, "normal", True, 30.0)
        result = self.store.record_sweeper(7, "normal", True, 25.0)
        self.assertTrue(result["best_updated"])
        self.assertEqual(result["best_seconds"], 25.0)
        result = self.store.record_sweeper(7, "normal", True, 40.0)
        self.assertFalse(result["best_updated"])
        self.assertEqual(result["plays"], 3)
        self.assertEqual(result["clears"], 3)

    def test_failed_play_counts_without_best(self):
        result = self.store.record_sweeper(7, "easy", False, None)
        self.assertEqual(result["plays"], 1)
        self.assertEqual(result["clears"], 0)
        self.assertIsNone(result["best_seconds"])

    def test_persistence_roundtrip(self):
        self.store.record_sweeper(7, "hard", True, 12.5)
        self.store.flush()
        import tempfile
        from pathlib import Path
        reloaded = game_records.GameRecordsStore(Path(self.tmp.name) / "records.json")
        entry = reloaded.get_sweeper(7, "hard")
        self.assertEqual(entry["best_seconds"], 12.5)


if __name__ == "__main__":
    unittest.main()
