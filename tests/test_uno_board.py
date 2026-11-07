"""UNO の盤面・手札画像レンダラー (core/game/uno/board.py) のテスト。"""
from __future__ import annotations

import io
import unittest

from PIL import Image

from core.game.uno import board


def _png_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as img:
        assert img.format == "PNG"
        return img.size


class ParseCardTest(unittest.TestCase):
    def test_colored_cards(self):
        self.assertEqual(board.parse_card("赤の5"), ("赤", "5"))
        self.assertEqual(board.parse_card("青のSkip"), ("青", "Skip"))
        self.assertEqual(board.parse_card("黄のReverse"), ("黄", "Reverse"))
        self.assertEqual(board.parse_card("緑の+2"), ("緑", "+2"))

    def test_wild_cards(self):
        self.assertEqual(board.parse_card("Wild"), (None, "Wild"))
        self.assertEqual(board.parse_card("Wild+4"), (None, "Wild+4"))


class RenderBoardTest(unittest.TestCase):
    def _players(self, n: int):
        return [{"name": f"player{i}", "count": (i % 7) + 1} for i in range(n)]

    def test_two_players_default_size(self):
        data = board.render_board(
            top_card="赤の5", active_color="赤", players=self._players(2),
            current_idx=0, direction=1, deck_count=90)
        self.assertEqual(_png_size(data), (1000, 600))

    def test_many_players_grows_height(self):
        data = board.render_board(
            top_card="青のSkip", active_color="青", players=self._players(8),
            current_idx=3, direction=-1, deck_count=42, pending_draw=4)
        width, height = _png_size(data)
        self.assertEqual(width, 1000)
        self.assertGreater(height, 600)

    def test_wild_top_with_chosen_color(self):
        data = board.render_board(
            top_card="Wild+4", active_color="緑", players=self._players(3),
            current_idx=1, direction=1, deck_count=10, pending_draw=4)
        self.assertEqual(_png_size(data), (1000, 600))

    def test_uno_badge_player(self):
        players = [{"name": "a", "count": 1}, {"name": "b", "count": 4}]
        data = board.render_board(
            top_card="黄の0", active_color=None, players=players,
            current_idx=0, direction=1, deck_count=50)
        self.assertEqual(_png_size(data), (1000, 600))


class RenderHandTest(unittest.TestCase):
    def test_all_card_types_render(self):
        hand = [
            "赤の0", "赤の9", "青のSkip", "緑のReverse", "黄の+2",
            "Wild", "Wild+4", "青の5",
        ]
        data = board.render_hand(hand, playable={"青の5", "Wild"})
        width, height = _png_size(data)
        self.assertGreater(width, 0)
        self.assertGreater(height, 0)

    def test_large_hand_wraps_rows(self):
        hand = ["赤の1"] * 20
        single = board.render_hand(["赤の1"] * 8)
        double = board.render_hand(hand, playable=set())
        self.assertGreater(_png_size(double)[1], _png_size(single)[1])

    def test_empty_hand(self):
        data = board.render_hand([], playable=set())
        self.assertGreater(len(data), 0)


class DrawCardTest(unittest.TestCase):
    def test_every_deck_card_draws(self):
        # UnoGame.setup_deck と同じ構成の全種別を1枚ずつ描いて落ちないこと
        img = Image.new("RGBA", (1200, 400), (24, 26, 32, 255))
        cards = []
        for color in ("赤", "青", "黄", "緑"):
            for value in [str(i) for i in range(10)] + ["Skip", "Reverse", "+2"]:
                cards.append(f"{color}の{value}")
        cards += ["Wild", "Wild+4"]
        for i, card in enumerate(cards):
            board.draw_card(img, (i % 12) * 100, (i // 12) * 100, 90, 126, card)
        board.draw_card(img, 1100, 300, 90, 126, "Wild", back=True)
        board.draw_card(img, 1000, 300, 90, 126, "緑の7", dim=True)


if __name__ == "__main__":
    unittest.main()
