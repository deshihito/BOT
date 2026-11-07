# -*- coding: utf-8 -*-
import random
import unittest

from core.game.liardice.liardice import LiarDiceGame, count_matching, is_legal_raise


class RaiseRuleTest(unittest.TestCase):
    def test_first_bid_rules(self):
        self.assertTrue(is_legal_raise(None, (1, 2)))
        self.assertFalse(is_legal_raise(None, (3, 1)))  # 初回は1の目で始められない

    def test_same_face_needs_more(self):
        self.assertTrue(is_legal_raise((3, 4), (4, 4)))
        self.assertFalse(is_legal_raise((3, 4), (3, 4)))
        self.assertFalse(is_legal_raise((3, 4), (2, 4)))

    def test_higher_face_same_count(self):
        self.assertTrue(is_legal_raise((3, 4), (3, 5)))
        self.assertFalse(is_legal_raise((3, 4), (3, 3)))

    def test_switch_to_ones_needs_half_round_up(self):
        self.assertTrue(is_legal_raise((5, 4), (3, 1)))
        self.assertFalse(is_legal_raise((5, 4), (2, 1)))
        self.assertTrue(is_legal_raise((4, 4), (2, 1)))

    def test_leave_ones_needs_double_plus_one(self):
        self.assertTrue(is_legal_raise((3, 1), (7, 2)))
        self.assertFalse(is_legal_raise((3, 1), (6, 2)))
        self.assertTrue(is_legal_raise((3, 1), (4, 1)))

    def test_count_matching_wild_ones(self):
        self.assertEqual(count_matching([1, 2, 3, 4, 1, 6], 4), 3)
        self.assertEqual(count_matching([1, 1, 2, 3], 1), 2)
        self.assertEqual(count_matching([2, 3], 6), 0)


class LiarDiceGameTest(unittest.TestCase):
    def make(self):
        return LiarDiceGame([1, 2, 3], rng=random.Random(1234))

    def test_initial_hands(self):
        game = self.make()
        for uid in game.players:
            self.assertEqual(len(game.hands[uid]), 5)
            self.assertTrue(all(1 <= d <= 6 for d in game.hands[uid]))
        self.assertEqual(game.total_dice, 15)

    def test_bid_turn_rotation(self):
        game = self.make()
        first = game.current
        self.assertTrue(game.place_bid(first, 1, 2))
        self.assertNotEqual(game.current, first)
        self.assertEqual(game.bid, (1, 2))
        self.assertEqual(game.bidder, first)

    def test_illegal_bid_rejected(self):
        game = self.make()
        game.place_bid(game.current, 3, 4)
        self.assertFalse(game.place_bid(game.current, 3, 4))
        self.assertFalse(game.place_bid(game.current, 2, 4))

    def test_challenge_true_bid_challenger_loses(self):
        game = self.make()
        bidder = game.current
        game.place_bid(bidder, 1, 6)
        challenger = game.current
        result = game.challenge(challenger)
        self.assertIsNotNone(result)
        loser = challenger if result["bid_true"] else bidder
        self.assertEqual(result["loser"], loser)
        self.assertEqual(game.dice_count[loser], 4)
        self.assertEqual(game.round_starter, loser)

    def test_challenge_impossible_bid_bidder_loses(self):
        game = self.make()
        bidder = game.current
        game.bid = (game.total_dice + 1, 6)
        game.bidder = bidder
        game._set_turn_to(game._next_alive(bidder))
        challenger = game.current
        result = game.challenge(challenger)
        self.assertFalse(result["bid_true"])
        self.assertEqual(result["loser"], bidder)
        self.assertEqual(game.dice_count[bidder], 4)

    def test_winner_when_one_remains(self):
        game = self.make()
        game.dice_count = {1: 0, 2: 3, 3: 0}
        # 残り1人の状態でチャレンジが決着すると勝者が確定する
        game.bid = (99, 6)
        game.bidder = 1
        game._set_turn_to(2)
        result = game.challenge(2)
        self.assertIsNotNone(result)
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, 2)


if __name__ == "__main__":
    unittest.main()
