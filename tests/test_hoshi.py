# -*- coding: utf-8 -*-
import random
import unittest

from core.game.hoshi import BOMB, FLOWER, HoshiGame


def place_all(game: HoshiGame, kinds: dict[int, str]):
    """全員が1枚ずつ置く（手番順に）。"""
    for _ in game.players:
        uid = game.current
        game.place(uid, kinds[uid])


class HoshiFlowTest(unittest.TestCase):
    def test_place_and_challenge_requires_own_stack(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(1))
        self.assertEqual(g.current, 10)
        self.assertFalse(g.challenge(10, 1))  # まだ置いていない
        self.assertTrue(g.place(10, FLOWER))
        self.assertFalse(g.place(10, FLOWER))  # 手番が移っている

    def test_successful_challenge(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(1))
        place_all(g, {10: FLOWER, 20: FLOWER, 30: FLOWER})
        # 手番は 10 に戻る
        self.assertEqual(g.current, 10)
        self.assertTrue(g.challenge(10, 2))
        # 20 がパス、30 がパス → reveal
        self.assertTrue(g.pass_bid(20))
        self.assertTrue(g.pass_bid(30))
        self.assertEqual(g.phase, "reveal")
        result = g.flip(10, 10)
        self.assertEqual(result["kind"], FLOWER)
        self.assertFalse(result["done"])
        result = g.flip(10, 20)
        self.assertTrue(result["done"])
        self.assertTrue(result["success"])
        self.assertEqual(g.wins[10], 1)
        self.assertEqual(g.phase, "place")  # 次ラウンド開始

    def test_bomb_fail_loses_a_disc(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(4))
        place_all(g, {10: FLOWER, 20: BOMB, 30: FLOWER})
        g.challenge(10, 3)
        g.pass_bid(20)
        g.pass_bid(30)
        g.flip(10, 10)  # 星
        result = g.flip(10, 20)  # 爆弾
        self.assertTrue(result["done"])
        self.assertFalse(result["success"])
        total = sum(g.owned[10].values()) + len(g.stacks[10])
        self.assertEqual(total, 3)  # 4 - 1枚喪失

    def test_bid_raise_changes_challenger(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(1))
        place_all(g, {10: FLOWER, 20: FLOWER, 30: FLOWER})
        g.challenge(10, 1)
        self.assertTrue(g.raise_bid(20, 2))
        self.assertEqual(g.challenger, 20)
        self.assertTrue(g.pass_bid(30))
        self.assertTrue(g.pass_bid(10))
        self.assertEqual(g.phase, "reveal")
        self.assertEqual(g.current, 20)

    def test_two_wins_finish_game(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(1))
        for _ in range(2):
            place_all(g, {10: FLOWER, 20: FLOWER, 30: FLOWER})
            g.challenge(10, 1)
            g.pass_bid(20)
            g.pass_bid(30)
            result = g.flip(10, 10)
            self.assertTrue(result["success"])
        self.assertEqual(g.phase, "done")
        self.assertEqual(g.winner, 10)

    def test_flip_must_start_with_own_stack(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(1))
        place_all(g, {10: FLOWER, 20: FLOWER, 30: FLOWER})
        g.challenge(10, 2)
        g.pass_bid(20)
        g.pass_bid(30)
        self.assertFalse(g.flip(10, 20)["ok"])

    def test_elimination_by_disc_loss(self):
        g = HoshiGame([10, 20, 30], rng=random.Random(2))
        # 10 のディスクを残り1枚まで減らした状態で爆弾を踏ませる
        g.owned[10] = {FLOWER: 0, BOMB: 0}
        g.stacks = {10: [FLOWER], 20: [BOMB], 30: [FLOWER]}
        g.phase = "reveal"
        g.challenger = 10
        g.bid_amount = 2
        g.flipped = []
        g.flip(10, 10)
        result = g.flip(10, 20)
        self.assertFalse(result["success"])
        self.assertIn(10, g.eliminated)


if __name__ == "__main__":
    unittest.main()
