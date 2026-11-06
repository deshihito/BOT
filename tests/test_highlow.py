"""ハイ＆ロー（core/game/highlow.py）のテスト。同点は引き分け扱い（2026-11-07 仕様変更）。"""

import random
import unittest

from core.game.highlow import HighLowGame, card_label, new_deck, rank_label


class DeckTest(unittest.TestCase):
    def test_deck_has_52_unique_cards(self):
        deck = new_deck(random.Random(1))
        self.assertEqual(len(deck), 52)
        self.assertEqual(len(set(deck)), 52)

    def test_labels(self):
        self.assertEqual(rank_label(14), "A")
        self.assertEqual(rank_label(11), "J")
        self.assertEqual(card_label((13, "♠")), "♠K")


class GuessTest(unittest.TestCase):
    def make(self, current_rank, next_ranks):
        game = HighLowGame(rng=random.Random(0))
        game.current = (current_rank, "♠")
        game.deck = [(r, "♥") for r in reversed(next_ranks)]  # pop は末尾から
        return game

    def test_higher_correct(self):
        game = self.make(5, [9, 12])
        self.assertTrue(game.guess("high"))
        self.assertEqual(game.streak, 1)
        self.assertEqual(game.current[0], 9)
        self.assertFalse(game.finished)

    def test_lower_correct(self):
        game = self.make(10, [3, 5])
        self.assertTrue(game.guess("low"))
        self.assertEqual(game.streak, 1)

    def test_wrong_guess_finishes(self):
        game = self.make(5, [3])
        self.assertFalse(game.guess("high"))
        self.assertTrue(game.finished)
        self.assertFalse(game.cleared)
        self.assertEqual(game.streak, 0)

    def test_tie_is_a_draw_not_a_miss(self):
        # 仕様変更 (2026-11-07): 同点は外れではなく引き分け。その札を
        # 今のカードにして、ストリークを維持したまま続けられる。
        game = self.make(7, [7, 9])
        self.assertFalse(game.guess("high"))
        self.assertEqual(game.last_outcome, "tie")
        self.assertFalse(game.finished)
        self.assertEqual(game.streak, 0)
        self.assertEqual(game.current[0], 7)
        # 同点の札から続けて当てればストリークが伸びる
        self.assertTrue(game.guess("high"))
        self.assertEqual(game.streak, 1)
        self.assertEqual(game.last_outcome, "correct")

    def test_tie_on_last_card_finishes_with_streak_kept(self):
        game = self.make(5, [9, 9])
        self.assertTrue(game.guess("high"))     # 9 を当てて streak 1、残り1枚
        self.assertFalse(game.guess("high"))    # 最後の1枚が同点 9
        self.assertEqual(game.last_outcome, "tie")
        self.assertTrue(game.finished)          # 山札が尽きたので終了
        self.assertFalse(game.cleared)
        self.assertEqual(game.streak, 1)

    def test_clearing_the_deck(self):
        game = self.make(5, [9])
        self.assertTrue(game.guess("high"))
        self.assertTrue(game.finished)
        self.assertTrue(game.cleared)

    def test_guess_after_finish_is_noop(self):
        game = self.make(5, [3, 4])
        game.guess("high")
        self.assertFalse(game.guess("high"))
        self.assertEqual(game.streak, 0)


if __name__ == "__main__":
    unittest.main()
