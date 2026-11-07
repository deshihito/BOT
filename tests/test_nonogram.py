"""ノノグラム（core/game/nonogram/nonogram.py）のテスト。パターン・ヒント・完成判定。"""

import random
import unittest

from core.game.nonogram.nonogram import PATTERNS, SIZES, NonogramBoard, NonogramPuzzle, clues_for


class CluesTest(unittest.TestCase):
    def test_clues(self):
        self.assertEqual(clues_for("11011"), [2, 2])
        self.assertEqual(clues_for("00000"), [0])
        self.assertEqual(clues_for("11111"), [5])
        self.assertEqual(clues_for("10101"), [1, 1, 1])


class PatternTest(unittest.TestCase):
    def test_at_least_10_patterns_total(self):
        total = sum(len(v) for v in PATTERNS.values())
        self.assertGreaterEqual(total, 10)
        for key in SIZES:
            self.assertGreaterEqual(len(PATTERNS[key]), 5)

    def test_pattern_shapes(self):
        for key, entries in PATTERNS.items():
            n = int(key.split("x")[0])
            for name, rows in entries:
                with self.subTest(size=key, name=name):
                    self.assertEqual(len(rows), n)
                    for row in rows:
                        self.assertEqual(len(row), n)
                        self.assertTrue(set(row) <= {"0", "1"})

    def test_pick_and_clues_consistency(self):
        for key in SIZES:
            puzzle = NonogramPuzzle.pick(key, rng=random.Random(0))
            self.assertEqual(puzzle.n, int(key.split("x")[0]))
            self.assertEqual(len(puzzle.row_clues), puzzle.n)
            self.assertEqual(len(puzzle.col_clues), puzzle.n)


class BoardTest(unittest.TestCase):
    def make(self):
        puzzle = NonogramPuzzle("5x5", "テスト", ["10001", "01010", "00100", "01010", "10001"])
        return NonogramBoard(puzzle)

    def test_cycle(self):
        board = self.make()
        self.assertEqual(board.cycle(0, 0), 1)
        self.assertEqual(board.cycle(0, 0), 2)
        self.assertEqual(board.cycle(0, 0), 0)

    def test_wrong_filled_and_cleared(self):
        board = self.make()
        self.assertFalse(board.cleared())
        board.set_cell(0, 1, 1)  # 正解は0のマス
        self.assertEqual(board.wrong_filled(), 1)
        board.set_cell(0, 1, 0)
        for r in range(5):
            for c in range(5):
                if board.puzzle.solution[r][c] == 1:
                    board.set_cell(r, c, 1)
        self.assertEqual(board.wrong_filled(), 0)
        self.assertTrue(board.cleared())

    def test_x_marks_do_not_block_clear(self):
        board = self.make()
        for r in range(5):
            for c in range(5):
                board.set_cell(r, c, 1 if board.puzzle.solution[r][c] == 1 else 2)
        self.assertTrue(board.cleared())


if __name__ == "__main__":
    unittest.main()
