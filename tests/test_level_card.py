"""Tests for the /level glass card, semantic colors, and the new commands."""
from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from PIL import Image

from core.general.exp import levelup_card
from core.general.exp.level_card import CARD_H, CARD_W, render_level_card_png
from core.support import colors
from core.support.storage import KVStore
from tests.fake_kv_supabase import FakeKVSupabase


def _render(theme="default", **overrides):
    kwargs = dict(
        user_id=42, name="サンプルユーザー", avatar_bytes=None,
        chat_exp=1250, vc_exp=480, server_rank=12, global_rank=340,
        theme=theme,
    )
    kwargs.update(overrides)
    return render_level_card_png(**kwargs)


class SemanticColorsTest(unittest.TestCase):
    def test_semantic_color_values(self):
        # discord.js Colors と同じ値（成功=緑 / エラー=赤 / 警告=黄）。
        self.assertEqual(colors.SUCCESS, 0x57F287)
        self.assertEqual(colors.ERROR, 0xED4245)
        self.assertEqual(colors.WARNING, 0xFEE75C)


class LevelCardRenderTest(unittest.TestCase):
    def test_render_is_png_with_card_size(self):
        png = _render()
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(Image.open(io.BytesIO(png)).size, (CARD_W, CARD_H))

    def test_theme_changes_output(self):
        self.assertNotEqual(_render("default"), _render("midnight"))
        self.assertNotEqual(_render("default"), _render("sakura"))

    def test_unknown_theme_matches_default(self):
        self.assertEqual(_render("bogus"), _render("default"))

    def test_no_rank_and_zero_exp_render(self):
        png = _render(chat_exp=0, vc_exp=0, server_rank=None, global_rank=None)
        self.assertTrue(png.startswith(b"\x89PNG"))


class LevelCommandsTest(unittest.TestCase):
    def test_general_cog_registers_level_commands(self):
        from discord import app_commands

        from core.general.entry import GeneralCog

        for attr, name in (("level", "level"), ("level_settings", "level_settings")):
            cmd = getattr(GeneralCog, attr)
            self.assertIsInstance(cmd, app_commands.Command)
            self.assertEqual(cmd.name, name)


class LevelSettingsViewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = KVStore(
            "levelup_card_prefs", client=FakeKVSupabase(),
            path=os.path.join(self.tmp.name, "bot_kv.json"),
        )
        levelup_card.set_store_for_tests(self.store)
        self.addCleanup(levelup_card.set_store_for_tests, KVStore("levelup_card_prefs"))

    async def test_view_reflects_saved_theme_and_embed_color(self):
        from core.general.exp.exp_ui import LevelSettingsView

        await levelup_card.set_theme(7, "ocean")
        view = LevelSettingsView(7, None, bot=None)
        self.assertEqual(view.theme, "ocean")
        embed = view.embed()
        self.assertEqual(embed.color.value, colors.SUCCESS)
        self.assertIn("オーシャン", embed.description)

    async def test_view_defaults_to_default_theme(self):
        from core.general.exp.exp_ui import LevelCardView

        view = LevelCardView(8, None, bot=None)
        self.assertEqual(view.theme, "default")
        self.assertEqual(view.embed().color.value, colors.SUCCESS)


if __name__ == "__main__":
    unittest.main()
