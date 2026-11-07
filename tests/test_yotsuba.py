# -*- coding: utf-8 -*-
import random
import unittest

from core.game.yotsuba.yotsuba import WORDS, YotsubaGame, placed_words

BOARDS = {1: ("あ", "い", "う", "え"), 2: ("か", "き", "く", "け"), 3: ("さ", "し", "す", "せ")}
DUMMY = ("た", "ち", "つ", "て")


def make_game():
    return YotsubaGame([1, 2, 3], BOARDS, DUMMY, rng=random.Random(7))


class YotsubaGameTest(unittest.TestCase):
    def test_word_bank_unique_and_large(self):
        self.assertEqual(len(WORDS), len(set(WORDS)))
        self.assertGreaterEqual(len(WORDS), 4 * 7)

    def test_placed_words_rotations(self):
        words = ("あ", "い", "う", "え")
        self.assertEqual(placed_words(words, 0), words)
        self.assertEqual(placed_words(words, 1), ("え", "あ", "い", "う"))
        self.assertEqual(placed_words(words, 2), ("う", "え", "あ", "い"))
        self.assertEqual(placed_words(words, 3), ("い", "う", "え", "あ"))

    def test_pool_has_dummy(self):
        game = make_game()
        self.assertEqual(len(game.pool), 4)
        owners = [owner for owner, _w in game.pool]
        self.assertIn(None, owners)
        self.assertEqual(sorted(o for o in owners if o is not None), [1, 2, 3])

    def test_hints_submission(self):
        game = make_game()
        self.assertTrue(game.submit_hints(1, ["w", "x", "y", "z"]))
        self.assertFalse(game.submit_hints(1, ["w", "x", "y", "z"]))
        self.assertFalse(game.submit_hints(2, ["a b", "x", "y", "z"]))  # 空白入りは不可
        self.assertFalse(game.all_hints_in())

    def test_perfect_placement_scores_four(self):
        game = make_game()
        owner = game.current_board_owner
        card_index = next(i for i, (o, _w) in enumerate(game.pool) if o == owner)
        solver = next(u for u in game.players if u != owner)
        result = game.place(solver, card_index, 0)
        self.assertEqual(result["score"], 4)
        self.assertEqual(game.score_board(owner), 4)
        self.assertEqual(game.total_score, 4)

    def test_rotated_placement_partial_score(self):
        game = make_game()
        owner = game.current_board_owner
        card_index = next(i for i, (o, _w) in enumerate(game.pool) if o == owner)
        solver = next(u for u in game.players if u != owner)
        result = game.place(solver, card_index, 1)
        self.assertEqual(result["score"], 0)  # 全単語が1つずれるので一致なし

    def test_wrong_card_scores_zero(self):
        game = make_game()
        owner = game.current_board_owner
        card_index = next(i for i, (o, _w) in enumerate(game.pool) if o is not None and o != owner)
        solver = next(u for u in game.players if u != owner)
        result = game.place(solver, card_index, 0)
        self.assertEqual(result["score"], 0)

    def test_owner_cannot_place_own_board(self):
        game = make_game()
        owner = game.current_board_owner
        card_index = game.available_cards()[0]
        self.assertIsNone(game.place(owner, card_index, 0))

    def test_skip_and_finish(self):
        game = make_game()
        self.assertEqual(game.max_score, 12)
        for _ in range(3):
            game.skip_board()
        self.assertTrue(game.finished)
        self.assertEqual(game.total_score, 0)


if __name__ == "__main__":
    unittest.main()
