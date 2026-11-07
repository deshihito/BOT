"""Tests for the welcome image card (feature gap #1)."""
from __future__ import annotations

import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist.features import welcome
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


class WelcomeCardFontTest(unittest.TestCase):
    """フォント候補の実在と、日本語カバレッジで選ばれることの回帰テスト。

    以前は候補の先頭2件 (assets/fonts/levelup.ttf/.otf) が実在せず、
    OS 日本語フォントの無い環境 (Pi) では日本語が全て □ になっていた。
    """

    def setUp(self):
        self._orig_candidates = welcome._FONT_CANDIDATES
        self.addCleanup(self._restore_font_state)

    def _restore_font_state(self):
        welcome._FONT_CANDIDATES = self._orig_candidates
        welcome._CARD_FONT_PATH = False

    def _bundled_only(self):
        welcome._FONT_CANDIDATES = tuple(
            c for c in welcome._FONT_CANDIDATES if c.startswith(str(welcome._REPO_ROOT))
        )
        welcome._CARD_FONT_PATH = False

    def test_bundled_candidates_exist(self):
        bundled = [
            c for c in welcome._FONT_CANDIDATES if c.startswith(str(welcome._REPO_ROOT))
        ]
        self.assertTrue(bundled)
        for path in bundled:
            self.assertTrue(Path(path).is_file(), path)

    def test_first_candidate_covers_japanese(self):
        self.assertTrue(welcome._font_covers_japanese(welcome._FONT_CANDIDATES[0]))

    def test_pick_skips_font_without_japanese(self):
        fonts_dir = welcome._REPO_ROOT / "assets" / "fonts"
        latin_only = str(fonts_dir / "Exo2-Regular.ttf")  # 同梱だが日本語なし
        self.assertTrue(Path(latin_only).is_file())
        self.assertFalse(welcome._font_covers_japanese(latin_only))
        welcome._FONT_CANDIDATES = (
            str(fonts_dir / "no-such-font.ttf"),
            latin_only,
            str(fonts_dir / "MPLUSRounded1c-Regular.ttf"),
        )
        welcome._CARD_FONT_PATH = False
        picked = welcome._pick_card_font_path()
        self.assertEqual(picked, str(fonts_dir / "MPLUSRounded1c-Regular.ttf"))

    def test_pi_like_environment_renders_japanese_glyphs(self):
        # Pi 相当: OS フォント候補を外し、同梱フォントだけで描く。
        self._bundled_only()
        picked = welcome._pick_card_font_path()
        self.assertIsNotNone(picked)
        self.assertTrue(str(picked).startswith(str(welcome._REPO_ROOT)))
        self.assertTrue(welcome._font_covers_japanese(picked))
        font = welcome._card_font(40)
        from PIL import Image, ImageDraw

        def glyph(ch: str) -> bytes:
            img = Image.new("L", (64, 64), 0)
            ImageDraw.Draw(img).text((6, 6), ch, font=font, fill=255)
            return img.tobytes()

        # □ (notdef) なら全文字が同一ビットマップになる。
        self.assertNotEqual(glyph("で"), glyph("し"))
        self.assertNotEqual(glyph("で"), glyph("漢"))

    def test_pi_like_card_image_differs_by_japanese_name(self):
        self._bundled_only()
        from PIL import Image

        def name_band(png: bytes) -> bytes:
            img = Image.open(io.BytesIO(png)).convert("RGB")
            return img.crop((300, 140, 990, 225)).tobytes()

        card_a = welcome.render_welcome_card(None, "でし", "テストサーバー", 157)
        card_b = welcome.render_welcome_card(None, "あい", "テストサーバー", 157)
        band_a, band_b = name_band(card_a), name_band(card_b)
        differing = sum(1 for x, y in zip(band_a, band_b) if x != y)
        # 豆腐なら名前帯はほぼ同一 (枠線だけ) になる。実グリフなら大きく違う。
        self.assertGreater(differing, 500)


def _app_command_channel(channel_id: int = 100):
    from discord.app_commands.models import AppCommandChannel

    return AppCommandChannel(
        state=MagicMock(),
        data={"id": channel_id, "type": 0, "name": "ch", "permissions": "0"},
        guild_id=1,
    )


class WelcomeChannelSelectTest(unittest.IsolatedAsyncioTestCase):
    """チャンネル選択コールバックの回帰テスト。

    以前は values (AppCommandChannel) に permissions_for を直接呼んでいて
    AttributeError になり、送信先チャンネルを一切保存できなかった。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def _view(self, guild):
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        return welcome.WelcomeSettingsView(cog, guild.id)

    def _interaction(self, guild):
        interaction = MagicMock()
        interaction.user.guild_permissions.administrator = True
        interaction.user.guild_permissions.manage_guild = True
        interaction.guild = guild
        interaction.response.send_message = AsyncMock()
        interaction.response.is_done = lambda: True
        interaction.edit_original_response = AsyncMock()
        return interaction

    def _select(self, view, kind):
        return next(
            item for item in view.children
            if isinstance(item, welcome.WelcomeChannelSelect) and item.kind == kind
        )

    async def test_select_saves_welcome_channel(self):
        guild = FakeGuild()
        view = self._view(guild)
        select = self._select(view, "welcome")
        select._values = [_app_command_channel(100)]
        interaction = self._interaction(guild)
        await select.callback(interaction)
        self.assertEqual(welcome.settings(1)["welcome_channel_id"], 100)
        interaction.response.send_message.assert_not_awaited()
        interaction.edit_original_response.assert_awaited()

    async def test_select_saves_goodbye_channel(self):
        guild = FakeGuild()
        view = self._view(guild)
        select = self._select(view, "goodbye")
        select._values = [_app_command_channel(100)]
        await select.callback(self._interaction(guild))
        self.assertEqual(welcome.settings(1)["goodbye_channel_id"], 100)

    async def test_select_without_send_permission_is_rejected(self):
        guild = FakeGuild()
        denied = FakeChannel()
        denied.permissions_for = lambda _me: types.SimpleNamespace(send_messages=False)
        guild.get_channel = lambda channel_id: denied if channel_id == denied.id else None
        view = self._view(guild)
        select = self._select(view, "welcome")
        select._values = [_app_command_channel(100)]
        interaction = self._interaction(guild)
        await select.callback(interaction)
        self.assertIsNone(welcome.settings(1)["welcome_channel_id"])
        interaction.response.send_message.assert_awaited_once()
        self.assertIn("送信できません", interaction.response.send_message.await_args.args[0])

    async def test_select_clear_welcome_channel(self):
        await welcome.update_settings(1, welcome.KEY, welcome_channel_id=100)
        guild = FakeGuild()
        view = self._view(guild)
        select = self._select(view, "welcome")
        select._values = []
        await select.callback(self._interaction(guild))
        self.assertIsNone(welcome.settings(1)["welcome_channel_id"])


class WelcomeSendLoggingTest(unittest.IsolatedAsyncioTestCase):
    """送信できないときに黙って終わらず、理由がログに残ること。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    async def test_missing_channel_logs_warning(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_enabled=True, welcome_channel_id=555,
        )
        guild = FakeGuild()  # get_channel(555) -> None
        with self.assertLogs(welcome.logger, level="WARNING") as logs:
            await welcome.on_member_join(None, FakeMember(guild))
        self.assertTrue(any("見つかりません" in line for line in logs.output))
        guild.channel.send.assert_not_awaited()

    async def test_no_send_permission_logs_warning(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_enabled=True, welcome_channel_id=100,
        )
        guild = FakeGuild()
        guild.channel.permissions_for = lambda _me: types.SimpleNamespace(send_messages=False)
        with self.assertLogs(welcome.logger, level="WARNING") as logs:
            await welcome.on_member_join(None, FakeMember(guild))
        self.assertTrue(any("送信権限がありません" in line for line in logs.output))
        guild.channel.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
