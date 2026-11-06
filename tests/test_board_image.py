"""盤面画像（core/game/board_image.py と各 cog のレンダラー）のテスト。

盤面画像化タスク（2026-11-06）: 描画は純関数なので、サイズ・決定性・
主要状態の描画成功を検証する。実画像の見た目は目視確認に委ねる。
"""

import io
import random
import unittest
from unittest.mock import MagicMock

from PIL import Image

from core.game import board_image
from core.game.board_image import (
    FONT_PATH, render_2048, render_cached, render_minesweeper,
    render_nonogram, render_sudoku,
)


def png_size(data: bytes):
    return Image.open(io.BytesIO(data)).size


class FontPathTest(unittest.TestCase):
    def test_bundled_font_is_found(self):
        # core/game/ への移動後もリポジトリ直下の font.ttf を指すこと
        self.assertTrue(FONT_PATH.exists(), FONT_PATH)


class RenderCacheTest(unittest.TestCase):
    def test_producer_called_once_per_key(self):
        calls = {"n": 0}

        def producer():
            calls["n"] += 1
            return b"png"

        key = ("test-cache", object())
        # object() を含むキーは恒常的ではないので固定キーで検証する
        key = ("test-cache", 1)
        self.assertEqual(render_cached(key, producer), b"png")
        self.assertEqual(render_cached(key, producer), b"png")
        self.assertEqual(calls["n"], 1)


class MinesweeperRenderTest(unittest.TestCase):
    def states(self, rows=4, cols=5):
        return [[("hidden", None)] * cols for _ in range(rows)]

    def test_small_board(self):
        data = render_minesweeper(self.states())
        w, h = png_size(data)
        self.assertGreater(w, 0)
        self.assertGreater(h, 0)

    def test_deterministic(self):
        states = self.states()
        states[0][1] = ("flag", None)
        states[1][2] = ("open", 3)
        self.assertEqual(render_minesweeper(states), render_minesweeper(states))

    def test_selection_changes_output(self):
        states = self.states()
        plain = render_minesweeper(states)
        selected = render_minesweeper(states, selected=(1, 1))
        self.assertNotEqual(plain, selected)

    def test_expert_board_fits_reasonable_width(self):
        states = self.states(12, 16)
        w, _ = png_size(render_minesweeper(states, tile=34))
        self.assertLessEqual(w, 700)

    def test_end_states_render(self):
        states = self.states()
        states[0][0] = ("exploded", None)
        states[0][1] = ("mine", None)
        states[2][2] = ("open", 0)
        self.assertTrue(render_minesweeper(states).startswith(b"\x89PNG"))


class Render2048Test(unittest.TestCase):
    def test_size_and_determinism(self):
        board = [[0, 2, 4, 8], [16, 32, 64, 128], [256, 512, 1024, 2048], [4096, 0, 2, 0]]
        data = render_2048(board)
        self.assertEqual(png_size(data), (434, 434))
        self.assertEqual(data, render_2048(board))

    def test_empty_board(self):
        self.assertTrue(render_2048([[0] * 4 for _ in range(4)]).startswith(b"\x89PNG"))


class SudokuRenderTest(unittest.TestCase):
    def make(self):
        board = [[0] * 9 for _ in range(9)]
        givens = [[False] * 9 for _ in range(9)]
        board[0][0] = 5
        givens[0][0] = True
        board[0][1] = 3
        return board, givens

    def test_determinism_and_selection(self):
        board, givens = self.make()
        self.assertEqual(render_sudoku(board, givens), render_sudoku(board, givens))
        self.assertNotEqual(render_sudoku(board, givens),
                            render_sudoku(board, givens, selected=(0, 1)))


class NonogramRenderTest(unittest.TestCase):
    def test_determinism(self):
        row_clues = [[1, 1], [3], [1]]
        col_clues = [[2], [1], [2]]
        grid = [[1, 0, 0], [0, 1, 2], [0, 0, 1]]
        self.assertEqual(render_nonogram(row_clues, col_clues, grid),
                         render_nonogram(row_clues, col_clues, grid))
        self.assertNotEqual(render_nonogram(row_clues, col_clues, grid),
                            render_nonogram(row_clues, col_clues, grid, selected=(1, 1)))


class VersusRenderTest(unittest.TestCase):
    def test_gomoku_render_deterministic(self):
        from core.game.gomoku import BLACK, new_board
        from core.game.gomoku_cog.cog import render_board_image
        board = new_board()
        board[7][7] = BLACK
        first = render_board_image(board, last=(7, 7))
        first.seek(0)
        second = render_board_image(board, last=(7, 7))
        second.seek(0)
        self.assertEqual(first.getvalue(), second.getvalue())
        self.assertEqual(Image.open(first).size, (640, 640))

    def test_connect4_render_deterministic(self):
        from core.game.connect4 import RED, new_board
        from core.game.connect4_cog.cog import HEIGHT, WIDTH, render_board_image
        board = new_board()
        board[5][0] = RED
        first = render_board_image(board, last=(5, 0))
        first.seek(0)
        second = render_board_image(board, last=(5, 0))
        second.seek(0)
        self.assertEqual(first.getvalue(), second.getvalue())
        self.assertEqual(Image.open(first).size, (WIDTH, HEIGHT))

    def test_shogi_render_keeps_geometry(self):
        from cogs.shogi import IMG_H, IMG_W, ShogiGame, ShogiRenderer
        out = ShogiRenderer().render(ShogiGame())
        self.assertEqual(Image.open(out).size, (IMG_W, IMG_H))


class PanelConstructionTest(unittest.TestCase):
    """4ゲームの V2 パネルが構築でき、ボタン上限内に収まること。"""

    def owner(self):
        user = MagicMock()
        user.id = 4242
        return user

    def test_minesweeper_panels(self):
        import cogs.minesweeper as cog
        from core.game.game_v2 import assert_within_limits, count_buttons
        from core.game.minesweeper import MinesweeperBoard
        for key in ("easy", "wide", "expert"):
            panel = cog.BoardPanel(MagicMock(), self.owner(),
                                   MinesweeperBoard(key, rng=random.Random(0)))
            assert_within_limits(panel)
            self.assertLessEqual(count_buttons(panel), 5)
        diff = cog.DifficultyPanel(MagicMock(), self.owner())
        assert_within_limits(diff)
        self.assertEqual(count_buttons(diff), 5)

    def test_sudoku_panels(self):
        import cogs.sudoku as cog
        from core.game.game_v2 import assert_within_limits
        from core.game.sudoku import generate
        puzzle, solution = generate(random.Random(1), "easy")
        view = cog.SudokuView(MagicMock(), self.owner(), puzzle, solution, "easy")
        assert_within_limits(view)
        assert_within_limits(cog.ModeView(MagicMock(), self.owner()))

    def test_nonogram_panels(self):
        import cogs.nonogram as cog
        from core.game.game_v2 import assert_within_limits
        from core.game.nonogram import NonogramPuzzle
        puzzle = NonogramPuzzle.pick("8x8", rng=random.Random(0))
        view = cog.NonogramView(MagicMock(), self.owner(), puzzle)
        assert_within_limits(view)
        assert_within_limits(cog.SizeView(MagicMock(), self.owner()))

    def test_2048_panel(self):
        from core.game.game2048_cog.cog import Board2048View
        from core.game.game_v2 import assert_within_limits, count_buttons
        view = Board2048View(MagicMock(), self.owner())
        assert_within_limits(view)
        self.assertEqual(count_buttons(view), 5)


if __name__ == "__main__":
    unittest.main()
