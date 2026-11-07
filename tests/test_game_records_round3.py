"""ラウンド3のソロ記録（core/game/game/game_records.py 追加分）のテスト。"""

import tempfile
import unittest
from pathlib import Path

from core.game.game import game_records
class Round3RecordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = game_records.GameRecordsStore(Path(self.tmp.name) / "game_records.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_highlow_best_streak(self):
        e = self.store.record_highlow(1, 5)
        self.assertEqual((e["plays"], e["best_streak"], e["total_correct"]), (1, 5, 5))
        self.assertTrue(e["best_updated"])
        e = self.store.record_highlow(1, 3)
        self.assertEqual((e["plays"], e["best_streak"], e["total_correct"]), (2, 5, 8))
        self.assertFalse(e["best_updated"])
        self.assertEqual(self.store.get_highlow(1)["best_streak"], 5)
        self.assertIsNone(self.store.get_highlow(999))

    def test_2048_records(self):
        e = self.store.record_2048(1, 12000, 1024)
        self.assertEqual((e["best_score"], e["best_tile"], e["clears"]), (12000, 1024, 0))
        e = self.store.record_2048(1, 9000, 2048)
        self.assertEqual((e["best_score"], e["best_tile"], e["clears"]), (12000, 2048, 1))
        self.assertFalse(e["best_updated"])  # スコアは更新されていない
        self.assertEqual(self.store.get_2048(1)["plays"], 2)

    def test_sudoku_best_time_per_difficulty(self):
        self.store.record_sudoku(1, "easy", False, None)
        e = self.store.record_sudoku(1, "easy", True, 300.0)
        self.assertEqual(e["best_seconds"], 300.0)
        e = self.store.record_sudoku(1, "easy", True, 250.0)
        self.assertEqual(e["best_seconds"], 250.0)
        e = self.store.record_sudoku(1, "easy", True, 400.0)
        self.assertEqual(e["best_seconds"], 250.0)
        self.assertEqual((e["plays"], e["clears"]), (4, 3))
        self.assertIsNone(self.store.get_sudoku(1, "hard"))
        self.store.record_sudoku(1, "daily", True, 500.0)
        self.assertEqual(self.store.get_sudoku(1, "daily")["best_seconds"], 500.0)

    def test_nonogram_best_time_per_size(self):
        self.store.record_nonogram(1, "5x5", True, 120.0)
        e = self.store.record_nonogram(1, "5x5", True, 90.0)
        self.assertEqual(e["best_seconds"], 90.0)
        self.assertIsNone(self.store.get_nonogram(1, "8x8"))
        self.store.record_nonogram(1, "8x8", True, 600.0)
        self.assertEqual(self.store.get_nonogram(1, "8x8")["best_seconds"], 600.0)

    def test_twochoice_participation(self):
        e = self.store.record_twochoice(1, votes=5, minority=2)
        self.assertEqual((e["sessions"], e["votes"], e["minority"]), (1, 5, 2))
        e = self.store.record_twochoice(1, votes=5, minority=1)
        self.assertEqual((e["sessions"], e["votes"], e["minority"]), (2, 10, 3))
        self.assertIsNone(self.store.get_twochoice(999))

    def test_persistence_roundtrip(self):
        self.store.record_highlow(7, 9)
        self.store.record_sudoku(7, "normal", True, 111.0)
        self.store.flush()  # 保存は遅延されるため明示的に書き出す
        loaded = game_records.GameRecordsStore(Path(self.tmp.name) / "game_records.json")
        self.assertEqual(loaded.get_highlow(7)["best_streak"], 9)
        self.assertEqual(loaded.get_sudoku(7, "normal")["best_seconds"], 111.0)


if __name__ == "__main__":
    unittest.main()
