# -*- coding: utf-8 -*-
"""将棋の駒が外部素材なしの自前描画になっていることのテスト。Discord には接続しない。

- 全種別×成り×先後で駒画像が描ける（透明だけの画像にならない）
- 後手の成駒は赤文字、後手の駒は180°回っている
- 盤面レンダリングが従来どおり PNG を返す
"""

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from core.game.shogi.cog import ShogiRenderer, _draw_piece  # noqa: E402
from core.game.shogi.shogi_engine import Color, Piece, PieceType, ShogiGame  # noqa: E402


def _opaque_count(img) -> int:
    alpha = img.convert("RGBA").getchannel("A")
    return sum(1 for v in alpha.getdata() if v > 0)


def _has_red(img) -> bool:
    for r, g, b, a in img.convert("RGBA").getdata():
        # 赤文字 (178,32,38) を拾う。木地のグラデーション (g≈158) と、
        # リサイズで生じるほぼ透明な縁ピクセル (a が小さい) は除外する
        if a > 128 and r > 120 and g < 80 and r - g > 100:
            return True
    return False


class SelfDrawnPieceTest(unittest.TestCase):
    def setUp(self):
        self.renderer = ShogiRenderer()

    def test_all_pieces_render_with_ink(self):
        for ptype in PieceType:
            for promoted in (False, True):
                for color in (Color.SENTE, Color.GOTE):
                    img = self.renderer._piece_img(Piece(ptype, color, promoted))
                    self.assertLessEqual(img.width, 62)
                    self.assertLessEqual(img.height, 62)
                    self.assertGreater(_opaque_count(img), 500, (ptype, promoted, color))

    def test_king_faces_differ_by_color(self):
        sente = self.renderer._piece_img(Piece(PieceType.KING, Color.SENTE))
        gote = self.renderer._piece_img(Piece(PieceType.KING, Color.GOTE))
        self.assertEqual(sente.size, gote.size)
        self.assertNotEqual(sente.tobytes(), gote.tobytes())  # 王/玉＋回転で別画像

    def test_gote_promoted_is_red_sente_is_not(self):
        gote = self.renderer._piece_img(Piece(PieceType.PAWN, Color.GOTE, True))
        sente = self.renderer._piece_img(Piece(PieceType.PAWN, Color.SENTE, True))
        self.assertTrue(_has_red(gote))
        self.assertFalse(_has_red(sente))

    def test_two_char_and_blank_pieces(self):
        for text in ("成銀", "と金", ""):
            img = _draw_piece(text, False)
            self.assertGreater(_opaque_count(img), 1000, text)

    def test_board_render_returns_png(self):
        out = ShogiRenderer().render(ShogiGame())
        self.assertEqual(out.read(8), b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
