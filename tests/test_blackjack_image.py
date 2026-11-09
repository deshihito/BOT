"""ブラックジャック盤面画像（core/game/gambling/blackjack_image.py と
GamblingCog 側の盤面表示）のテスト。

見るもの: 値モデルと一致する合計表示、伏せ札の情報マスク（隠れた
ディーラーカードが画像へ一切影響しないこと）、スート割り当ての
安定性、精算表示、そして描画失敗時にテキスト表示へフォールバック
してゲームが止まらないこと。
"""
from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image

from core.game.gambling import blackjack_image
from core.game.gambling.gambling import calc_total


class RankAndSuitTest(unittest.TestCase):
    def test_rank_labels_follow_value_model(self):
        self.assertEqual(blackjack_image.card_rank_label(1), "A")
        self.assertEqual(blackjack_image.card_rank_label(2), "2")
        self.assertEqual(blackjack_image.card_rank_label(10), "10")

    def test_suit_is_stable_under_append(self):
        # 手札は末尾追加のみ。既存カードのスートが再描画で変わらないこと。
        hand = [7, 2, 10]
        before = [blackjack_image.card_suit(v, i) for i, v in enumerate(hand)]
        after = [blackjack_image.card_suit(v, i)
                 for i, v in enumerate(hand + [4, 1])]
        self.assertEqual(before, after[:len(before)])
        for suit in after:
            self.assertIn(suit, ("spade", "heart", "diamond", "club"))


class TotalConsistencyTest(unittest.TestCase):
    def test_player_badge_matches_calc_total(self):
        hands = ([1, 10], [10, 10, 1], [5, 6], [2, 3, 4, 5, 6],
                 [11, 10, 5], [1, 1, 1, 8])
        for hand in hands:
            self.assertEqual(
                blackjack_image.player_badge_text(list(hand)),
                str(calc_total(list(hand))), f"hand={hand}")

    def test_dealer_badge_open_matches_calc_total(self):
        for hand in ([5, 9], [10, 7], [1, 10, 5]):
            self.assertEqual(
                blackjack_image.dealer_badge_text(list(hand),
                                                  dealer_hidden=False),
                str(calc_total(list(hand))))

    def test_dealer_badge_hidden_shows_visible_only(self):
        # 現行テキスト表示と同じ: 先頭1枚分だけ + ?
        self.assertEqual(
            blackjack_image.dealer_badge_text([5, 9], dealer_hidden=True),
            "5 + ?")
        self.assertEqual(blackjack_image.dealer_visible_total([10, 3]), 10)
        self.assertEqual(blackjack_image.dealer_visible_total([]), 0)


class DeltaFormatTest(unittest.TestCase):
    def test_format_delta(self):
        self.assertEqual(blackjack_image.format_delta(1000), "+1,000 AGO")
        self.assertEqual(blackjack_image.format_delta(-700), "-700 AGO")
        self.assertEqual(blackjack_image.format_delta(0), "±0 AGO")


def _render(**overrides):
    kwargs = dict(
        player_hand=[7, 10], dealer_hand=[5, 9], dealer_hidden=True,
        bet=700, player_name="テスト", user_id=123, avatar_bytes=None,
        outcome=None, delta=None)
    kwargs.update(overrides)
    return blackjack_image.render_blackjack_png(**kwargs)


class RenderTest(unittest.TestCase):
    def test_png_shape(self):
        png = _render()
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.size, (blackjack_image.BOARD_W,
                                    blackjack_image.BOARD_H))

    def test_hidden_hole_card_never_leaks(self):
        # 伏せ札の値だけが違う2枚の盤面はバイト単位で同一でなければならない。
        base = _render(dealer_hand=[5, 9])
        other_hole = _render(dealer_hand=[5, 3])
        extra_cards = _render(dealer_hand=[5, 3, 10, 10])
        self.assertEqual(base, other_hole)
        self.assertEqual(base, extra_cards)

    def test_revealed_hole_card_changes_image(self):
        hidden = _render(dealer_hand=[5, 9], dealer_hidden=True)
        open_ = _render(dealer_hand=[5, 9], dealer_hidden=False)
        self.assertNotEqual(hidden, open_)

    def test_outcomes_render(self):
        for outcome, delta in (("win", 700), ("lose", -700),
                               ("push", 0), ("bust", -700)):
            png = _render(dealer_hidden=False, outcome=outcome, delta=delta)
            self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"), outcome)

    def test_many_cards_fit(self):
        png = _render(player_hand=[2, 2, 3, 2, 4, 2, 1, 3],
                      dealer_hand=[10, 7], dealer_hidden=False)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))


# ---------------------------------------------------------------------------
# Cog 側: 盤面の供給とフォールバック
# ---------------------------------------------------------------------------

class _FakeStore:
    def __init__(self, session=None):
        self._session = session

    def session(self, user_id):
        return self._session


class _FakeCog:
    bot = None

    def __init__(self, session=None, final=None):
        self.store = _FakeStore(session)
        self._final = final

    def blackjack_final_state(self, user_id):
        return self._final


def _session(player=(7, 10), dealer=(5, 9), bet=700):
    return {"kind": "blackjack", "bet": bet,
            "player": list(player), "dealer": list(dealer)}


class BlackjackViewBoardTest(unittest.TestCase):
    def _view(self, cog):
        from core.game.gambling.cog import BlackjackView
        return BlackjackView(cog, 123)

    def test_board_supplied_during_session(self):
        view = self._view(_FakeCog(session=_session()))
        files = view.panel_files()
        self.assertIsNotNone(files)
        self.assertEqual(files[0].filename, blackjack_image.FILENAME)
        embed = view._build_embed(None)
        self.assertEqual(embed.image.url,
                         f"attachment://{blackjack_image.FILENAME}")

    def test_board_state_never_passes_hole_card(self):
        view = self._view(_FakeCog(session=_session(dealer=(5, 9))))
        state = view._board_state()
        self.assertEqual(state["dealer"], [5])
        self.assertTrue(state["dealer_hidden"])

    def test_final_board_after_stand(self):
        final = {"player": [7, 10], "dealer": [5, 9, 6], "bet": 700,
                 "outcome": "lose", "delta": -700}
        view = self._view(_FakeCog(session=None, final=final))
        state = view._board_state()
        self.assertEqual(state["dealer"], [5, 9, 6])
        self.assertFalse(state["dealer_hidden"])
        self.assertIsNotNone(view.panel_files())

    def test_final_board_after_bust_keeps_dealer_hidden(self):
        final = {"player": [10, 9, 5], "dealer": None, "dealer_first": 8,
                 "bet": 700, "outcome": "bust", "delta": -700}
        view = self._view(_FakeCog(session=None, final=final))
        state = view._board_state()
        self.assertEqual(state["dealer"], [8])
        self.assertTrue(state["dealer_hidden"])
        self.assertEqual(state["outcome"], "bust")

    def test_no_board_without_session_or_final(self):
        view = self._view(_FakeCog(session=None, final=None))
        self.assertIsNone(view.panel_files())
        embed = view._build_embed(None)
        self.assertIsNone(embed.image.url)

    def test_render_failure_falls_back_to_text(self):
        from core.game.gambling import cog as gambling_cog
        view = self._view(_FakeCog(session=_session()))
        original = gambling_cog.blackjack_image.render_blackjack_png

        def _boom(**kwargs):
            raise RuntimeError("render failed")

        gambling_cog.blackjack_image.render_blackjack_png = _boom
        try:
            # 例外が伝播せず、添付なし＝従来のテキスト embed に落ちる。
            self.assertIsNone(view.panel_files())
            embed = view._build_embed(None)
            self.assertIsNone(embed.image.url)
            field_names = [f.name for f in embed.fields]
            self.assertIn("あなたの手札", field_names)
            self.assertIn("ディーラー", field_names)
        finally:
            gambling_cog.blackjack_image.render_blackjack_png = original


if __name__ == "__main__":
    unittest.main()
