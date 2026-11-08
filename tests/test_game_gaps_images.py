# -*- coding: utf-8 -*-
"""game-gaps（2026-11-08）: 残存ギャップ分の盤面/集計レンダラの検証。

- 各レンダラの決定性（同じ入力→同じバイト列）
- コードネーム共有盤面の秘匿（未開示セルの種類が共有用セルに現れない）
- 星か爆弾かの行データは伏せディスクの「枚数」だけを受け、中身を持たない
"""
import unittest

from core.game.game import board_image as bi


def _words():
    return [f"word{i}" for i in range(25)]


def _key():
    return (["red"] * 9 + ["blue"] * 8 + ["neutral"] * 7 + ["assassin"])


class TestCodenamesPrivacy(unittest.TestCase):
    def test_public_cells_hide_unrevealed_kinds(self):
        key = _key()
        revealed = [False] * 25
        revealed[0] = True  # red, opened
        cells = bi.codenames_public_cells(key, revealed)
        for i, (kind, rev) in enumerate(cells):
            if i == 0:
                self.assertEqual((kind, rev), ("red", True))
            else:
                # 未開示は種類が落ちていなければならない（秘匿の構造担保）
                self.assertIsNone(kind, msg=f"cell {i} leaks kind {kind}")
                self.assertFalse(rev)

    def test_key_cells_keep_all_kinds(self):
        cells = bi.codenames_key_cells(_key(), [False] * 25)
        kinds = {k for k, _ in cells}
        self.assertEqual(kinds, {"red", "blue", "neutral", "assassin"})

    def test_render_deterministic(self):
        cells = bi.codenames_public_cells(_key(), [i % 3 == 0 for i in range(25)])
        a = bi.render_codenames_board(_words(), cells)
        b = bi.render_codenames_board(_words(), list(cells))
        self.assertEqual(a, b)
        self.assertTrue(a.startswith(b"\x89PNG"))


class TestRenderersDeterministic(unittest.TestCase):
    def test_bingo_board(self):
        a = bi.render_bingo_board({1, 16, 31, 46, 61, 75})
        b = bi.render_bingo_board({75, 61, 46, 31, 16, 1})
        self.assertEqual(a, b)
        self.assertNotEqual(a, bi.render_bingo_board(set()))

    def test_bars(self):
        rows = [("A: 犬派", 3), ("B: 猫派", 5)]
        self.assertEqual(bi.render_bars(rows), bi.render_bars(list(rows)))
        self.assertEqual(bi.render_bars([]), bi.render_bars([]))

    def test_mendou_rows(self):
        rows = [("A の場", [("宿題", 2), ("残業", 1)]), ("B の場", [("掃除当番", 1)])]
        self.assertEqual(bi.render_mendou_rows(rows), bi.render_mendou_rows(rows))
        self.assertNotEqual(bi.render_mendou_rows(rows),
                            bi.render_mendou_rows([("A の場", [("宿題", 3)])]))

    def test_loveletter_cards(self):
        cards = [(1, "門番"), (8, "アゴ姫")]
        self.assertEqual(bi.render_loveletter_cards(cards),
                         bi.render_loveletter_cards(list(cards)))
        self.assertNotEqual(bi.render_loveletter_cards(cards),
                            bi.render_loveletter_cards([(2, "密偵"), (8, "アゴ姫")]))


class TestHoshiBoardPrivacy(unittest.TestCase):
    def test_rows_carry_counts_only(self):
        # 行データの契約: stack は int（枚数）。中身（kind の列）は伏せ分に現れない。
        rows = [{"label": "プレイヤー1", "stack": 3,
                 "flipped": ["star"], "active": True}]
        a = bi.render_hoshi_board(rows)
        b = bi.render_hoshi_board([dict(rows[0])])
        self.assertEqual(a, b)
        # 伏せ枚数が変われば画像も変わる（情報が枚数に依存することの確認）
        rows2 = [dict(rows[0], stack=4)]
        self.assertNotEqual(a, bi.render_hoshi_board(rows2))


if __name__ == "__main__":
    unittest.main()
