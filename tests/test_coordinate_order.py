# -*- coding: utf-8 -*-
"""座標セレクトの順序と X/Y 表記のテスト（レビュー対応 2026-11-06）。

座標指定は全ゲームで X（横）→Y（縦）の順に統一する:
- 2セレクト方式では上のセレクトが X、下が Y。
- 読み出し表記は「X=…, Y=…」形式。
- 将棋の座標モーダルは1桁目=X、2桁目=Y。
"""
import random
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import discord


def select_placeholders(panel) -> list[str]:
    """GamePanelView の操作行から Select の placeholder を並び順に取る。"""
    out = []
    for row in panel._rows:
        for item in row.children:
            if isinstance(item, discord.ui.Select):
                out.append(item.placeholder)
    return out


def select_options(panel) -> list[list[str]]:
    out = []
    for row in panel._rows:
        for item in row.children:
            if isinstance(item, discord.ui.Select):
                out.append([opt.label for opt in item.options])
    return out


def owner(uid=4242):
    user = MagicMock()
    user.id = uid
    return user


class MinesweeperOrderTest(unittest.TestCase):
    def test_x_select_above_y_select(self):
        import cogs.minesweeper as cog
        from core.game.minesweeper import MinesweeperBoard

        panel = cog.BoardPanel(MagicMock(), owner(), MinesweeperBoard("easy", rng=random.Random(0)))
        placeholders = select_placeholders(panel)
        self.assertTrue(placeholders[0].startswith("X"), placeholders)
        self.assertTrue(placeholders[1].startswith("Y"), placeholders)
        options = select_options(panel)
        self.assertTrue(all(label.startswith("X=") for label in options[0]))
        self.assertTrue(all(label.startswith("Y=") for label in options[1]))

    def test_coord_readout_is_xy(self):
        from core.game.minesweeper_cog.cog import coord
        self.assertEqual(coord(2, 4), "X=C, Y=5")
        self.assertEqual(coord(0, 0), "X=A, Y=1")


class SudokuOrderTest(unittest.TestCase):
    def test_x_then_y_then_number(self):
        import cogs.sudoku as cog
        from core.game.sudoku import generate

        puzzle, solution = generate(random.Random(1), "easy")
        view = cog.SudokuView(MagicMock(), owner(), puzzle, solution, "easy")
        placeholders = select_placeholders(view)
        self.assertTrue(placeholders[0].startswith("X"), placeholders)
        self.assertTrue(placeholders[1].startswith("Y"), placeholders)
        self.assertIn("数字", placeholders[2])


class NonogramOrderTest(unittest.TestCase):
    def test_x_select_above_y_select(self):
        import cogs.nonogram as cog
        from core.game.nonogram import NonogramPuzzle

        puzzle = NonogramPuzzle.pick("5x5", rng=random.Random(0))
        view = cog.NonogramView(MagicMock(), owner(), puzzle)
        placeholders = select_placeholders(view)
        self.assertTrue(placeholders[0].startswith("X"), placeholders)
        self.assertTrue(placeholders[1].startswith("Y"), placeholders)


class GomokuOrderTest(unittest.TestCase):
    def test_x_select_row0_y_select_row1(self):
        from core.game.gomoku_cog.cog import GomokuGame, MoveView

        view = MoveView(MagicMock(), GomokuGame(1, 1, 1))
        selects = [c for c in view.children if isinstance(c, discord.ui.Select)]
        self.assertEqual(len(selects), 2)
        self.assertEqual(selects[0].row, 0)
        self.assertTrue(selects[0].placeholder.startswith("X"), selects[0].placeholder)
        self.assertEqual(selects[1].row, 1)
        self.assertTrue(selects[1].placeholder.startswith("Y"), selects[1].placeholder)
        self.assertTrue(all(o.label.startswith("X=") for o in selects[0].options))
        self.assertTrue(all(o.label.startswith("Y=") for o in selects[1].options))


class Connect4NotationTest(unittest.TestCase):
    def test_single_axis_is_x(self):
        from core.game.connect4_cog.cog import Connect4Game, MoveView

        view = MoveView(MagicMock(), Connect4Game(1, 1, 1))
        selects = [c for c in view.children if isinstance(c, discord.ui.Select)]
        self.assertEqual(len(selects), 1)
        self.assertIn("X", selects[0].placeholder)
        self.assertTrue(all(o.label.startswith("X=") for o in selects[0].options))


class ShogiModalOrderTest(unittest.IsolatedAsyncioTestCase):
    def test_modal_label_is_xy(self):
        from core.game.shogi.cog import ShogiCoordinateModal
        self.assertIn("X・Y", ShogiCoordinateModal.coordinate.label)
        self.assertIn("X", ShogiCoordinateModal.coordinate.placeholder)

    async def test_first_digit_is_x_second_is_y(self):
        from core.game.shogi.cog import Shogi

        class StubGame:
            def legal_destinations(self, r, c):
                # (row=4, col=2) の駒だけ選べる
                return [(0, 0)] if (r, c) == (4, 2) else []

        cog = Shogi(MagicMock())
        cog._update_board_msg = AsyncMock()
        session = SimpleNamespace(phase="playing", acted=False, state="select_piece",
                                  selected=None, game=StubGame())
        interaction = MagicMock()
        interaction.response.defer = AsyncMock()
        interaction.followup.send = AsyncMock()
        interaction.channel = MagicMock()
        await cog.handle_coordinate_input(interaction, session, "35")
        # X=3 → col=2, Y=5 → row=4 として解釈されること
        self.assertEqual(session.selected, (4, 2))
        self.assertEqual(session.state, "select_dest")


if __name__ == "__main__":
    unittest.main()
