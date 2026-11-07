"""五目並べ（core/game/gomoku/gomoku.py）のテスト。勝敗判定と脅威検出AI。"""

import unittest

from core.game.gomoku.gomoku import BLACK, SIZE, WHITE, choose_ai_move, is_full, is_win_at, new_board, winner

B, W = BLACK, WHITE


def place(board, player, cells):
    for r, c in cells:
        board[r][c] = player
    return board


class WinTest(unittest.TestCase):
    def test_horizontal_win(self):
        board = place(new_board(), B, [(7, 3), (7, 4), (7, 5), (7, 6)])
        self.assertIsNone(winner(board))
        self.assertTrue(is_win_at(board, B, 7, 7))  # 仮定配置での五連判定（AIの脅威検出用）
        board[7][7] = B
        self.assertTrue(is_win_at(board, B, 7, 7))
        self.assertEqual(winner(board), B)

    def test_vertical_and_diagonal(self):
        board = place(new_board(), W, [(2, 2), (3, 2), (4, 2), (5, 2), (6, 2)])
        self.assertEqual(winner(board), W)
        board2 = place(new_board(), B, [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)])
        self.assertEqual(winner(board2), B)
        board3 = place(new_board(), B, [(5, 1), (4, 2), (3, 3), (2, 4), (1, 5)])
        self.assertEqual(winner(board3), B)

    def test_four_is_not_a_win(self):
        board = place(new_board(), B, [(7, 3), (7, 4), (7, 5), (7, 6)])
        self.assertIsNone(winner(board))

    def test_empty_board_no_winner_not_full(self):
        board = new_board()
        self.assertIsNone(winner(board))
        self.assertFalse(is_full(board))


class AiTest(unittest.TestCase):
    def test_empty_board_takes_center(self):
        self.assertEqual(choose_ai_move(new_board(), B), (SIZE // 2, SIZE // 2))

    def test_ai_completes_five(self):
        board = place(new_board(), B, [(7, 3), (7, 4), (7, 5), (7, 6)])
        move = choose_ai_move(board, B)
        self.assertIn(move, [(7, 2), (7, 7)])
        board[move[0]][move[1]] = B
        self.assertEqual(winner(board), B)

    def test_ai_blocks_opponent_four(self):
        board = place(new_board(), W, [(3, 3), (4, 4), (5, 5), (6, 6)])
        board[7][7] = B  # 片側は塞いである
        move = choose_ai_move(board, B)
        self.assertEqual(move, (2, 2))

    def test_ai_move_is_deterministic(self):
        board = place(new_board(), B, [(7, 7)])
        board[7][8] = W
        self.assertEqual(choose_ai_move(board, B), choose_ai_move(board, B))


if __name__ == "__main__":
    unittest.main()
