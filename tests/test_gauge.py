# -*- coding: utf-8 -*-
import random
import unittest

from core.general.gauge import AXES, GaugeGame, points_for


class GaugeBankTest(unittest.TestCase):
    def test_axes(self):
        self.assertGreaterEqual(len(AXES), 50)
        self.assertTrue(all(a != b for a, b in AXES))


class PointsTest(unittest.TestCase):
    def test_points(self):
        self.assertEqual(points_for(5, 5), 4)
        self.assertEqual(points_for(5, 4), 3)
        self.assertEqual(points_for(5, 7), 2)
        self.assertEqual(points_for(5, 8), 0)


class GaugeGameTest(unittest.TestCase):
    def setUp(self):
        self.game = GaugeGame([1, 2], [3, 4], rng=random.Random(5))

    def test_round_flow_and_counter(self):
        g = self.game
        self.assertTrue(g.next_round())
        self.assertEqual(g.turn_team, "A")
        self.assertIn(g.psychic, g.teams["A"])
        self.assertTrue(2 <= g.center <= 8)
        self.assertFalse(g.set_hint(3, "x"))  # 出題者でない
        self.assertTrue(g.set_hint(g.psychic, "だいたい真ん中"))
        guess = max(0, g.center - 1)  # ±1 → 3点、相手に左右当て機会
        self.assertTrue(g.set_guess(guess))
        result = g.settle("right" if g.center > guess else "left")
        self.assertEqual(result["points"], 3)
        self.assertEqual(result["counter_point"], 1)
        self.assertEqual(g.scores["A"], 3)
        self.assertEqual(g.scores["B"], 1)

    def test_bullseye_no_counter(self):
        g = self.game
        g.next_round()
        g.set_hint(g.psychic, "ど真ん中")
        g.set_guess(g.center)
        result = g.settle("left")
        self.assertEqual(result["points"], 4)
        self.assertEqual(result["counter_point"], 0)

    def test_finish_by_target_score(self):
        g = self.game
        g.scores["A"] = 9
        g.next_round()
        g.set_hint(g.psychic, "x")
        g.set_guess(g.center)
        g.settle(None)
        self.assertTrue(g.finished)
        self.assertEqual(g.winner, "A")


if __name__ == "__main__":
    unittest.main()
