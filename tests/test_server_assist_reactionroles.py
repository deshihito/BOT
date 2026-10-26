"""Tests for reaction roles."""
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
from core.server_assist.features import reactionroles
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id=10, name="role", *, position=10, managed=False):
        self.id = role_id
        self.name = name
        self.mention = f"<@&{role_id}>"
        self.position = position
        self.managed = managed

    def __ge__(self, other):
        return self.position >= getattr(other, "position", 0)


class FakeMember:
    def __init__(self, member_id=1, *, bot=False):
        self.id = member_id
        self.bot = bot
        self.roles = []
        self.add_roles = AsyncMock()
        self.remove_roles = AsyncMock()


class FakeMessage:
    def __init__(self, message_id=50):
        self.id = message_id
        self.reactions = []
        self.add_reaction = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=10, name="roles"):
        self.id = channel_id
        self.name = name
        self.message = FakeMessage()
        self.fetch_message = AsyncMock(return_value=self.message)

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(top_role=FakeRole(999, position=999))
        self.role = FakeRole(10)
        self.high_role = FakeRole(20, position=1000)
        self.member = FakeMember(1)
        self.channel = FakeChannel()
        self.channels = {self.channel.id: self.channel}

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    def get_role(self, role_id):
        return self.role if role_id == self.role.id else self.high_role if role_id == self.high_role.id else None

    def get_member(self, user_id):
        return self.member if user_id == self.member.id else FakeMember(user_id)


class ReactionRoleSettingsTest(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn("reactionroles", keys)

    def test_defaults(self):
        self.assertEqual(
            reactionroles.settings(1),
            {"enabled": False, "channel_id": None, "message_id": None, "mappings": {}},
        )

    def test_parse_mappings(self):
        self.assertEqual(reactionroles.parse_mappings("🎮=10\n📚=20"), {"🎮": 10, "📚": 20})
        with self.assertRaises(ValueError):
            reactionroles.parse_mappings("bad")

    async def test_reaction_add_and_remove(self):
        await reactionroles.update_settings(
            1, reactionroles.KEY,
            enabled=True, channel_id=10, message_id=50, mappings={"🎮": 10},
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=1, emoji="🎮",
        )
        await reactionroles.on_raw_reaction_add(cog, payload)
        member = guild.get_member(1)
        member.add_roles.assert_awaited_once()
        await reactionroles.on_raw_reaction_remove(cog, payload)
        member.remove_roles.assert_awaited_once()

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=1, emoji="🎮",
        )
        await reactionroles.on_raw_reaction_add(cog, payload)
        guild.get_member(1).add_roles.assert_not_awaited()

    async def test_wrong_message_or_emoji_is_ignored(self):
        await reactionroles.update_settings(
            1, reactionroles.KEY,
            enabled=True, channel_id=10, message_id=50, mappings={"🎮": 10},
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        for message_id, emoji in ((51, "🎮"), (50, "📚")):
            payload = types.SimpleNamespace(
                guild_id=1, channel_id=10, message_id=message_id, user_id=1, emoji=emoji,
            )
            await reactionroles.on_raw_reaction_add(cog, payload)
        guild.get_member(1).add_roles.assert_not_awaited()

    async def test_high_role_is_ignored(self):
        await reactionroles.update_settings(
            1, reactionroles.KEY,
            enabled=True, channel_id=10, message_id=50, mappings={"🎮": 20},
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=1, emoji="🎮",
        )
        await reactionroles.on_raw_reaction_add(cog, payload)
        guild.get_member(1).add_roles.assert_not_awaited()

    async def test_apply_reactions(self):
        await reactionroles.update_settings(
            1, reactionroles.KEY,
            enabled=True, channel_id=10, message_id=50, mappings={"🎮": 10, "📚": 20},
        )
        guild = FakeGuild()
        current = reactionroles.settings(1)
        added = await reactionroles.apply_reactions(guild, current)
        self.assertEqual(added, 2)
        self.assertEqual(guild.channel.message.add_reaction.await_count, 2)

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = reactionroles.build_view(cog, guild.id)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("対象メッセージ", labels)
        self.assertIn("絵文字とロール", labels)
        self.assertIn("リアクションを反映", labels)
        self.assertIn("リアクションロール", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
