"""Tests for server activity logs."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import serverlog
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id=10, name="メンバー", guild=None):
        self.id = role_id
        self.name = name
        self.mention = f"<@&{role_id}>"
        self.guild = guild

    def is_default(self):
        return False


class FakeMember:
    def __init__(self, guild, member_id=1):
        self.guild = guild
        self.id = member_id
        self.mention = f"<@{member_id}>"
        self.created_at = datetime.now(timezone.utc)
        self.joined_at = datetime.now(timezone.utc)
        self.roles = [FakeRole(guild=guild)]


class FakeChannel:
    def __init__(self, channel_id=10, name="一般", guild=None):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.guild = guild
        self.type = "text"
        self.send = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel(10, "一般", self)
        self.log = FakeChannel(20, "server-log", self)
        self.text_channels = [self.channel, self.log]

    def get_channel(self, channel_id):
        return self.log if channel_id == self.log.id else self.channel


class FakeMessage:
    def __init__(self, guild, content="hello"):
        self.guild = guild
        self.channel = guild.channel
        self.author = types.SimpleNamespace(id=1, mention="<@1>")
        self.content = content
        self.attachments = []


class ServerLogSettingsTest(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn("serverlog", keys)

    def test_defaults(self):
        self.assertEqual(
            serverlog.settings(1),
            {
                "enabled": False,
                "channel_id": None,
                "log_joins": True,
                "log_leaves": True,
                "log_message_delete": True,
                "log_roles": True,
                "log_channels": True,
            },
        )

    async def test_join_logs(self):
        await serverlog.update_settings(1, serverlog.KEY, enabled=True, channel_id=20)
        guild = FakeGuild()
        await serverlog.on_member_join(None, FakeMember(guild))
        guild.log.send.assert_awaited_once()

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        await serverlog.on_member_join(None, FakeMember(guild))
        guild.log.send.assert_not_awaited()

    async def test_message_delete_logs(self):
        await serverlog.update_settings(1, serverlog.KEY, enabled=True, channel_id=20)
        guild = FakeGuild()
        await serverlog.on_message_delete(None, FakeMessage(guild, "消えるメッセージ"))
        guild.log.send.assert_awaited_once()

    async def test_role_create_and_delete_log(self):
        await serverlog.update_settings(1, serverlog.KEY, enabled=True, channel_id=20)
        guild = FakeGuild()
        role = FakeRole(guild=guild)
        await serverlog.on_guild_role_create(None, role)
        await serverlog.on_guild_role_delete(None, role)
        self.assertEqual(guild.log.send.await_count, 2)

    async def test_channel_create_and_delete_log(self):
        await serverlog.update_settings(1, serverlog.KEY, enabled=True, channel_id=20)
        guild = FakeGuild()
        channel = FakeChannel(30, "new", guild)
        await serverlog.on_guild_channel_create(None, channel)
        await serverlog.on_guild_channel_delete(None, channel)
        self.assertEqual(guild.log.send.await_count, 2)

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = serverlog.build_view(cog, guild.id)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("サーバーログ", labels)
        self.assertIn("参加", labels)
        self.assertIn("退出", labels)
        self.assertIn("削除", labels)
        self.assertIn("ロール", labels)
        self.assertIn("チャンネル", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
