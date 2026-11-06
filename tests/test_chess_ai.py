import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
from PIL import Image

import cogs.chess as chess_module
from cogs.chess import (
    ASSET, PAGE_NEXT_VALUE, PAGE_PREV_VALUE, START_BOARD, Chess, ChessGame,
    ChessMoveSelect, apply_move, build_sprites, choose_ai_move, in_check,
    legal_moves, move_label, next_ep_square, paginate_labels, render_board,
    updated_castling,
)
from cogs.game import ChessDifficultySelect, ChessModeSelect, GameDetailView


def empty_board():
    return [list("........") for _ in range(8)]


class ChessAiTest(unittest.TestCase):
    def test_each_difficulty_returns_a_legal_move(self):
        for difficulty in range(1, 11):
            with self.subTest(difficulty=difficulty):
                board = [row[:] for row in START_BOARD]
                move = choose_ai_move(board, "black", difficulty)
                self.assertIn(move, legal_moves(board, "black"))
                self.assertEqual(board, START_BOARD)

    def test_apply_move_does_not_mutate_original(self):
        move = ((6, 4), (4, 4))
        board = apply_move(START_BOARD, move)
        self.assertEqual(START_BOARD[6][4], "P")
        self.assertEqual(board[4][4], "P")
        self.assertEqual(board[6][4], ".")

    def test_difficulty_selector_has_values_one_to_ten(self):
        selector = ChessDifficultySelect(5)
        self.assertEqual([int(option.value) for option in selector.options], list(range(1, 11)))
        self.assertTrue(selector.options[4].default)

    def test_chess_detail_view_exposes_mode_and_difficulty(self):
        view = GameDetailView(type("Cog", (), {})(), "chess")
        selects = [child for child in view.children if isinstance(child, discord.ui.Select)]
        self.assertTrue(any(isinstance(child, ChessModeSelect) for child in selects))
        self.assertTrue(any(isinstance(child, ChessDifficultySelect) for child in selects))


class ChessBoardSetupTest(unittest.TestCase):
    def test_start_board_empty_rows_are_independent(self):
        rows = START_BOARD[2:6]
        self.assertEqual(len({id(row) for row in rows}), 4)
        board = [row[:] for row in START_BOARD]
        board[2][0] = "X"
        self.assertEqual(board[3][0], ".")
        self.assertEqual(START_BOARD[2][0], ".")

    def test_white_sprite_mapping_uses_measured_rows(self):
        sheet = Image.open(ASSET).convert("RGBA")
        sprites = build_sprites(sheet)

        def crop(x, y):
            return sheet.crop((x, y, x + 90, y + 92)).tobytes()

        # 白の後列は y=680、白ポーンは y=590（実測レイアウト）。
        self.assertEqual(sprites[("white", "K")].tobytes(), crop(760 + 4 * 90, 680))
        self.assertEqual(sprites[("white", "Q")].tobytes(), crop(760 + 3 * 90, 680))
        self.assertEqual(sprites[("white", "P")].tobytes(), crop(760 + 7 * 90, 590))
        # 黒は従来どおり後列 y=32、ポーン y=132。
        self.assertEqual(sprites[("black", "K")].tobytes(), crop(760 + 4 * 90, 32))
        self.assertEqual(sprites[("black", "P")].tobytes(), crop(760 + 7 * 90, 132))
        # 白ルークと白ポーンは別の絵でなければならない（配置バグの回帰防止）。
        self.assertNotEqual(sprites[("white", "R")].tobytes(), sprites[("white", "P")].tobytes())
        self.assertNotEqual(sprites[("white", "K")].tobytes(), sprites[("white", "P")].tobytes())

    def test_render_board_returns_800x800_png(self):
        out = render_board([row[:] for row in START_BOARD])
        image = Image.open(out)
        self.assertEqual(image.size, (800, 800))


class ChessCastlingTest(unittest.TestCase):
    def board(self):
        board = empty_board()
        board[7][4] = "K"
        board[7][0] = "R"
        board[7][7] = "R"
        board[0][4] = "k"
        return board

    def test_castling_is_legal_and_moves_the_rook(self):
        board = self.board()
        moves = legal_moves(board, "white")
        self.assertIn(((7, 4), (7, 6)), moves)
        self.assertIn(((7, 4), (7, 2)), moves)
        after = apply_move(board, ((7, 4), (7, 6)))
        self.assertEqual(after[7][6], "K")
        self.assertEqual(after[7][5], "R")
        self.assertEqual(after[7][7], ".")
        self.assertEqual(after[7][4], ".")

    def test_castling_through_check_is_illegal(self):
        board = self.board()
        board[0][5] = "r"  # f筋のルークが f1 を攻撃する。
        moves = legal_moves(board, "white")
        self.assertNotIn(((7, 4), (7, 6)), moves)
        self.assertIn(((7, 4), (7, 2)), moves)

    def test_castling_out_of_check_is_illegal(self):
        board = self.board()
        board[0][0] = "."
        board[1][4] = "r"  # e筋のルークで白キングにチェック。
        self.assertTrue(in_check(board, "white"))
        moves = legal_moves(board, "white")
        self.assertNotIn(((7, 4), (7, 6)), moves)
        self.assertNotIn(((7, 4), (7, 2)), moves)

    def test_castling_rights_are_lost_after_king_or_rook_moves(self):
        board = self.board()
        rights = {"K", "Q", "k", "q"}
        self.assertEqual(updated_castling(rights, board, ((7, 4), (7, 3))), {"k", "q"})
        self.assertEqual(updated_castling(rights, board, ((7, 7), (6, 7))), {"Q", "k", "q"})
        self.assertEqual(updated_castling(rights, board, ((7, 0), (6, 0))), {"K", "k", "q"})


class ChessEnPassantTest(unittest.TestCase):
    def test_en_passant_is_offered_and_applied(self):
        board = empty_board()
        board[7][4] = "K"
        board[0][4] = "k"
        board[3][4] = "P"
        board[3][3] = "p"
        self.assertIn(((3, 4), (2, 3)), legal_moves(board, "white", ep=(2, 3)))
        self.assertNotIn(((3, 4), (2, 3)), legal_moves(board, "white"))
        after = apply_move(board, ((3, 4), (2, 3)), ep=(2, 3))
        self.assertEqual(after[2][3], "P")
        self.assertEqual(after[3][3], ".")
        self.assertEqual(after[3][4], ".")

    def test_double_push_sets_en_passant_square(self):
        board = empty_board()
        board[1][3] = "p"
        self.assertEqual(next_ep_square(board, ((1, 3), (3, 3))), (2, 3))
        board[6][4] = "P"
        self.assertEqual(next_ep_square(board, ((6, 4), (4, 4))), (5, 4))
        self.assertIsNone(next_ep_square(board, ((6, 4), (5, 4))))


class ChessEndgameTest(unittest.TestCase):
    def test_checkmate_position_has_no_legal_moves(self):
        # Fool's mate: 1. f3 e5 2. g4 Qh4#
        board = [row[:] for row in START_BOARD]
        castling = {"K", "Q", "k", "q"}
        ep = None
        for move in (((6, 5), (5, 5)), ((1, 4), (3, 4)), ((6, 6), (4, 6)), ((0, 3), (4, 7))):
            castling = updated_castling(castling, board, move)
            new_ep = next_ep_square(board, move)
            board = apply_move(board, move, ep=ep)
            ep = new_ep
        self.assertTrue(in_check(board, "white"))
        self.assertEqual(legal_moves(board, "white", castling=castling, ep=ep), [])

    def test_stalemate_position_has_no_legal_moves_without_check(self):
        board = empty_board()
        board[0][0] = "k"
        board[2][1] = "Q"
        board[7][2] = "K"
        self.assertFalse(in_check(board, "black"))
        self.assertEqual(legal_moves(board, "black"), [])


def queen_board():
    board = empty_board()
    board[0][0] = "K"
    board[7][7] = "k"
    board[4][3] = "Q"
    return board


def queen_destinations(board):
    return [dest for source, dest in legal_moves(board, "white") if source == (4, 3)]


class ChessPaginationTest(unittest.TestCase):
    def test_queen_destinations_are_all_reachable_across_pages(self):
        destinations = queen_destinations(queen_board())
        # A lone queen on d4-ish has 28 destinations: more than one Select page.
        self.assertGreater(len(destinations), 25)
        labels = [(move_label(i), dest) for i, dest in enumerate(destinations)]

        reached = []
        page = 0
        while True:
            page_labels, page, total = paginate_labels(labels, page)
            self.assertLessEqual(len(page_labels), 24)
            reached.extend(pos for _, pos in page_labels)
            if page + 1 >= total:
                break
            page += 1
        self.assertEqual(reached, destinations)

        for page_index in range(total):
            select = ChessMoveSelect(None, object(), labels, "destination", page_index)
            self.assertLessEqual(len(select.options), 25)
            values = [option.value for option in select.options]
            if page_index > 0:
                self.assertIn(PAGE_PREV_VALUE, values)
            if page_index + 1 < total:
                self.assertIn(PAGE_NEXT_VALUE, values)

    def test_single_page_has_no_navigation_options(self):
        labels = [(move_label(i), (0, i)) for i in range(10)]
        select = ChessMoveSelect(None, object(), labels, "source", 0)
        self.assertEqual([option.value for option in select.options],
                         [label for label, _ in labels])

    def test_chess_has_no_reaction_input_path(self):
        self.assertFalse(hasattr(Chess, "on_reaction_add"))
        self.assertFalse(hasattr(chess_module, "reaction_emoji"))
        self.assertFalse(hasattr(Chess(None), "reaction_sessions"))


class ChessPageTurnTest(unittest.IsolatedAsyncioTestCase):
    def make_interaction(self):
        return SimpleNamespace(
            response=SimpleNamespace(defer=AsyncMock()),
            message=SimpleNamespace(edit=AsyncMock()),
        )

    async def test_page_navigation_does_not_change_board_or_turn(self):
        cog = Chess(None)
        g = ChessGame(1, 1, 1, mode="cpu")
        g.phase = "playing"
        g.board = queen_board()
        g.selected = (4, 3)
        destinations = queen_destinations(g.board)
        labels = [(move_label(i), dest) for i, dest in enumerate(destinations)]
        board_before = [row[:] for row in g.board]
        interaction = self.make_interaction()

        await cog.handle_select(interaction, g, labels, "destination", PAGE_NEXT_VALUE, page=0)

        self.assertFalse(g.acted)
        self.assertEqual(g.turn, "white")
        self.assertEqual(g.board, board_before)
        self.assertEqual(g.selected, (4, 3))
        interaction.message.edit.assert_awaited_once()
        view = interaction.message.edit.call_args.kwargs["view"]
        select = view.select
        self.assertEqual(select.page, 1)
        page_labels, _, _ = paginate_labels(labels, 1)
        self.assertEqual(select.labels, dict(page_labels))

    async def test_candidate_on_second_page_executes_the_move(self):
        cog = Chess(None)
        g = ChessGame(1, 1, 1, mode="cpu")
        g.phase = "playing"
        g.board = queen_board()
        g.selected = (4, 3)
        destinations = queen_destinations(g.board)
        labels = [(move_label(i), dest) for i, dest in enumerate(destinations)]
        page_labels, _, _ = paginate_labels(labels, 1)
        label, dest = page_labels[0]
        interaction = self.make_interaction()

        await cog.handle_select(interaction, g, labels, "destination", label, page=1)

        self.assertTrue(g.acted)
        self.assertEqual(g.turn, "black")
        self.assertEqual(g.board[dest[0]][dest[1]], "Q")
        self.assertEqual(g.board[4][3], ".")


if __name__ == "__main__":
    unittest.main()
