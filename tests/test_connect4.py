"""四目並べ（core/game/connect4.py）のテスト。落下・勝敗判定・脅威検出AI。"""

import unittest

from core.game.connect4 import RED, YELLOW, choose_ai_move, drop, is_full, legal_moves, new_board, winner

R, Y = RED, YELLOW


def drop_many(board, cols, players=(R, Y)):
    turn = 0
    for col in cols:
        assert drop(board, col, players[turn % 2])
        turn += 1
    return board


class DropTest(unittest.TestCase):
    def test_piece_falls_to_bottom(self):
        board = new_board()
        self.assertTrue(drop(board, 3, R))
        self.assertEqual(board[5][3], R)
        self.assertTrue(drop(board, 3, Y))
        self.assertEqual(board[4][3], Y)

    def test_full_column_rejected(self):
        board = new_board()
        for i in range(6):
            self.assertTrue(drop(board, 0, R if i % 2 == 0 else Y))
        self.assertFalse(drop(board, 0, R))
        self.assertNotIn(0, legal_moves(board))


class WinTest(unittest.TestCase):
    def test_vertical_win(self):
        board = drop_many(new_board(), [0, 1, 0, 1, 0, 1, 0])
        self.assertEqual(winner(board), R)

    def test_horizontal_win(self):
        board = drop_many(new_board(), [0, 0, 1, 1, 2, 2, 3])
        self.assertEqual(winner(board), R)

    def test_diagonal_win(self):
        # R: (5,0) (4,1) (3,2) (2,3) の斜め
        board = drop_many(new_board(), [0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3],
                          players=(R, Y))
        self.assertEqual(winner(board), R)

    def test_no_winner_yet(self):
        board = drop_many(new_board(), [0, 1, 2])
        self.assertIsNone(winner(board))
        self.assertFalse(is_full(board))


class AiTest(unittest.TestCase):
    def test_ai_takes_winning_column(self):
        board = drop_many(new_board(), [0, 1, 0, 1, 0, 1])  # R が列0に3つ
        self.assertEqual(choose_ai_move(board, R), 0)

    def test_ai_blocks_opponent_win(self):
        board = drop_many(new_board(), [6, 0, 5, 0, 1, 0])  # Y が列0に3つ、次で勝ち
        self.assertEqual(choose_ai_move(board, R), 0)

    def test_ai_returns_legal_column(self):
        board = drop_many(new_board(), [3, 3, 2])
        move = choose_ai_move(board, Y)
        self.assertIn(move, legal_moves(board))


if __name__ == "__main__":
    unittest.main()
