# -*- coding: utf-8 -*-
import random
import unittest

from core.game.hanabi import COLORS, COUNTS, HanabiGame, build_deck


class DeckTest(unittest.TestCase):
    def test_composition(self):
        deck = build_deck(random.Random(1))
        self.assertEqual(len(deck), 50)
        for color in COLORS:
            for num, cnt in COUNTS.items():
                self.assertEqual(sum(1 for c in deck if c == (color, num)), cnt)

    def test_hand_sizes(self):
        self.assertEqual(len(HanabiGame([1, 2], rng=random.Random(1)).hands[1]), 5)
        self.assertEqual(len(HanabiGame([1, 2, 3, 4], rng=random.Random(1)).hands[1]), 4)


def rigged_game():
    """手札と山札を固定した2人ゲーム。"""
    g = HanabiGame([10, 20], rng=random.Random(0))
    g.hands = {10: [("赤", 1), ("青", 2), ("黄", 3), ("緑", 4), ("白", 5)],
               20: [("赤", 2), ("青", 1), ("黄", 1), ("緑", 1), ("白", 1)]}
    g.knowledge = {uid: [{"color": None, "number": None} for _ in hand]
                   for uid, hand in g.hands.items()}
    g.deck = [("赤", 3)] * 10
    return g


class HanabiFlowTest(unittest.TestCase):
    def test_hint_marks_all_matching_and_costs_token(self):
        g = rigged_game()
        result = g.hint(10, 20, "number", 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 4)
        self.assertEqual(g.hints, 7)
        self.assertTrue(all(g.knowledge[20][i]["number"] == 1 for i in (1, 2, 3, 4)))
        self.assertIsNone(g.knowledge[20][0]["number"])
        self.assertEqual(g.current, 20)

    def test_hint_no_match_rejected_without_cost(self):
        g = rigged_game()
        result = g.hint(10, 20, "number", 4)
        self.assertFalse(result["ok"])
        self.assertEqual(g.hints, 8)
        self.assertEqual(g.current, 10)

    def test_play_success_and_miss(self):
        g = rigged_game()
        result = g.play(10, 0)  # 赤1 -> 成功
        self.assertTrue(result["success"])
        self.assertEqual(g.piles["赤"], 1)
        result = g.play(20, 0)  # 赤2 -> 成功（赤は1まで完成）
        self.assertTrue(result["success"])
        g2 = rigged_game()
        result = g2.play(10, 1)  # 青2 -> 失敗（青は0）
        self.assertFalse(result["success"])
        self.assertEqual(g2.fuse, 2)

    def test_discard_restores_hint_and_blocked_when_full(self):
        g = rigged_game()
        self.assertFalse(g.discard(10, 0)["ok"])  # ヒント満タンでは捨てられない
        g.hints = 5
        result = g.discard(10, 0)
        self.assertTrue(result["ok"])
        self.assertEqual(g.hints, 6)

    def test_three_misses_finish(self):
        g = rigged_game()
        for _ in range(3):
            actor = g.current
            g.hands[actor][0] = ("青", 5)  # 青の場は0なので必ずミス
            result = g.play(actor, 0)
            self.assertFalse(result["success"])
        self.assertEqual(g.fuse, 0)
        self.assertTrue(g.finished)
        self.assertIsNotNone(g.fail_reason)

    def test_score_is_piles_sum(self):
        g = rigged_game()
        g.piles = {"赤": 3, "青": 2, "黄": 0, "緑": 5, "白": 1}
        self.assertEqual(g.score, 11)


if __name__ == "__main__":
    unittest.main()
