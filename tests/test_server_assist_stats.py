"""Tests for server stat voice-channel counters."""
from __future__ import annotations

import asyncio
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
from core.server_assist.features import stats
from tests.fake_kv_supabase import FakeKVSupabase


class FakeMember:
    def __init__(self, status=discord.Status.online, *, bot=False):
        self.status = status
        self.bot = bot


class FakeVoiceChannel:
    def __init__(self, channel_id, name):
        self.id = channel_id
        self.name = name
        self.edit = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(manage_channels=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.members = [
            FakeMember(discord.Status.online),
            FakeMember(discord.Status.idle),
            FakeMember(discord.Status.offline),
            FakeMember(discord.Status.online, bot=True),
        ]
        self.member_count = 4
        self.premium_subscription_count = 2
        self.member = FakeVoiceChannel(30, "メンバー: 0")
        self.online = FakeVoiceChannel(31, "オンライン: 0")
        self.boost = FakeVoiceChannel(32, "ブースト: 0")
        self.voice_channels = [self.member, self.online, self.boost]
        self.channels = {channel.id: channel for channel in self.voice_channels}

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)


class StatsSettingsTest(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn("stats", keys)

    def test_defaults(self):
        self.assertEqual(
            stats.settings(1),
            {
                "enabled": False,
                "member_channel_id": None,
                "online_channel_id": None,
                "boost_channel_id": None,
            },
        )

    async def test_update_stats_renames_channels(self):
        await stats.update_settings(
            1, stats.KEY,
            enabled=True,
            member_channel_id=30,
            online_channel_id=31,
            boost_channel_id=32,
        )
        guild = FakeGuild()
        await stats.update_stats(guild, stats.settings(1))
        self.assertEqual(guild.member.edit.await_args.kwargs["name"], "メンバー: 4")
        self.assertEqual(guild.online.edit.await_args.kwargs["name"], "オンライン: 2")
        self.assertEqual(guild.boost.edit.await_args.kwargs["name"], "ブースト: 2")

    async def test_disabled_does_nothing(self):
        await stats.update_settings(1, stats.KEY, enabled=False, member_channel_id=30)
        guild = FakeGuild()
        await stats.update_stats(guild, stats.settings(1))
        guild.member.edit.assert_not_awaited()

    async def test_existing_name_is_not_edited(self):
        await stats.update_settings(1, stats.KEY, enabled=True, member_channel_id=30)
        guild = FakeGuild()
        guild.member.name = "メンバー: 4"
        await stats.update_stats(guild, stats.settings(1))
        guild.member.edit.assert_not_awaited()

    def test_start_tasks_tracks_task(self):
        async def run():
            cog = types.SimpleNamespace(
                bot=types.SimpleNamespace(guilds=[], wait_until_ready=AsyncMock()),
                _feature_tasks=[],
            )
            stats.start_tasks(cog)
            self.assertEqual(len(cog._feature_tasks), 1)
            for task in cog._feature_tasks:
                task.cancel()
            await asyncio.sleep(0)
        asyncio.run(run())

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = stats.build_view(cog, guild.id)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 3)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("サーバースタッツ", labels)
        self.assertIn("今すぐ更新", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
