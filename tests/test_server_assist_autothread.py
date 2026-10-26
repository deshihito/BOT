"""Tests for the auto-thread server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
import asyncio
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import autothread
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, bot=False):
        self.id = user_id
        self.bot = bot
        self.display_name = "あおい"
        self.name = "あおい"
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=True)


class FakeChannel:
    def __init__(self, channel_id=100, name="質問", create_public_threads=True):
        self.id = channel_id
        self.name = name
        self.create_public_threads = create_public_threads

    def permissions_for(self, member):
        return types.SimpleNamespace(
            send_messages=True,
            create_public_threads=self.create_public_threads,
        )


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テストサーバー"
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]


class FakeMessage:
    def __init__(self, guild, channel=None, author=None, content="質問です", message_id=500):
        self.id = message_id
        self.guild = guild
        self.channel = channel or guild.channel
        self.author = author or FakeUser()
        self.content = content
        self.thread = None
        self.create_thread = AsyncMock()


class AutoThreadTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        autothread.reset_state()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("autothread", keys)

    def test_defaults(self):
        self.assertEqual(
            autothread.settings(1),
            {"enabled": False, "channel_id": None, "archive_minutes": 1440},
        )

    async def test_message_creates_thread(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100, archive_minutes=60)
        guild = FakeGuild()
        message = FakeMessage(guild, content="質問です\n詳しくは本文")
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_awaited_once_with(name="質問です", auto_archive_duration=60)

    async def test_empty_content_uses_fallback_name(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild(), content="")
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_awaited_once_with(name="新しいスレッド", auto_archive_duration=1440)

    async def test_bot_message_is_ignored(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild(), author=FakeUser(bot=True))
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_not_awaited()

    async def test_other_channel_is_ignored(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild(), channel=FakeChannel(200, "別チャンネル"))
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_not_awaited()

    async def test_message_with_existing_thread_is_ignored(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild())
        message.thread = types.SimpleNamespace(id=999)
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_not_awaited()

    async def test_disabled_is_ignored(self):
        message = FakeMessage(FakeGuild())
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_not_awaited()

    async def test_failure_is_logged_not_raised(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild())
        message.create_thread.side_effect = RuntimeError("boom")
        with self.assertLogs("core.server_assist.features.autothread", level="ERROR"):
            await autothread.on_message(None, message)
            await autothread.drain()

    async def test_same_message_is_only_created_once(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        message = FakeMessage(FakeGuild())
        await autothread.on_message(None, message)
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_awaited_once()

    async def test_missing_thread_permission_is_ignored(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        guild.channel = FakeChannel(create_public_threads=False)
        guild.text_channels = [guild.channel]
        message = FakeMessage(guild)
        await autothread.on_message(None, message)
        await autothread.drain()
        message.create_thread.assert_not_awaited()

    async def test_recent_ids_survive_bounded_cache(self):
        self.addCleanup(setattr, autothread, "SEEN_LIMIT", 1000)
        autothread.SEEN_LIMIT = 2
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        for message_id in (1, 2, 3):
            await autothread.on_message(None, FakeMessage(guild, message_id=message_id))
        newest = FakeMessage(guild, message_id=3)
        await autothread.on_message(None, newest)
        await autothread.drain()
        newest.create_thread.assert_not_awaited()

    async def test_pending_task_cap_and_shutdown(self):
        self.addCleanup(setattr, autothread, "MAX_PENDING_TASKS", 100)
        autothread.MAX_PENDING_TASKS = 1
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        gate = asyncio.Event()

        async def slow(**kwargs):
            await gate.wait()

        first = FakeMessage(guild, message_id=1)
        first.create_thread = AsyncMock(side_effect=slow)
        second = FakeMessage(guild, message_id=2)
        await autothread.on_message(None, first)
        await asyncio.sleep(0)
        await autothread.on_message(None, second)
        self.assertEqual(first.create_thread.await_count, 1)
        second.create_thread.assert_not_awaited()
        await autothread.shutdown()
        self.assertFalse(autothread._tasks)

    async def test_settings_view_controls_and_updates(self):
        await autothread.update_settings(1, autothread.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = autothread.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children
                 if isinstance(item, (discord.ui.Select, discord.ui.ChannelSelect))]),
            2,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("自動スレッド", labels)
        self.assertIn("サーバーアシストへ戻る", labels)

        archive = next(
            item for item in view.children
            if isinstance(item, discord.ui.Select) and item.placeholder == "スレッドの自動アーカイブ"
        )
        archive._values = ["60"]
        interaction = types.SimpleNamespace(
            user=FakeUser(),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                edit_message=AsyncMock(),
                send_message=AsyncMock(),
            ),
        )
        await archive.callback(interaction)
        self.assertEqual(autothread.settings(1)["archive_minutes"], 60)


if __name__ == "__main__":
    unittest.main()

