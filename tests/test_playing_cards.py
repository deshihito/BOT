# -*- coding: utf-8 -*-
"""共通トランプ描画基盤（core/game/board_image.py）と各ゲームへの適用のテスト。

カード画像化タスク（2026-11-06）:
- 標準52枚＋ジョーカーが全て描ける・決定的・スートが描き分けられる。
- 各 cog の内部表記 → 描画 spec 変換が漏れなく一意。
- 秘匿: ダウトの場／ババ抜きの相手手札の共有画像は「枚数だけ」から作られ、
  中身が違っても同枚数なら同一バイト列になる（構造的に混入しない）。
"""

import inspect
import io
import unittest

from PIL import Image

from core.game import board_image
from core.game.board_image import (
    CARD_JOKER, card_spec, render_card, render_card_hand, render_card_pile,
    render_card_rows,
)
from core.game.poker import cog as poker_cog
from core.game.daifugo import cog as daifugo_cog
from core.game.doubt import cog as doubt_cog
from core.game.babanuki import cog as babanuki_cog
from core.game.highlow_cog import cog as highlow_cog
from core.game.highlow import new_deck
import random


def png_size(data: bytes):
    return Image.open(io.BytesIO(data)).size


def full_deck_specs():
    return [card_spec(r, s) for s in board_image.CARD_SUITS
            for r in board_image.CARD_RANKS]


class CardRenderTest(unittest.TestCase):
    def test_all_53_cards_render(self):
        specs = full_deck_specs() + [CARD_JOKER, None]
        self.assertEqual(len(specs), 54)
        for spec in specs:
            data = render_card(spec)
            w, h = png_size(data)
            self.assertGreater(w, 0)
            self.assertGreater(h, 0)

    def test_deterministic(self):
        spec = card_spec("Q", "H")
        self.assertEqual(render_card(spec), render_card(spec))
        hand = [card_spec("A", "S"), card_spec("10", "D"), CARD_JOKER, None]
        self.assertEqual(render_card_hand(hand), render_card_hand(hand))

    def test_suits_and_ranks_differ(self):
        base = render_card(card_spec("7", "S"))
        for suit in "HDC":
            self.assertNotEqual(base, render_card(card_spec("7", suit)))
        self.assertNotEqual(base, render_card(card_spec("8", "S")))
        self.assertNotEqual(base, render_card(CARD_JOKER))
        self.assertNotEqual(base, render_card(None))

    def test_card_spec_validation(self):
        self.assertEqual(card_spec("10", "d"), ("10", "D"))
        with self.assertRaises(ValueError):
            card_spec("1", "S")
        with self.assertRaises(ValueError):
            card_spec("A", "X")

    def test_hand_sizes(self):
        specs = full_deck_specs()
        for n in (0, 1, 2, 5, 13, 18, 27):
            data = render_card_hand(specs[:n])
            w, h = png_size(data)
            self.assertGreater(w, 0)
            self.assertLessEqual(w, 1024 + 24)  # PAD 込みでも際限なく広がらない
            self.assertGreater(h, 0)
        # 27枚までは扇形で1行に収まるが、それを超えると折り返す
        deck2 = specs + [CARD_JOKER]
        self.assertGreater(png_size(render_card_hand(deck2[:40]))[1],
                           png_size(render_card_hand(specs[:5]))[1])

    def test_rows_and_pile(self):
        rows = [("P1", full_deck_specs()[:5]), ("P2", full_deck_specs()[5:10])]
        data = render_card_rows(rows, title="ショーダウン")
        self.assertGreater(png_size(data)[1], 300)
        for count in (0, 1, 7, 30):
            w, h = png_size(render_card_pile(count, label="場のカード"))
            self.assertGreater(w, 0)
            self.assertGreater(h, 0)
        # 枚数が違えば山の画像も違う（枚数表示が変わる）
        self.assertNotEqual(render_card_pile(3), render_card_pile(4))


class ConverterTest(unittest.TestCase):
    def test_poker_converter_covers_deck(self):
        specs = {poker_cog.card_spec_of(c) for c in poker_cog.deck()}
        self.assertEqual(specs, set(full_deck_specs()))

    def test_daifugo_converter_covers_deck(self):
        specs = {daifugo_cog.card_spec_of(c) for c in daifugo_cog.make_deck()}
        self.assertEqual(specs, set(full_deck_specs()) | {CARD_JOKER})
        self.assertEqual(daifugo_cog.card_spec_of("JOKER"), CARD_JOKER)
        self.assertEqual(daifugo_cog.card_spec_of("H10"), ("10", "H"))

    def test_babanuki_converter_covers_deck(self):
        specs = {babanuki_cog.card_spec_of(c) for c in babanuki_cog.make_deck()}
        self.assertEqual(specs, set(full_deck_specs()) | {CARD_JOKER})

    def test_doubt_converter_covers_deck(self):
        suits = ["S", "H", "D", "C"]
        cards = [f"[{s}-{r}]" for s in suits for r in range(1, 14)] + ["[JK-1]", "[JK-2]"]
        specs = {doubt_cog.card_spec_of(c) for c in cards}
        self.assertEqual(specs, set(full_deck_specs()) | {CARD_JOKER})
        self.assertEqual(doubt_cog.card_spec_of("[S-1]"), ("A", "S"))
        self.assertEqual(doubt_cog.card_spec_of("[D-13]"), ("K", "D"))
        self.assertEqual(doubt_cog.card_spec_of("[JK-2]"), CARD_JOKER)

    def test_highlow_converter_covers_deck(self):
        deck = new_deck(random.Random(3))
        specs = {highlow_cog.card_spec_of(c) for c in deck}
        self.assertEqual(specs, set(full_deck_specs()))
        self.assertEqual(highlow_cog.card_spec_of((14, "♠")), ("A", "S"))
        self.assertEqual(highlow_cog.card_spec_of((10, "♥")), ("10", "H"))


class SecrecyStructureTest(unittest.TestCase):
    """共有画像の生成関数が「枚数だけ」を受けることの構造検証。"""

    def test_doubt_field_file_takes_only_count(self):
        params = list(inspect.signature(doubt_cog.field_file).parameters)
        self.assertEqual(params, ["count", "filename"])
        params = list(inspect.signature(render_card_pile).parameters)
        self.assertNotIn("cards", params)
        self.assertNotIn("hand", params)

    def test_babanuki_backs_file_takes_only_count(self):
        params = list(inspect.signature(babanuki_cog.backs_file).parameters)
        self.assertEqual(params, ["count", "filename"])

    def test_pile_bytes_depend_only_on_count(self):
        # 中身が全く違う場でも、同枚数なら共有画像は同一（=中身は渡っていない）
        a = doubt_cog.field_file(6)
        b = doubt_cog.field_file(6)
        self.assertEqual(a.fp.read(), b.fp.read())
        c = babanuki_cog.backs_file(9)
        d = babanuki_cog.backs_file(9)
        self.assertEqual(c.fp.read(), d.fp.read())

    def test_poker_hand_image_uses_only_given_hand(self):
        hand = ["A♠", "K♠", "Q♠", "J♠", "T♠"]
        data1 = poker_cog.hand_image(hand)
        data2 = poker_cog.hand_image(["2♣", "3♣", "4♣", "5♣", "6♣"])
        self.assertNotEqual(data1, data2)
        self.assertEqual(data1, poker_cog.hand_image(list(hand)))


if __name__ == "__main__":
    unittest.main()
