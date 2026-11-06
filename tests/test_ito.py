# -*- coding: utf-8 -*-
import random
import unittest

from core.ito import THEMES, ItoSession


class ItoBankTest(unittest.TestCase):
    def test_themes(self):
        self.assertGreaterEqual(len(THEMES), 100)
        self.assertEqual(len(THEMES), len(set(THEMES)))


class ItoSessionTest(unittest.TestCase):
    def test_numbers_unique_in_range(self):
        s = ItoSession([1, 2, 3, 4], ["強い武器"], rng=random.Random(7))
        s.next_round()
        self.assertEqual(len(set(s.numbers.values())), 4)
        self.assertTrue(all(1 <= v <= 100 for v in s.numbers.values()))

    def test_ascending_success(self):
        s = ItoSession([1, 2, 3], ["強い武器"], rng=random.Random(3))
        s.next_round()
        order = sorted(s.players, key=lambda uid: s.numbers[uid])
        for uid in order:
            self.assertTrue(s.play(uid))
        self.assertTrue(s.round_done)
        self.assertTrue(s.round_success)
        self.assertEqual(s.successes, 1)

    def test_wrong_order_fails_and_double_play_blocked(self):
        s = ItoSession([1, 2, 3], ["強い武器"], rng=random.Random(3))
        s.next_round()
        order = sorted(s.players, key=lambda uid: -s.numbers[uid])
        self.assertTrue(s.play(order[0]))
        self.assertFalse(s.play(order[0]))
        for uid in order[1:]:
            s.play(uid)
        self.assertTrue(s.round_done)
        self.assertFalse(s.round_success)
        self.assertEqual(s.successes, 0)


if __name__ == "__main__":
    unittest.main()
