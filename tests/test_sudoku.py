"""数独（core/sudoku.py）のテスト。生成の一意性・難易度・デイリー。"""

import random
import unittest

from core.sudoku import DIFFICULTIES, count_solutions, daily_puzzle, generate, is_complete_and_valid, solve


def givens_count(grid):
    return sum(1 for row in grid for v in row if v)


class GenerateTest(unittest.TestCase):
    def test_difficulties_remove_expected_counts(self):
        for key, (_, removed) in DIFFICULTIES.items():
            with self.subTest(difficulty=key):
                puzzle, solution = generate(random.Random(11), key)
                self.assertEqual(givens_count(puzzle), 81 - removed)
                self.assertTrue(is_complete_and_valid(solution))
                # 与えられた数字は解と一致する
                for r in range(9):
                    for c in range(9):
                        if puzzle[r][c]:
                            self.assertEqual(puzzle[r][c], solution[r][c])

    def test_generated_puzzles_have_unique_solution(self):
        for key in DIFFICULTIES:
            with self.subTest(difficulty=key):
                puzzle, _ = generate(random.Random(99), key)
                self.assertEqual(count_solutions(puzzle, limit=2), 1)

    def test_solve_roundtrip(self):
        puzzle, solution = generate(random.Random(5), "normal")
        solved = solve([row[:] for row in puzzle])
        self.assertEqual(solved, solution)


class DailyTest(unittest.TestCase):
    def test_same_date_same_puzzle(self):
        p1, s1 = daily_puzzle("2026-11-06")
        p2, s2 = daily_puzzle("2026-11-06")
        self.assertEqual(p1, p2)
        self.assertEqual(s1, s2)

    def test_daily_is_normal_difficulty(self):
        puzzle, _ = daily_puzzle("2026-11-06")
        self.assertEqual(givens_count(puzzle), 81 - DIFFICULTIES["daily"][1])
        self.assertEqual(count_solutions(puzzle, limit=2), 1)


class ValidityTest(unittest.TestCase):
    def test_broken_grid_is_invalid(self):
        _, solution = generate(random.Random(3), "easy")
        broken = [row[:] for row in solution]
        broken[0][0] = broken[0][1]  # 同じ行に重複
        self.assertFalse(is_complete_and_valid(broken))
        incomplete = [row[:] for row in solution]
        incomplete[0][0] = 0
        self.assertFalse(is_complete_and_valid(incomplete))


if __name__ == "__main__":
    unittest.main()
