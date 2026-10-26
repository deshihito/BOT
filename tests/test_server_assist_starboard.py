"""Tests for the Starboard server-assist feature."""
from __future__ import annotations

import asyncio
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
from core.server_assist.features import starboard
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, *, bot=False):
        self.id = user_id
        self.bot = bot
        self.display_name = "投稿者"
        self.name = "poster"
        self.display_avatar = types.SimpleNamespace(url="https://example.com/avatar.png")


class FakeReaction:
    def __init__(self, emoji="⭐", count=1, users=None):
        self.emoji = emoji
        self.count = count
        self._users = list(users or [FakeUser(user_id) for user_id in range(2, 2 + count)])

    async def users(self):
        for user in self._users:
            yield user


class FakeMessage:
    def __init__(self, message_id=50, *, author=None, content="こんにちは", count=0, channel=None):
        self.id = message_id
        self.author = author or FakeUser()
        self.content = content
        self.reactions = [FakeReaction(count=count)] if count else []
        self.attachments = []
        self.created_at = datetime.now(timezone.utc)
        self.jump_url = f"https://discord.com/channels/1/{getattr(channel, 'id', 10)}/{message_id}"
        self.channel = channel
        self.edit = AsyncMock()
        self.delete = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id, name, *, board_message=None):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.message = board_message
        self.send = AsyncMock(return_value=board_message)
        self.fetch_message = AsyncMock(return_value=board_message)

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.source = FakeChannel(10, "一般")
        self.board = FakeChannel(20, "starboard", board_message=FakeMessage(900))
        self.channels = {10: self.source, 20: self.board}
        self.text_channels = [self.source, self.board]

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)


class FakeBot:
    def __init__(self, guild):
        self.guild = guild

    def get_guild(self, guild_id):
        return self.guild if guild_id == self.guild.id else None

    def get_channel(self, channel_id):
        return self.guild.get_channel(channel_id)


class StarboardSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        starboard.reset_cache()
        starboard._entries = KVStore(
            "server_assist_starboard",
            client=self.db,
            path=os.path.join(self.tmp.name, "starboard.json"),
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("starboard", keys)

    def test_defaults(self):
        self.assertEqual(
            starboard.settings(1),
            {
                "enabled": False,
                "channel_id": None,
                "emoji": "⭐",
                "threshold": 3,
                "allow_self": False,
            },
        )

    async def test_threshold_is_clamped(self):
        await starboard.update_settings(1, starboard.KEY, threshold=99)
        self.assertEqual(starboard.settings(1)["threshold"], 10)
        await starboard.update_settings(1, starboard.KEY, threshold=0)
        self.assertEqual(starboard.settings(1)["threshold"], 1)

    def make_cog(self):
        guild = FakeGuild()
        return types.SimpleNamespace(bot=FakeBot(guild)), guild

    async def test_below_threshold_does_not_post(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=3)
        cog, guild = self.make_cog()
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=1, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=2, channel=guild.source)
        await starboard.on_raw_reaction_add(cog, payload)
        guild.board.send.assert_not_awaited()

    async def test_threshold_posts_to_starboard(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=3)
        cog, guild = self.make_cog()
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=2, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=3, channel=guild.source)
        await starboard.on_raw_reaction_add(cog, payload)
        guild.board.send.assert_awaited_once()
        entry = (await starboard._entries_cache())["1:50"]
        self.assertEqual(entry["board_id"], 900)
        self.assertEqual(entry["count"], 3)

    async def test_next_reaction_edits_existing_board(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=3)
        cog, guild = self.make_cog()
        board = FakeMessage(900, channel=guild.board, content="転載")
        guild.board.board_message = board
        guild.board.fetch_message.return_value = board
        await starboard._put_entry(1, 50, {"board_id": 900, "channel_id": 20, "count": 3})
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=2, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=4, channel=guild.source)
        await starboard.on_raw_reaction_add(cog, payload)
        board.edit.assert_awaited_once()

    async def test_concurrent_reactions_create_one_board_post(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=3)
        cog, guild = self.make_cog()
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=2, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=3, channel=guild.source)
        board = FakeMessage(900, channel=guild.board)
        guild.board.fetch_message.return_value = board
        await asyncio.gather(
            starboard.on_raw_reaction_add(cog, payload),
            starboard.on_raw_reaction_add(cog, payload),
        )
        guild.board.send.assert_awaited_once()
        board.edit.assert_awaited_once()

    async def test_removing_below_threshold_deletes_board(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=3)
        cog, guild = self.make_cog()
        board = FakeMessage(900, channel=guild.board)
        guild.board.fetch_message.return_value = board
        await starboard._put_entry(1, 50, {"board_id": 900, "channel_id": 20, "count": 3})
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=2, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=2, channel=guild.source)
        await starboard.on_raw_reaction_remove(cog, payload)
        board.delete.assert_awaited_once()
        self.assertNotIn("1:50", await starboard._entries_cache())

    async def test_self_reaction_is_ignored(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=1)
        cog, guild = self.make_cog()
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=1, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(count=1, channel=guild.source)
        await starboard.on_raw_reaction_add(cog, payload)
        guild.board.send.assert_not_awaited()

    async def test_bot_message_is_ignored(self):
        await starboard.update_settings(1, starboard.KEY, enabled=True, channel_id=20, threshold=1)
        cog, guild = self.make_cog()
        payload = types.SimpleNamespace(
            guild_id=1, channel_id=10, message_id=50, user_id=2, emoji="⭐",
        )
        guild.source.fetch_message.return_value = FakeMessage(
            count=1, channel=guild.source, author=FakeUser(bot=True),
        )
        await starboard.on_raw_reaction_add(cog, payload)
        guild.board.send.assert_not_awaited()

    async def test_message_delete_removes_board_post(self):
        cog, guild = self.make_cog()
        board = FakeMessage(900, channel=guild.board)
        guild.board.fetch_message.return_value = board
        await starboard._put_entry(1, 50, {"board_id": 900, "channel_id": 20, "count": 3})
        payload = types.SimpleNamespace(guild_id=1, message_id=50)
        await starboard.on_raw_message_delete(cog, payload)
        board.delete.assert_awaited_once()
        self.assertNotIn("1:50", await starboard._entries_cache())

    def test_settings_view_controls(self):
        cog, guild = self.make_cog()
        view = starboard.build_view(cog, guild.id)
        selects = [item for item in view.children if isinstance(item, discord.ui.Select)]
        buttons = [item for item in view.children if isinstance(item, discord.ui.Button)]
        self.assertEqual(len(selects), 3)
        labels = {item.label for item in buttons}
        self.assertIn("Starboard", labels)
        self.assertIn("自己リアクション", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
