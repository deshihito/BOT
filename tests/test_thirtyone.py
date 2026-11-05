"""31ゲーム（core/thirtyone.py）のテスト。31を言った人が脱落し0から再開。"""

import unittest

from core.thirtyone import ThirtyOneGame


class BasicTest(unittest.TestCase):
    def test_player_count_validation(self):
        with self.assertRaises(ValueError):
            ThirtyOneGame([1])
        with self.assertRaises(ValueError):
            ThirtyOneGame(list(range(9)))
        ThirtyOneGame([1, 2])
        ThirtyOneGame(list(range(8)))

    def test_step_validation(self):
        game = ThirtyOneGame([1, 2])
        with self.assertRaises(ValueError):
            game.apply(0)
        with self.assertRaises(ValueError):
            game.apply(4)

    def test_counting_and_turn_rotation(self):
        game = ThirtyOneGame([1, 2, 3])
        ev = game.apply(3)
        self.assertEqual(ev["said"], [1, 2, 3])
        self.assertEqual(game.total, 3)
        self.assertEqual(game.current, 2)
        ev = game.apply(2)
        self.assertEqual(ev["said"], [4, 5])
        self.assertEqual(game.current, 3)


class EliminationTest(unittest.TestCase):
    def test_hitting_31_eliminates_and_resets(self):
        game = ThirtyOneGame([1, 2, 3])
        game.total = 29
        game.turn_index = 0
        ev = game.apply(2)  # 30, 31 → プレイヤー1が脱落
        self.assertTrue(ev["hit31"])
        self.assertEqual(ev["eliminated"], 1)
        self.assertEqual(game.total, 0)
        self.assertEqual(game.alive, [2, 3])
        # 脱落者の次の人から再開
        self.assertEqual(game.current, 2)
        self.assertFalse(game.finished)

    def test_two_players_hitter_loses(self):
        game = ThirtyOneGame([1, 2])
        game.total = 30
        ev = game.apply(1)
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, 2)
        self.assertEqual(ev["winner"], 2)

    def test_full_game_terminates(self):
        game = ThirtyOneGame([1, 2, 3, 4])
        steps = 0
        while not game.finished and steps < 500:
            game.apply(3)
            steps += 1
        self.assertTrue(game.finished)
        self.assertIn(game.winner, [1, 2, 3, 4])
        self.assertEqual(len(game.eliminated), 3)
        with self.assertRaises(ValueError):
            game.apply(1)


if __name__ == "__main__":
    unittest.main()
