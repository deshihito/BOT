"""アゴ姫への手紙（core/loveletter.py）のテスト。AGOオリジナル役職の効果を固める。"""

import random
import unittest
from collections import Counter

from core.loveletter import TARGET_TOKENS, LoveLetterGame, build_deck


def make_game(hands, deck, players=(1, 2, 3), turn=0):
    game = LoveLetterGame(list(players), rng=random.Random(0))
    game.hands = dict(hands)
    game.deck = list(deck)
    game.discards = {pid: [] for pid in players}
    game.alive = list(players)
    game.protected = set()
    game.turn_index = turn
    game.drawn = None
    game.round_over = False
    game.round_winners = []
    return game


class DeckTest(unittest.TestCase):
    def test_deck_composition_16_cards(self):
        counts = Counter(build_deck(random.Random(1)))
        self.assertEqual(sum(counts.values()), 16)
        self.assertEqual(counts, {1: 5, 2: 2, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1})

    def test_two_player_public_removed_3(self):
        game = LoveLetterGame([1, 2], rng=random.Random(0))
        self.assertEqual(len(game.removed), 3)

    def test_player_count_validation(self):
        with self.assertRaises(ValueError):
            LoveLetterGame([1])
        with self.assertRaises(ValueError):
            LoveLetterGame([1, 2, 3, 4, 5])


class CardEffectTest(unittest.TestCase):
    def test_guard_hit_eliminates(self):
        game = make_game({1: 1, 2: 5, 3: 4}, deck=[2])
        game.begin_turn()  # 1 が 2 を引く（手札 [1, 2]）
        ev = game.play(1, target=2, guess=5)
        self.assertIn(2, ev["eliminated"])
        self.assertNotIn(2, game.alive)

    def test_guard_miss(self):
        game = make_game({1: 1, 2: 5, 3: 4}, deck=[2])
        game.begin_turn()
        ev = game.play(1, target=2, guess=3)
        self.assertEqual(ev["eliminated"], [])
        self.assertIn(2, game.alive)

    def test_guard_requires_guess(self):
        game = make_game({1: 1, 2: 5, 3: 4}, deck=[2])
        game.begin_turn()
        with self.assertRaises(ValueError):
            game.play(1, target=2)
        with self.assertRaises(ValueError):
            game.play(1, target=2, guess=1)

    def test_spy_peek(self):
        game = make_game({1: 2, 2: 6, 3: 4}, deck=[3])
        game.begin_turn()
        ev = game.play(2, target=2)
        self.assertEqual(ev["peek"][1], 6)

    def test_knight_lower_loses(self):
        game = make_game({1: 3, 2: 2, 3: 4}, deck=[5])
        game.begin_turn()  # 手札 [3, 5]
        ev = game.play(3, target=2)  # 自分5 vs 相手2 → 相手が脱落
        self.assertIn(2, ev["eliminated"])
        self.assertEqual(ev["peek"][1], 2)
        self.assertEqual(ev["peek"][2], 5)

    def test_knight_tie_no_elimination(self):
        game = make_game({1: 3, 2: 5, 3: 4}, deck=[6])
        game.begin_turn()  # 手札 [3, 6] → 騎士を出すと自分は6、相手は5
        game.hands[2] = 6
        ev = game.play(3, target=2)
        self.assertEqual(ev["eliminated"], [])

    def test_handmaid_protects_and_expires(self):
        game = make_game({1: 4, 2: 1, 3: 3}, deck=[2, 6, 3])
        game.begin_turn()  # 3 を引く（手札 [4, 3]）
        game.play(4)  # 侍女
        self.assertIn(1, game.protected)
        # 次のプレイヤー2からは対象にできない
        self.assertEqual(game.current, 2)
        self.assertNotIn(1, game.valid_targets(1))
        # 次の自分の番が来ると守りは解ける
        game.turn_index = 0
        game.begin_turn()
        self.assertNotIn(1, game.protected)

    def test_jester_drops_princess_eliminates(self):
        game = make_game({1: 5, 2: 8, 3: 4}, deck=[2, 3])
        game.begin_turn()
        ev = game.play(5, target=2)
        self.assertEqual(ev["dropped"], 8)
        self.assertIn(2, ev["eliminated"])

    def test_jester_drops_and_redraws(self):
        game = make_game({1: 5, 2: 3, 3: 4}, deck=[6, 2])
        game.begin_turn()  # 1 は 2 を引く（手札 [5, 2]）
        ev = game.play(5, target=2)
        self.assertEqual(ev["dropped"], 3)
        self.assertEqual(game.hands[2], 6)  # 山札の残りから引き直し
        self.assertIn(2, game.alive)

    def test_prince_swaps(self):
        game = make_game({1: 6, 2: 2, 3: 4}, deck=[3])
        game.begin_turn()  # 手札 [6, 3]
        game.play(6, target=2)
        self.assertEqual(game.hands[1], 2)
        self.assertEqual(game.hands[2], 3)

    def test_countess_constraint(self):
        game = make_game({1: 7, 2: 2, 3: 4}, deck=[5])
        game.begin_turn()  # 手札 [7, 5]
        self.assertEqual(game.legal_cards(), [7])
        with self.assertRaises(ValueError):
            game.play(5, target=1)

    def test_protected_target_rejected(self):
        game = make_game({1: 1, 2: 5, 3: 4}, deck=[2])
        game.protected = {2}
        game.begin_turn()
        with self.assertRaises(ValueError):
            game.play(1, target=2, guess=5)

    def test_all_protected_no_effect(self):
        game = make_game({1: 1, 2: 5, 3: 4}, deck=[2])
        game.protected = {2, 3}
        game.begin_turn()
        ev = game.play(1)
        self.assertEqual(ev["note"], "no_target")


class RoundEndTest(unittest.TestCase):
    def test_last_survivor_wins_round_and_gets_token(self):
        game = make_game({1: 1, 2: 5}, players=(1, 2), deck=[2])
        game.begin_turn()
        game.play(1, target=2, guess=5)
        self.assertTrue(game.round_over)
        self.assertEqual(game.round_winners, [1])
        self.assertEqual(game.tokens[1], 1)

    def test_deck_out_highest_hand_wins(self):
        game = make_game({1: 4, 2: 6}, players=(1, 2), deck=[])
        game.begin_turn()  # 引けない
        game.play(4)  # 侍女を出す → 山札切れで比較（残り手札は出した4として扱う）
        self.assertTrue(game.round_over)
        self.assertEqual(game.round_winners, [2])  # 6 > 4

    def test_deck_out_tie_break_by_discards(self):
        game = make_game({1: 4, 2: 4}, players=(1, 2), deck=[])
        game.begin_turn()
        game.play(4)  # 自分の捨て札合計 4 > 相手 0 で勝ち
        self.assertTrue(game.round_over)
        self.assertEqual(game.round_winners, [1])


class FullGameTest(unittest.TestCase):
    def test_random_games_terminate(self):
        for seed in range(10):
            for n in (2, 3, 4):
                rng = random.Random(seed * 10 + n)
                game = LoveLetterGame(list(range(1, n + 1)), rng=rng)
                turns = 0
                while game.game_winner is None and turns < 1000:
                    while not game.round_over:
                        game.begin_turn()
                        legal = game.legal_cards()
                        rank = legal[0]
                        targets = game.valid_targets(rank)
                        game.play(rank, target=targets[0] if targets else None,
                                  guess=2 if rank == 1 and targets else None)
                        turns += 1
                    if game.game_winner is None:
                        game.start_round()
                self.assertIsNotNone(game.game_winner)
                target = TARGET_TOKENS[n]
                self.assertTrue(game.tokens[game.game_winner] >= target or game.round_no >= 6)


if __name__ == "__main__":
    unittest.main()
