# -*- coding: utf-8 -*-
"""共通リーダーボード画像基盤（core/leaderboard_image.py）と各ボード適用の検証。

- レンダラ: 白基調・所定サイズ・アバター欠落耐性・セクション・カンマ区切り
- 適用先: ゲーム月次/個別ランキング（ranking_board/monthly_board）、
  即抜けRTA の画像送信、PublicShareView の画像つき公開
"""
import io
import types
import unittest
from unittest.mock import AsyncMock

from PIL import Image

from core import leaderboard_image as lb


def make_rows(n=5):
    return [lb.BoardRow(user_id=100 + i, name=f"ユーザー{i}",
                        value=f"{(n - i) * 100:,} AGO",
                        sub="内訳" if i == 0 else "",
                        bar=(1.0 - i * 0.15) if i % 2 == 0 else None)
            for i in range(n)]


class RenderTest(unittest.TestCase):
    def test_white_background_and_width(self):
        png = lb.render_leaderboard_png(
            title="テストランキング", sections=[(None, make_rows())],
            accent=(217, 164, 32), cache_namespace="test-white")
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.width, lb.BOARD_W)
        corner = img.getpixel((2, 2))
        self.assertTrue(all(c >= 240 for c in corner), corner)

    def test_height_formula_single_section(self):
        rows = make_rows(12)
        png = lb.render_leaderboard_png(
            title="t", sections=[(None, rows)], accent=(1, 2, 3),
            podium=False, cache_namespace="test-height")
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.height, lb.HEADER_H + 12 * lb.ROW_H + 16)

    def test_podium_height(self):
        png = lb.render_leaderboard_png(
            title="t", sections=[(None, make_rows(3))], accent=(1, 2, 3),
            cache_namespace="test-podium")
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.height,
                         lb.HEADER_H + lb.PODIUM_H + lb.ROW_H + 16)

    def test_missing_and_broken_avatars(self):
        rows = make_rows(3)
        png = lb.render_leaderboard_png(
            title="t", sections=[(None, rows)], accent=(1, 2, 3),
            avatars={100: b"not-an-image", 101: None},
            cache_namespace="test-avatars")
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_empty_rows(self):
        png = lb.render_leaderboard_png(
            title="t", sections=[(None, [])], accent=(1, 2, 3),
            empty_text="まだ記録がありません。", cache_namespace="test-empty")
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.width, lb.BOARD_W)

    def test_two_sections(self):
        png = lb.render_leaderboard_png(
            title="t", accent=(1, 2, 3), cache_namespace="test-sections",
            sections=[(None, make_rows(4)), ("レート上位", make_rows(2))])
        img = Image.open(io.BytesIO(png))
        expected = (lb.HEADER_H + lb.PODIUM_H + 1 * lb.ROW_H
                    + lb.SECTION_H + 2 * lb.ROW_H + 16)
        self.assertEqual(img.height, expected)

    def test_highlight_user(self):
        png = lb.render_leaderboard_png(
            title="t", sections=[(None, make_rows())], accent=(1, 2, 3),
            highlight_user_id=102, cache_namespace="test-highlight")
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_fmt_int_uses_commas(self):
        self.assertEqual(lb.fmt_int(38000), "38,000")
        self.assertEqual(lb.fmt_int(0), "0")
        self.assertEqual(lb.fmt_int(1234567), "1,234,567")


class GameBoardTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from core.game.game import party_ranking
        self.party_ranking = party_ranking
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)

    async def asyncTearDown(self):
        self.party_ranking._shared = self.saved

    async def test_monthly_board_empty(self):
        import core.game.game.cog as game
        embed, png = await game.monthly_board(1, bot=None)
        self.assertIsNone(png)
        self.assertIn("まだ記録がありません", embed.description)

    async def test_monthly_board_with_rows(self):
        import core.game.game.cog as game
        await self.party_ranking.shared().record_win(1, 7, "ngword")
        await self.party_ranking.shared().record_win(1, 8, "ngword")
        embed, png = await game.monthly_board(1, bot=None)
        self.assertIsNotNone(png)
        self.assertEqual(embed.image.url, "attachment://game_king.png")


class SokunukeBoardTest(unittest.IsolatedAsyncioTestCase):
    async def test_leaderboard_sends_image(self):
        import core.game.sokunuke_rta.cog as module
        from core.game.sokunuke_rta.cog import SokuNukeRta

        class FakeStore:
            def __init__(self, value):
                self.value = value

            async def ensure_loaded(self):
                return None

            def get(self, guild_id, section):
                return self.value

        store = FakeStore({"records": [{"user_id": "2", "elapsed": 1.5},
                                       {"user_id": "3", "elapsed": 2.5}]})
        old = module.guild_settings.get_store
        module.guild_settings.get_store = lambda: store
        self.addCleanup(setattr, module.guild_settings, "get_store", old)

        followup = types.SimpleNamespace(send=AsyncMock())
        interaction = types.SimpleNamespace(
            guild_id=1, user=types.SimpleNamespace(id=2), followup=followup)
        await SokuNukeRta(types.SimpleNamespace()).leaderboard(interaction)
        kwargs = followup.send.await_args.kwargs
        self.assertIn("file", kwargs)
        self.assertEqual(kwargs["embed"].image.url,
                         "attachment://sokunuke_leaderboard.png")
        self.assertFalse(kwargs["allowed_mentions"].users)


class PublicShareFileTest(unittest.IsolatedAsyncioTestCase):
    async def test_share_sends_file_when_factory_given(self):
        import discord
        from core.support.public_share import PublicShareView

        sent = {}

        class FakeChannel:
            async def send(self, **kwargs):
                sent.update(kwargs)

        view = PublicShareView(
            1, discord.Embed(title="x"),
            file_factory=lambda: discord.File(io.BytesIO(b"png"),
                                              filename="b.png"))
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(id=1), channel=FakeChannel(),
            response=types.SimpleNamespace(send_message=AsyncMock()))
        await view.share.callback(interaction)
        self.assertIn("file", sent)
        self.assertEqual(sent["file"].filename, "b.png")


if __name__ == "__main__":
    unittest.main()
