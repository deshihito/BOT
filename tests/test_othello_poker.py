"""オセロ・ポーカーの基本ルールテスト。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import game_fakes  # noqa: F401
from cogs.game import OthelloGame, OthelloMoveView, labelled_moves, play_move
from core.game.othello.cog import BLACK, WHITE, legal_moves, new_board, render_board_image
from core.game.poker.cog import evaluate
from PIL import Image, ImageChops


class OthelloTest(unittest.TestCase):
    def test_initial_moves_and_flip(self):
        board = new_board()
        moves = legal_moves(board, BLACK)
        self.assertEqual(len(moves), 4)
        self.assertTrue(play_move(board, BLACK, 2, 3))
        self.assertEqual(board[3][3], BLACK)
        self.assertEqual(board[2][3], BLACK)
        self.assertEqual(len(legal_moves(board, WHITE)), 3)

    def test_reject_illegal_move(self):
        self.assertFalse(play_move(new_board(), BLACK, 0, 0))

    def test_move_labels(self):
        moves = legal_moves(new_board(), BLACK)
        self.assertEqual(labelled_moves(moves), list(zip("1234", moves)))

    def test_legal_moves_are_drawn_on_board(self):
        board = new_board()
        move = legal_moves(board, BLACK)[0]
        plain = Image.open(render_board_image(board)).convert("RGBA")
        labelled = Image.open(render_board_image(board, [move])).convert("RGBA")
        self.assertEqual(labelled.size, (800, 800))
        self.assertIsNotNone(ImageChops.difference(plain, labelled).getbbox())


class OthelloSelectTest(unittest.IsolatedAsyncioTestCase):
    async def test_select_places_the_corresponding_legal_move(self):
        game = OthelloGame(1, 1, 1)
        black = SimpleNamespace(id=1, mention="<@1>", bot=False)
        white = SimpleNamespace(id=2, mention="<@2>", bot=False)
        game.players = {BLACK: black, WHITE: white}
        game.phase = "playing"
        moves = legal_moves(game.board, BLACK)

        class Response:
            async def defer(self):
                pass

            async def send_message(self, *args, **kwargs):
                raise AssertionError("authorized player should not receive an error")

        interaction = SimpleNamespace(user=black, response=Response())
        view = OthelloMoveView(None, game, moves)
        select = view.selects[0]
        select._values = ["1"]
        await select.callback(interaction)

        self.assertTrue(game.acted)
        self.assertEqual(game.board[moves[0][0]][moves[0][1]], BLACK)

    async def test_other_players_cannot_use_select(self):
        game = OthelloGame(1, 1, 1)
        black = SimpleNamespace(id=1, mention="<@1>", bot=False)
        white = SimpleNamespace(id=2, mention="<@2>", bot=False)
        game.players = {BLACK: black, WHITE: white}
        game.phase = "playing"
        moves = legal_moves(game.board, BLACK)

        class Response:
            def __init__(self):
                self.sent = None

            async def send_message(self, *args, **kwargs):
                self.sent = (args, kwargs)

            async def defer(self):
                raise AssertionError("unauthorized player must not defer the interaction")

        response = Response()
        interaction = SimpleNamespace(user=white, response=response)
        view = OthelloMoveView(None, game, moves)
        select = view.selects[0]
        select._values = ["1"]
        await select.callback(interaction)

        self.assertFalse(game.acted)
        self.assertEqual(game.board, new_board())
        self.assertEqual(response.sent[1], {"ephemeral": True})

    async def test_stale_select_during_cpu_turn_is_rejected_without_exception(self):
        game = OthelloGame(1, 1, 1, mode="cpu")
        black = SimpleNamespace(id=1, mention="<@1>", bot=False)
        game.players = {BLACK: black, WHITE: None}
        game.phase = "playing"
        moves = legal_moves(game.board, BLACK)

        class Response:
            def __init__(self):
                self.sent = None

            async def send_message(self, *args, **kwargs):
                self.sent = (args, kwargs)

            async def defer(self):
                raise AssertionError("CPU turn must not defer a stale player interaction")

        response = Response()
        interaction = SimpleNamespace(user=black, response=response)
        view = OthelloMoveView(None, game, moves)
        select = view.selects[0]
        select._values = ["1"]
        game.turn = WHITE

        await select.callback(interaction)

        self.assertEqual(response.sent[1], {"ephemeral": True})


class PokerTest(unittest.TestCase):
    def test_hand_rank_order(self):
        hands = [
            ["2♠", "3♥", "4♦", "5♣", "6♠"],
            ["A♠", "A♥", "A♦", "A♣", "2♠"],
            ["2♠", "2♥", "2♦", "3♣", "3♠"],
        ]
        ranked = [evaluate(hand)[0] for hand in hands]
        self.assertGreater(ranked[1], ranked[2])
        self.assertGreater(ranked[2], ranked[0])

    def test_wheel_straight_flush(self):
        score, name = evaluate(["A♠", "2♠", "3♠", "4♠", "5♠"])
        self.assertEqual(name, "ストレートフラッシュ")
        self.assertEqual(score, (8, 5))


if __name__ == "__main__":
    unittest.main()
