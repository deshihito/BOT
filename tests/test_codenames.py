"""コードネーム（core/codenames.py）のテスト。盤面構成・ヒント・推測・暗殺者。"""

import random
import unittest

from core.codenames import WORD_BANK, CodenamesGame


def indices_of(game, kind):
    return [i for i, k in enumerate(game.key) if k == kind]


class BankAndSetupTest(unittest.TestCase):
    def test_word_bank_200_plus_unique(self):
        self.assertGreaterEqual(len(WORD_BANK), 200)
        self.assertEqual(len(set(WORD_BANK)), len(WORD_BANK))

    def test_board_composition(self):
        game = CodenamesGame(first_team="red", rng=random.Random(0))
        self.assertEqual(len(game.words), 25)
        self.assertEqual(len(set(game.words)), 25)
        self.assertEqual(len(indices_of(game, "red")), 9)   # 先手チームは9枚
        self.assertEqual(len(indices_of(game, "blue")), 8)
        self.assertEqual(len(indices_of(game, "neutral")), 7)
        self.assertEqual(len(indices_of(game, "assassin")), 1)
        self.assertEqual(game.remaining("red"), 9)

    def test_first_team_blue_gets_9(self):
        game = CodenamesGame(first_team="blue", rng=random.Random(0))
        self.assertEqual(len(indices_of(game, "blue")), 9)
        self.assertEqual(len(indices_of(game, "red")), 8)


class HintTest(unittest.TestCase):
    def test_hint_flow_and_validation(self):
        game = CodenamesGame(first_team="red", rng=random.Random(1))
        self.assertEqual(game.phase, "hint")
        with self.assertRaises(ValueError):
            game.give_hint("blue", "手がかり", 1)  # 手番違い
        with self.assertRaises(ValueError):
            game.give_hint("red", game.words[0], 1)  # 盤面の単語そのものは不可
        with self.assertRaises(ValueError):
            game.give_hint("red", "手がかり", 10)  # 個数の範囲外
        game.give_hint("red", "手がかり", 2)
        self.assertEqual(game.phase, "guess")
        self.assertEqual(game.guesses_left, 3)  # 個数＋1回まで


class GuessTest(unittest.TestCase):
    def make(self, seed=2):
        game = CodenamesGame(first_team="red", rng=random.Random(seed))
        game.give_hint("red", "ヒント", 9)
        return game

    def test_own_color_continues(self):
        game = self.make()
        ev = game.guess("red", indices_of(game, "red")[0])
        self.assertEqual(ev["kind"], "red")
        self.assertEqual(game.turn, "red")
        self.assertEqual(game.remaining("red"), 8)

    def test_neutral_ends_turn(self):
        game = self.make()
        game.guess("red", indices_of(game, "neutral")[0])
        self.assertEqual(game.turn, "blue")
        self.assertEqual(game.phase, "hint")

    def test_opponent_color_ends_turn_and_helps_opponent(self):
        game = self.make()
        game.guess("red", indices_of(game, "blue")[0])
        self.assertEqual(game.turn, "blue")
        self.assertEqual(game.remaining("blue"), 7)

    def test_assassin_instant_loss(self):
        game = self.make()
        ev = game.guess("red", indices_of(game, "assassin")[0])
        self.assertEqual(game.phase, "done")
        self.assertEqual(game.winner, "blue")
        self.assertEqual(game.loser_reason, "assassin")
        self.assertIsNotNone(ev)

    def test_guess_limit_forces_turn_end(self):
        game = CodenamesGame(first_team="red", rng=random.Random(5))
        game.give_hint("red", "ヒント", 0)  # 0個 → 1回だけ選べる
        self.assertEqual(game.guesses_left, 1)
        game.guess("red", indices_of(game, "red")[0])
        self.assertEqual(game.turn, "blue")
        self.assertEqual(game.phase, "hint")

    def test_pass_turn(self):
        game = self.make()
        game.pass_turn("red")
        self.assertEqual(game.turn, "blue")
        self.assertEqual(game.phase, "hint")

    def test_guessing_all_own_wins(self):
        game = CodenamesGame(first_team="red", rng=random.Random(7))
        for i in indices_of(game, "red"):
            if game.phase == "hint":
                game.give_hint("red", "ヒント", 9)
            game.guess("red", i)
        self.assertEqual(game.phase, "done")
        self.assertEqual(game.winner, "red")

    def test_revealed_word_cannot_be_guessed_again(self):
        game = self.make()
        idx = indices_of(game, "red")[0]
        game.guess("red", idx)
        with self.assertRaises(ValueError):
            game.guess("red", idx)


if __name__ == "__main__":
    unittest.main()
