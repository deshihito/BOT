"""Tests for the AutoMod server-assist feature."""
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

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import automod
from tests.fake_kv_supabase import FakeKVSupabase


class FakeMember:
    def __init__(self, member_id=1, *, bot=False, administrator=False, manage_messages=False):
        self.id = member_id
        self.mention = f"<@{member_id}>"
        self.bot = bot
        self.guild_permissions = types.SimpleNamespace(
            administrator=administrator, manage_messages=manage_messages,
        )
        self.timeout = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=10, name="一般"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True, manage_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(
            id=999,
            guild_permissions=types.SimpleNamespace(moderate_members=True),
        )
        self.channel = FakeChannel(10)
        self.log = FakeChannel(20, "mod-log")
        self.text_channels = [self.channel, self.log]

    def get_channel(self, channel_id):
        return self.log if channel_id == self.log.id else self.channel


class FakeMessage:
    def __init__(self, guild, content="hello", mentions=(), author=None):
        self.id = 50
        self.guild = guild
        self.channel = guild.channel
        self.author = author or FakeMember()
        self.content = content
        self.mentions = list(mentions)
        self.delete = AsyncMock()


class AutoModSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("automod", keys)

    def test_defaults(self):
        self.assertEqual(
            automod.settings(1),
            {
                "enabled": False,
                "log_channel_id": None,
                "block_invites": False,
                "block_links": False,
                "max_mentions": 5,
                "caps_percent": 70,
                "timeout_minutes": 0,
            },
        )

    def test_detects_invite_link(self):
        current = {"block_invites": True, "block_links": False, "max_mentions": 0, "caps_percent": 0}
        self.assertEqual(automod.detect_violation("discord.gg/abcd", 0, current), "招待リンク")

    def test_detects_link_only_when_enabled(self):
        current = {"block_invites": False, "block_links": True, "max_mentions": 0, "caps_percent": 0}
        self.assertEqual(automod.detect_violation("https://example.com", 0, current), "外部リンク")
        current["block_links"] = False
        self.assertIsNone(automod.detect_violation("https://example.com", 0, current))

    def test_detects_mentions(self):
        current = {"block_invites": False, "block_links": False, "max_mentions": 3, "caps_percent": 0}
        self.assertIn("メンション", automod.detect_violation("hello", 3, current))

    def test_detects_caps(self):
        current = {"block_invites": False, "block_links": False, "max_mentions": 0, "caps_percent": 70}
        self.assertIn("大文字", automod.detect_violation("THIS IS ALL CAPS", 0, current))
        self.assertIsNone(automod.detect_violation("this is normal", 0, current))

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        message = FakeMessage(guild, "discord.gg/abcd")
        await automod.on_message(None, message)
        message.delete.assert_not_awaited()

    async def test_admin_is_exempt(self):
        await automod.update_settings(1, automod.KEY, enabled=True, block_invites=True)
        guild = FakeGuild()
        message = FakeMessage(guild, "discord.gg/abcd", author=FakeMember(administrator=True))
        await automod.on_message(None, message)
        message.delete.assert_not_awaited()

    async def test_bot_is_exempt(self):
        await automod.update_settings(1, automod.KEY, enabled=True, block_invites=True)
        guild = FakeGuild()
        message = FakeMessage(guild, "discord.gg/abcd", author=FakeMember(bot=True))
        await automod.on_message(None, message)
        message.delete.assert_not_awaited()

    async def test_deletes_and_logs(self):
        await automod.update_settings(
            1, automod.KEY, enabled=True, block_invites=True, log_channel_id=20,
        )
        guild = FakeGuild()
        message = FakeMessage(guild, "discord.gg/abcd")
        await automod.on_message(None, message)
        message.delete.assert_awaited_once()
        guild.log.send.assert_awaited_once()

    async def test_timeout_is_applied(self):
        await automod.update_settings(
            1, automod.KEY, enabled=True, block_links=True, timeout_minutes=5,
        )
        guild = FakeGuild()
        message = FakeMessage(guild, "https://example.com")
        await automod.on_message(None, message)
        message.author.timeout.assert_awaited_once()

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = automod.build_view(cog, guild.id)
        selects = [item for item in view.children if isinstance(item, discord.ui.Select)]
        buttons = [item for item in view.children if isinstance(item, discord.ui.Button)]
        self.assertEqual(len(selects), 4)
        labels = {item.label for item in buttons}
        self.assertIn("AutoMod", labels)
        self.assertIn("招待リンク", labels)
        self.assertIn("外部リンク", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
