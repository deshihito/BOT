import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cogs.othello import BLACK, WHITE, choose_ai_move as choose_othello_move, legal_moves as othello_moves, new_board
from cogs.shogi import Shogi, ShogiRenderer, ShogiSession, _shogi_candidates, choose_ai_move as choose_shogi_move
from core.shogi_engine import Color, Piece, PieceType, ShogiGame


class BoardAiTest(unittest.TestCase):
    def empty_shogi(self):
        game = ShogiGame()
        game.board = [[None for _ in range(9)] for _ in range(9)]
        return game

    def test_othello_difficulties_return_legal_moves(self):
        board = new_board()
        for difficulty in range(1, 11):
            with self.subTest(difficulty=difficulty):
                move = choose_othello_move(board, WHITE, difficulty)
                self.assertIn(move, othello_moves(board, WHITE))
        self.assertEqual(len(othello_moves(board, BLACK)), 4)

    def test_shogi_difficulties_return_executable_moves(self):
        for difficulty in range(1, 11):
            with self.subTest(difficulty=difficulty):
                game = ShogiGame()
                move = choose_shogi_move(game, difficulty)
                self.assertIsNotNone(move)
                source, dest, promote, drop_type = move
                self.assertEqual(game.turn, Color.SENTE)
                self.assertTrue(game.make_move(source, dest, promote=promote, drop_type=drop_type))

    def test_shogi_promoted_piece_images_are_not_transparent_placeholders(self):
        renderer = ShogiRenderer()
        for color in (Color.SENTE, Color.GOTE):
            for piece_type in (PieceType.PAWN, PieceType.LANCE, PieceType.KNIGHT,
                               PieceType.SILVER, PieceType.BISHOP, PieceType.ROOK):
                with self.subTest(color=color, piece_type=piece_type):
                    image = renderer._piece_img(Piece(piece_type, color, promoted=True))
                    self.assertIsNotNone(image.getchannel("A").getbbox())

    def test_shogi_promoted_piece_does_not_reuse_unpromoted_image_cache(self):
        renderer = ShogiRenderer()
        plain = renderer._piece_img(Piece(PieceType.PAWN, Color.SENTE))
        promoted = renderer._piece_img(Piece(PieceType.PAWN, Color.SENTE, promoted=True))
        self.assertIsNot(plain, promoted)

    def test_shogi_promotion_and_hand_drop(self):
        game = ShogiGame()
        game.board = [[None for _ in range(9)] for _ in range(9)]
        game.board[3][3] = Piece(PieceType.PAWN, Color.SENTE)
        self.assertTrue(game.make_move((3, 3), (2, 3), promote=True))
        self.assertTrue(game.board[2][3].promoted)

        game.turn = Color.SENTE
        game.hands[Color.SENTE][PieceType.ROOK] = 1
        self.assertTrue(game.make_move(None, (4, 4), drop_type=PieceType.ROOK))
        self.assertEqual(game.board[4][4].type, PieceType.ROOK)
        self.assertEqual(game.hands[Color.SENTE][PieceType.ROOK], 0)

    def test_shogi_rejects_a_move_that_leaves_own_king_in_check(self):
        game = self.empty_shogi()
        game.board[8][4] = Piece(PieceType.KING, Color.SENTE)
        game.board[7][4] = Piece(PieceType.ROOK, Color.SENTE)
        game.board[0][4] = Piece(PieceType.ROOK, Color.GOTE)
        self.assertFalse(game.make_move((7, 4), (7, 3)))
        self.assertIsNotNone(game.board[7][4])

    def test_shogi_legal_destinations_exclude_check_leaving_moves(self):
        game = self.empty_shogi()
        game.board[8][4] = Piece(PieceType.KING, Color.SENTE)
        game.board[7][4] = Piece(PieceType.BISHOP, Color.SENTE)
        game.board[0][4] = Piece(PieceType.ROOK, Color.GOTE)
        game.board[0][0] = Piece(PieceType.KING, Color.GOTE)
        # The bishop is pinned: every pseudo-legal move exposes the king, so
        # it shows up in the pseudo-legal selectable list but must not appear
        # among the legal selection candidates.
        self.assertIn((7, 4), game.get_selectable_pieces())
        self.assertEqual(game.legal_destinations(7, 4), [])
        self.assertNotIn((7, 4), game.get_legal_selectable_pieces())

        # A rook on the same file can move along the file but not sideways.
        game.board[7][4] = Piece(PieceType.ROOK, Color.SENTE)
        destinations = game.legal_destinations(7, 4)
        self.assertIn((6, 4), destinations)
        self.assertNotIn((7, 3), destinations)

    def test_shogi_ai_candidates_include_promote_and_non_promote(self):
        game = self.empty_shogi()
        game.board[8][4] = Piece(PieceType.KING, Color.SENTE)
        game.board[0][0] = Piece(PieceType.KING, Color.GOTE)
        game.board[3][3] = Piece(PieceType.PAWN, Color.SENTE)
        candidates = _shogi_candidates(game)
        self.assertIn(((3, 3), (2, 3), False, None), candidates)
        self.assertIn(((3, 3), (2, 3), True, None), candidates)
        # Every candidate the AI can pick must be executable as-is.
        for source, dest, promote, drop_type in candidates:
            with self.subTest(candidate=(source, dest, promote, drop_type)):
                trial = deepcopy(game)
                self.assertTrue(trial.make_move(source, dest, promote=promote, drop_type=drop_type))

    def test_shogi_detects_checkmate(self):
        game = self.empty_shogi()
        game.board[8][8] = Piece(PieceType.KING, Color.SENTE)
        game.board[0][8] = Piece(PieceType.ROOK, Color.GOTE)
        game.board[8][0] = Piece(PieceType.ROOK, Color.GOTE)
        game.board[6][6] = Piece(PieceType.BISHOP, Color.GOTE)
        self.assertTrue(game.is_in_check(Color.SENTE))
        self.assertTrue(game.is_checkmate(Color.SENTE))


class ShogiMoveFlowTest(unittest.IsolatedAsyncioTestCase):
    async def test_select_flow_executes_non_promotion_move(self):
        cog = Shogi(None)
        cog._update_board_msg = AsyncMock()
        session = ShogiSession(1, 1, 1, mode="cpu")
        session.phase = "playing"
        source = session.game.get_selectable_pieces()[0]
        destination = session.game._generate_moves(*source)[0]
        labels = [("A", source), ("B", destination)]

        class Response:
            async def defer(self):
                return None

        channel = SimpleNamespace()
        interaction = SimpleNamespace(
            response=Response(), message=SimpleNamespace(channel=channel), channel=channel
        )
        await cog.handle_select(interaction, session, dict(labels), "A")
        await cog.handle_select(interaction, session, dict(labels), "B")

        self.assertTrue(session.acted)
        self.assertEqual(session.game.turn, Color.GOTE)

    def make_interaction(self, channel):
        class Response:
            async def defer(self):
                return None

        return SimpleNamespace(
            response=Response(),
            message=SimpleNamespace(channel=channel),
            channel=channel,
            followup=AsyncMock(),
        )

    def promotion_session(self, cog):
        session = ShogiSession(1, 1, 1, mode="cpu")
        session.phase = "playing"
        game = session.game
        game.board = [[None for _ in range(9)] for _ in range(9)]
        game.board[8][4] = Piece(PieceType.KING, Color.SENTE)
        game.board[0][0] = Piece(PieceType.KING, Color.GOTE)
        game.board[3][3] = Piece(PieceType.PAWN, Color.SENTE)
        game.turn = Color.SENTE
        cog._update_board_msg = AsyncMock()
        return session

    async def test_select_flow_asks_promotion_and_promotes(self):
        cog = Shogi(None)
        session = self.promotion_session(cog)
        channel = SimpleNamespace()
        interaction = self.make_interaction(channel)

        await cog.handle_select(interaction, session, {"A": (3, 3)}, "A")
        self.assertEqual(session.state, "select_dest")
        await cog.handle_select(interaction, session, {"A": (2, 3)}, "A")
        # Promotion is optional here: the move must wait for the choice.
        self.assertEqual(session.state, "select_promote")
        self.assertFalse(session.acted)
        self.assertEqual(session.game.turn, Color.SENTE)
        self.assertIsNotNone(session.game.board[3][3])

        await cog.handle_promote_choice(interaction, session, True)
        self.assertTrue(session.acted)
        self.assertTrue(session.game.board[2][3].promoted)
        self.assertEqual(session.game.turn, Color.GOTE)

    async def test_coordinate_flow_can_decline_promotion(self):
        cog = Shogi(None)
        session = self.promotion_session(cog)
        channel = SimpleNamespace()
        interaction = self.make_interaction(channel)

        await cog.handle_coordinate_input(interaction, session, "44")
        self.assertEqual(session.state, "select_dest")
        await cog.handle_coordinate_input(interaction, session, "34")
        self.assertEqual(session.state, "select_promote")
        self.assertFalse(session.acted)

        await cog.handle_promote_choice(interaction, session, False)
        self.assertTrue(session.acted)
        self.assertFalse(session.game.board[2][3].promoted)
        self.assertEqual(session.game.turn, Color.GOTE)

    async def test_illegal_destination_reports_error_and_keeps_state(self):
        cog = Shogi(None)
        cog._update_board_msg = AsyncMock()
        session = ShogiSession(1, 1, 1, mode="cpu")
        session.phase = "playing"
        game = session.game
        game.board = [[None for _ in range(9)] for _ in range(9)]
        game.board[8][4] = Piece(PieceType.KING, Color.SENTE)
        game.board[7][4] = Piece(PieceType.ROOK, Color.SENTE)
        game.board[0][4] = Piece(PieceType.ROOK, Color.GOTE)
        game.board[0][0] = Piece(PieceType.KING, Color.GOTE)
        game.turn = Color.SENTE
        channel = SimpleNamespace()
        interaction = self.make_interaction(channel)

        await cog.handle_select(interaction, session, {"A": (7, 4)}, "A")
        self.assertEqual(session.state, "select_dest")
        interaction.followup.reset_mock()
        # Moving the pinned rook sideways would leave the king in check.
        await cog.handle_select(interaction, session, {"B": (7, 3)}, "B")

        self.assertFalse(session.acted)
        self.assertEqual(session.state, "select_dest")
        self.assertEqual(session.game.turn, Color.SENTE)
        interaction.followup.send.assert_awaited_once()
        _, kwargs = interaction.followup.send.call_args
        self.assertTrue(kwargs.get("ephemeral"))

if __name__ == "__main__":
    unittest.main()
