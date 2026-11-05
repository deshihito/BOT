"""Tests for the welcome image card (feature gap #1)."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import guild_settings
from core.storage import KVStore
from core.server_assist.features import welcome
from tests.fake_kv_supabase import FakeKVSupabase
from tests.test_server_assist import FakeChannel, FakeGuild, FakeMember


class WelcomeImageSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_image_defaults(self):
        settings = welcome.settings(1)
        self.assertFalse(settings["welcome_image_enabled"])
        self.assertEqual(settings["welcome_image_theme"], welcome.DEFAULT_CARD_THEME)

    async def test_image_settings_round_trip_and_validation(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_image_enabled=True, welcome_image_theme="dark",
        )
        settings = welcome.settings(1)
        self.assertTrue(settings["welcome_image_enabled"])
        self.assertEqual(settings["welcome_image_theme"], "dark")
        await welcome.update_settings(1, welcome.KEY, welcome_image_theme="bogus")
        self.assertEqual(welcome.settings(1)["welcome_image_theme"], welcome.DEFAULT_CARD_THEME)

    async def test_join_sends_image_when_enabled(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_enabled=True, welcome_channel_id=100,
            welcome_image_enabled=True, welcome_image_theme="blue",
        )
        guild = FakeGuild()
        member = FakeMember(guild)
        member.display_avatar = types.SimpleNamespace(
            url="https://example.com/avatar.png",
            replace=lambda **_kw: types.SimpleNamespace(read=AsyncMock(return_value=None)),
        )
        await welcome.on_member_join(None, member)
        guild.channel.send.assert_awaited_once()
        kwargs = guild.channel.send.await_args.kwargs
        self.assertIn("file", kwargs)
        self.assertEqual(kwargs["file"].filename, "welcome.png")
        self.assertEqual(kwargs["embed"].image.url, "attachment://welcome.png")

    async def test_join_without_image_sends_no_file(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_enabled=True, welcome_channel_id=100,
        )
        guild = FakeGuild()
        await welcome.on_member_join(None, FakeMember(guild))
        guild.channel.send.assert_awaited_once()
        self.assertNotIn("file", guild.channel.send.await_args.kwargs)


class WelcomeCardRenderTest(unittest.TestCase):
    def test_render_returns_png_for_each_theme(self):
        for theme in welcome.CARD_THEMES:
            png = welcome.render_welcome_card(None, "あおい", "テストサーバー", 42, theme)
            self.assertTrue(png.startswith(b"\x89PNG"), theme)
            self.assertGreater(len(png), 1000, theme)

    def test_render_unknown_theme_falls_back(self):
        png = welcome.render_welcome_card(None, "aoi", "guild", None, "bogus")
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_themes_differ(self):
        white = welcome.render_welcome_card(None, "aoi", "guild", 1, "white")
        dark = welcome.render_welcome_card(None, "aoi", "guild", 1, "dark")
        self.assertNotEqual(white, dark)


if __name__ == "__main__":
    unittest.main()
