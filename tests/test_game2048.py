"""2048（core/game2048.py）のテスト。合体・スポーン・ゲームオーバー判定。"""

import random
import unittest

from core.game2048 import Game2048, _merge_line


class MergeLineTest(unittest.TestCase):
    def test_merge_pairs(self):
        self.assertEqual(_merge_line([2, 2, 0, 0]), ([4, 0, 0, 0], 4))
        self.assertEqual(_merge_line([2, 2, 2, 2]), ([4, 4, 0, 0], 8))
        self.assertEqual(_merge_line([2, 2, 4, 4]), ([4, 8, 0, 0], 12))

    def test_no_double_merge(self):
        # 合体したタイルはその手でもう一度合体しない
        self.assertEqual(_merge_line([2, 2, 4, 0]), ([4, 4, 0, 0], 4))
        self.assertEqual(_merge_line([4, 4, 8, 0]), ([8, 8, 0, 0], 8))

    def test_slide_only(self):
        self.assertEqual(_merge_line([0, 2, 0, 4]), ([2, 4, 0, 0], 0))


class MoveTest(unittest.TestCase):
    def make(self, board):
        return Game2048(rng=random.Random(0), board=[row[:] for row in board])

    def test_move_left_merges_and_spawns(self):
        game = self.make([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
        self.assertTrue(game.move("left"))
        self.assertEqual(game.board[0][0], 4)
        self.assertEqual(game.score, 4)
        tiles = sum(1 for row in game.board for v in row if v)
        self.assertEqual(tiles, 2)  # 合体後の1枚＋新規スポーン1枚

    def test_ineffective_move_returns_false_and_no_spawn(self):
        game = self.make([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
        before = [row[:] for row in game.board]
        self.assertFalse(game.move("left"))
        self.assertEqual(game.board, before)
        self.assertEqual(game.score, 0)

    def test_move_up_down_right(self):
        game = self.make([[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
        self.assertTrue(game.move("up"))
        self.assertEqual(game.board[0][0], 4)
        game2 = self.make([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
        self.assertTrue(game2.move("right"))
        self.assertEqual(game2.board[0][3], 4)

    def test_reaching_2048_sets_won_but_playable(self):
        game = self.make([[1024, 1024, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
        self.assertTrue(game.move("left"))
        self.assertEqual(game.max_tile, 2048)
        self.assertTrue(game.won)
        self.assertFalse(game.game_over())

    def test_game_over_detection(self):
        # 互い違いに埋まって合体も移動もできない盤面
        board = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]
        game = self.make(board)
        self.assertTrue(game.game_over())
        for direction in ("up", "down", "left", "right"):
            self.assertFalse(game.move(direction))

    def test_not_game_over_with_merge_available(self):
        board = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 4]]
        game = self.make(board)
        self.assertFalse(game.game_over())

    def test_random_play_terminates(self):
        game = Game2048(rng=random.Random(42))
        moves = 0
        while not game.game_over() and moves < 10000:
            for direction in ("left", "up", "right", "down"):
                if game.move(direction):
                    break
            moves += 1
        self.assertTrue(game.game_over())
        self.assertGreater(game.score, 0)


if __name__ == "__main__":
    unittest.main()
