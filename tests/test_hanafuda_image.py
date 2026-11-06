# -*- coding: utf-8 -*-
"""花札描画基盤（core/game/board_image.py の render_hanafuda 系）と
こいこい cog への適用のテスト。

こいこい画像化タスク（2026-11-06）:
- 48枚＋裏面が全て描ける・決定的・月/種別が描き分けられる。
- 短冊帯の色（赤短/青短/無地）と光の赤帯をピクセルで検証する。
- 秘匿: 公開盤面の行構成は場札と取り札だけから作られ、手札は混入しない。
  手札画像は「自分の手札＋場の月の集合」だけに依存する。
"""

import inspect
import io
import random
import unittest

from PIL import Image

from core.game import board_image
from core.game.board_image import PAD, render_hanafuda, render_hanafuda_hand, render_hanafuda_rows
from core.game.koikoi import CARDS, KoikoiMatch
from core.game.koikoi_cog import cog as koikoi_cog


def png(data: bytes):
    return Image.open(io.BytesIO(data))


def card_pixel(data: bytes, fx: float, fy: float, card_w: int = 88):
    """render_hanafuda 出力内の札の相対座標 (fx, fy) のピクセル色。"""
    img = png(data).convert("RGB")
    w, h = board_image.hanafuda_size(card_w)
    return img.getpixel((PAD + int(w * fx), PAD + int(h * fy)))


def by_tag(tag):
    return next(i for i, c in CARDS.items() if c["tag"] == tag)


class HanafudaRenderTest(unittest.TestCase):
    def test_all_48_render_and_deterministic(self):
        w, h = board_image.hanafuda_size(88)
        for cid in range(48):
            data = render_hanafuda(cid)
            self.assertEqual(png(data).size, (w + PAD * 2, h + PAD * 2))
            self.assertEqual(data, render_hanafuda(cid))

    def test_back_is_red_and_differs_from_faces(self):
        data = render_hanafuda(None)
        self.assertEqual(data, render_hanafuda(None))
        r, g, b = card_pixel(data, 0.5, 0.5)
        self.assertGreater(r, g + 40)  # 濃赤地
        for cid in range(48):
            self.assertNotEqual(data, render_hanafuda(cid))

    def test_invalid_id(self):
        with self.assertRaises(ValueError):
            render_hanafuda(48)

    def test_same_month_kinds_differ(self):
        # 同じ月の札は (種別, タグ) の組の数だけ描き分けられる
        # （カスのペアは同一絵柄でよい）
        for month in range(1, 13):
            ids = [i for i, c in CARDS.items() if c["month"] == month]
            combos = {(CARDS[i]["kind"], CARDS[i]["tag"]) for i in ids}
            rendered = {render_hanafuda(i) for i in ids}
            self.assertEqual(len(rendered), len(combos), f"month={month}")

    def test_month_heads_differ(self):
        heads = [next(i for i, c in CARDS.items() if c["month"] == m)
                 for m in range(1, 13)]
        self.assertEqual(len({render_hanafuda(i) for i in heads}), 12)

    def test_tanzaku_strip_colors(self):
        r, g, b = card_pixel(render_hanafuda(by_tag("redtan")), 0.125, 0.30)
        self.assertGreater(r, 150)          # 赤短は赤
        self.assertGreater(r, g + 50)
        r, g, b = card_pixel(render_hanafuda(by_tag("bluetan")), 0.125, 0.30)
        self.assertGreater(b, r + 30)       # 青短は青紫
        plain = next(i for i, c in CARDS.items()
                     if c["kind"] == "tanzaku" and c["tag"] is None)
        r, g, b = card_pixel(render_hanafuda(plain), 0.125, 0.30)
        self.assertGreater(min(r, g, b), 180)   # 無地は生成り
        self.assertLess(max(r, g, b) - min(r, g, b), 50)

    def test_hikari_red_band(self):
        for tag in ("crane", "moon", "phoenix"):
            r, g, b = card_pixel(render_hanafuda(by_tag(tag)), 0.5, 0.04)
            self.assertGreater(r, 150, tag)
            self.assertGreater(r, g + 50, tag)

    def test_kasu_is_paler_than_tanzaku(self):
        def mean_saturation(data):
            img = png(data).convert("RGB")
            w, h = board_image.hanafuda_size(88)
            face = img.crop((PAD, PAD, PAD + w, PAD + h)).resize((22, 35))
            px = list(face.getdata())
            return sum(max(p) - min(p) for p in px) / len(px)

        ume_tanzaku = next(i for i, c in CARDS.items()
                           if c["month"] == 2 and c["kind"] == "tanzaku")
        ume_kasu = next(i for i, c in CARDS.items()
                        if c["month"] == 2 and c["kind"] == "kasu")
        self.assertLess(mean_saturation(render_hanafuda(ume_kasu)),
                        mean_saturation(render_hanafuda(ume_tanzaku)))


class HanafudaComposeTest(unittest.TestCase):
    def test_hand_render_and_highlight(self):
        hand = list(range(8))
        plain = render_hanafuda_hand(hand, title="あなたの手札")
        self.assertEqual(plain, render_hanafuda_hand(hand, title="あなたの手札"))
        highlighted = render_hanafuda_hand(hand, highlight={0, 3})
        self.assertNotEqual(plain, highlighted)
        one = render_hanafuda_hand([0])
        expected = max(120, board_image.hanafuda_size(88)[0] + PAD * 2)
        self.assertEqual(png(one).width, expected)
        self.assertGreater(len(render_hanafuda_hand([])), 0)

    def test_rows_render_and_wrap(self):
        rows = [("場の札", list(range(8))), ("あいて のカス（3枚）", [10, 11, 46])]
        data = render_hanafuda_rows(rows)
        self.assertEqual(data, render_hanafuda_rows(rows))
        self.assertEqual(png(data).width, 1024)
        self.assertGreater(len(render_hanafuda_rows([("場の札", [])])), 0)
        single = render_hanafuda_rows([("カス（3枚）", [2, 6, 10])])
        wrapped = render_hanafuda_rows([("カス（24枚）", list(range(20, 44)))])
        self.assertGreater(png(wrapped).height, png(single).height)


class _Member:
    def __init__(self, name):
        self.display_name = name
        self.mention = f"@{name}"


def _members():
    return {111: _Member("あなた"), 222: _Member("あいて")}


class KoikoiImageIntegrationTest(unittest.TestCase):
    def test_public_rows_exclude_hands(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        rows = koikoi_cog.public_board_rows(match, _members())
        shown = {c for _, cards in rows for c in cards}
        public = set(match.field) | set(match.captured[111]) | set(match.captured[222])
        self.assertEqual(shown, public)
        hands = set(match.hands[111]) | set(match.hands[222])
        self.assertFalse(shown & hands)
        # 構造担保: 行構成の実装が手札を参照していないこと
        self.assertNotIn(".hands", inspect.getsource(koikoi_cog.public_board_rows))

    def test_public_rows_grouped_by_kind(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        match.captured[111] = [0, 4, 1, 22, 2]  # 光・種・短冊・カス・カス
        rows = dict(koikoi_cog.public_board_rows(match, _members()))
        self.assertEqual(rows["あなた の光（1枚）"], [0])
        self.assertEqual(rows["あなた の種（1枚）"], [4])
        self.assertEqual(rows["あなた の短冊（1枚）"], [1])
        self.assertEqual(rows["あなた のカス（2枚）"], [2, 22])  # 月順

    def test_board_file_none_without_public_cards(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        match.field = []
        match.captured = {111: [], 222: []}
        self.assertIsNone(koikoi_cog.public_board_file(match, _members()))

    def test_board_file_is_png(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        f = koikoi_cog.public_board_file(match, _members())
        self.assertEqual(f.filename, koikoi_cog.BOARD_IMAGE_NAME)
        self.assertEqual(png(f.fp.read()).format, "PNG")

    def test_hand_image_depends_only_on_hand_and_field_months(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        pid = match.current
        hand = list(match.hands[pid])
        months = {CARDS[c]["month"] for c in match.field}
        base = koikoi_cog.hand_image_data(hand, months)
        self.assertEqual(base, koikoi_cog.hand_image_data(list(hand), set(months)))
        other = hand[1:] + [next(i for i in range(48) if i not in hand)]
        self.assertNotEqual(base, koikoi_cog.hand_image_data(other, months))
        # ハイライトは場の月に依存する（手札の先頭と合う月だけ渡すと絵が変わる）
        match_month = {CARDS[hand[0]]["month"]}
        self.assertNotEqual(koikoi_cog.hand_image_data(hand, set()),
                            koikoi_cog.hand_image_data(hand, match_month))

    def test_hand_file_is_png(self):
        match = KoikoiMatch([111, 222], rng=random.Random(3))
        f = koikoi_cog.hand_file(match, match.current)
        self.assertEqual(f.filename, koikoi_cog.HAND_IMAGE_NAME)
        self.assertEqual(png(f.fp.read()).format, "PNG")


if __name__ == "__main__":
    unittest.main()
