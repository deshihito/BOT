"""マインスイーパー（core/game/minesweeper.py + game_records の sweeper）のテスト。"""

import random
import unittest

from core.game import game_records
from core.game.minesweeper import COLS, ROWS, MinesweeperBoard


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


class BigBoardTest(unittest.TestCase):
    """盤面画像化タスクで追加した大盤面（新キー wide/expert）。"""

    def test_sizes_and_mine_counts(self):
        from core.game.minesweeper import DIFFICULTIES
        self.assertEqual(DIFFICULTIES["wide"][1:], (10, 9, 9))
        self.assertEqual(DIFFICULTIES["expert"][1:], (35, 12, 16))
        # 従来キーは記録互換のため不変
        self.assertEqual(DIFFICULTIES["easy"][1:], (4, 4, 5))
        self.assertEqual(DIFFICULTIES["normal"][1:], (6, 4, 5))
        self.assertEqual(DIFFICULTIES["hard"][1:], (8, 4, 5))

    def test_first_open_safe_on_big_boards(self):
        for key in ("wide", "expert"):
            for seed in range(10):
                board = MinesweeperBoard(key, rng=random.Random(seed))
                board.open((5, 5))
                self.assertIsNone(board.exploded)
                self.assertEqual(len(board.mines), board.mine_total)
                self.assertNotIn((5, 5), board.mines)

    def test_clear_on_wide(self):
        board = MinesweeperBoard("wide", rng=random.Random(3))
        board.open((0, 0))
        for r in range(board.rows):
            for c in range(board.cols):
                if (r, c) not in board.mines:
                    board.open((r, c))
        self.assertTrue(board.cleared)


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
