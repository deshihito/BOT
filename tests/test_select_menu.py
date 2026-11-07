import unittest
from types import SimpleNamespace

from cogs.game import ChessMoveView
from cogs.game import OthelloMoveView
from core.game.othello.cog import WHITE, legal_moves, new_board
from cogs.game import ShogiMoveView


class SelectMenuTest(unittest.TestCase):
    def test_chess_uses_numbered_select(self):
        view = ChessMoveView(None, object(), [("1", (0, 0)), ("2", (0, 1))], "source")
        self.assertEqual([option.label for option in view.select.options], ["1番", "2番"])

    def test_othello_uses_numbered_select(self):
        view = OthelloMoveView(None, object(), legal_moves(new_board(), WHITE))
        self.assertTrue(all(option.label.endswith("番") for option in view.selects[0].options))

    def test_shogi_uses_numbered_select(self):
        view = ShogiMoveView(None, object(), [("1", (0, 0))])
        self.assertEqual(view.select.options[0].label, "1番")

    def test_shogi_long_move_list_has_coordinate_input_instead_of_reactions(self):
        session = SimpleNamespace(state="select_piece")
        labels = [(str(index), (index % 9, index % 9)) for index in range(35)]
        view = ShogiMoveView(None, session, labels)
        self.assertEqual(len(view.select.options), 25)
        self.assertIn("座標を入力", [b.label for b in view.buttons])
        self.assertNotIn("リアクション", [getattr(item, "label", "") for item in view.walk_children()])


if __name__ == "__main__":
    unittest.main()
