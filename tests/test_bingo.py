"""ビンゴ（core/bingo.py）のテスト。"""

import random
import unittest

from core.bingo import COLUMN_RANGES, BingoCard, BingoSession, format_card


class CardTest(unittest.TestCase):
    def test_generated_card_ranges_and_uniqueness(self):
        card = BingoCard.generate(random.Random(3))
        seen = set()
        for c, (lo, hi) in enumerate(COLUMN_RANGES):
            for r in range(5):
                value = card.grid[r][c]
                if value is None:
                    self.assertEqual((r, c), (2, 2))
                    continue
                self.assertTrue(lo <= value <= hi)
                self.assertNotIn(value, seen)
                seen.add(value)
        self.assertEqual(len(seen), 24)
        self.assertTrue(card.marked[2][2])

    def test_row_bingo(self):
        grid = [[c * 10 + r + 1 for c in range(5)] for r in range(5)]
        grid[2][2] = None
        card = BingoCard(grid)
        for c in range(5):
            if grid[0][c] is not None:
                card.mark(grid[0][c])
        self.assertTrue(card.has_bingo())

    def test_reach_detection(self):
        grid = [[c * 10 + r + 1 for c in range(5)] for r in range(5)]
        grid[2][2] = None
        card = BingoCard(grid)
        for c in range(4):
            card.mark(grid[0][c])
        self.assertTrue(card.is_reach())
        self.assertFalse(card.has_bingo())

    def test_format_card(self):
        card = BingoCard.generate(random.Random(1))
        text = format_card(card)
        self.assertIn("★", text)
        self.assertEqual(len(text.splitlines()), 5)


class SessionTest(unittest.TestCase):
    def test_game_finishes_with_winner_within_75_draws(self):
        session = BingoSession([1, 2, 3], rng=random.Random(11))
        draws = 0
        while not session.finished and draws < 75:
            number, winners, _reach = session.draw_next()
            self.assertIsNotNone(number)
            draws += 1
            if winners:
                self.assertEqual(session.winners, winners)
        self.assertTrue(session.finished)
        self.assertTrue(session.winners)
        for uid in session.winners:
            self.assertTrue(session.cards[uid].has_bingo())

    def test_drawn_numbers_are_unique(self):
        session = BingoSession([1], rng=random.Random(5))
        seen = []
        while not session.finished:
            number, _w, _r = session.draw_next()
            seen.append(number)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertTrue(all(1 <= n <= 75 for n in seen))


if __name__ == "__main__":
    unittest.main()
