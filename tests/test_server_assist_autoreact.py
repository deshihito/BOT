"""Tests for the auto-reaction server-assist feature."""
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
from core.server_assist.features import autoreact
from cogs.server_assist import ServerAssistCog
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, bot=False):
        self.id = user_id
        self.bot = bot
        self.display_name = "あおい"
        self.name = "あおい"
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=True)


class FakeChannel:
    def __init__(self, channel_id=100, name="雑談", add_reactions=True, read_message_history=True):
        self.id = channel_id
        self.name = name
        self.add_reactions = add_reactions
        self.read_message_history = read_message_history

    def permissions_for(self, member):
        return types.SimpleNamespace(
            send_messages=True,
            add_reactions=self.add_reactions,
            read_message_history=self.read_message_history,
        )


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]


class FakeMessage:
    def __init__(self, guild, channel=None, author=None, message_id=500):
        self.id = message_id
        self.guild = guild
        self.channel = channel or guild.channel
        self.author = author or FakeUser()
        self.content = "こんにちは"
        self.add_reaction = AsyncMock()


class AutoReactTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        autoreact.reset_state()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("autoreact", keys)

    def test_defaults(self):
        self.assertEqual(
            autoreact.settings(1),
            {"enabled": False, "channel_id": None, "emojis": []},
        )

    def test_parse_emojis(self):
        self.assertEqual(autoreact.parse_emojis("👍, 🎉\n🔥、👍"), ["👍", "🎉", "🔥"])
        self.assertEqual(len(autoreact.parse_emojis(",".join(str(i) for i in range(20)))), 10)

    async def test_message_gets_each_reaction(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍", "🎉"],
        )
        message = FakeMessage(FakeGuild())
        await autoreact.on_message(None, message)
        await autoreact.drain()
        self.assertEqual(message.add_reaction.await_count, 2)
        message.add_reaction.assert_any_await("👍")
        message.add_reaction.assert_any_await("🎉")

    async def test_bot_message_is_ignored(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        message = FakeMessage(FakeGuild(), author=FakeUser(bot=True))
        await autoreact.on_message(None, message)
        await autoreact.drain()
        message.add_reaction.assert_not_awaited()

    async def test_other_channel_and_disabled_are_ignored(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        other = FakeMessage(FakeGuild(), channel=FakeChannel(200, "別"))
        await autoreact.on_message(None, other)
        await autoreact.drain()
        other.add_reaction.assert_not_awaited()

        await autoreact.update_settings(1, autoreact.KEY, enabled=False)
        disabled = FakeMessage(FakeGuild())
        await autoreact.on_message(None, disabled)
        await autoreact.drain()
        disabled.add_reaction.assert_not_awaited()

    async def test_failure_is_logged_not_raised(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        message = FakeMessage(FakeGuild())
        message.add_reaction.side_effect = RuntimeError("boom")
        with self.assertLogs("core.server_assist.features.autoreact", level="ERROR"):
            await autoreact.on_message(None, message)
            await autoreact.drain()

    async def test_same_message_is_only_processed_once(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        message = FakeMessage(FakeGuild())
        await autoreact.on_message(None, message)
        await autoreact.on_message(None, message)
        await autoreact.drain()
        message.add_reaction.assert_awaited_once()

    async def test_missing_permissions_skip_reactions(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        guild = FakeGuild()
        guild.channel = FakeChannel(add_reactions=False, read_message_history=False)
        guild.text_channels = [guild.channel]
        message = FakeMessage(guild)
        await autoreact.on_message(None, message)
        await autoreact.drain()
        message.add_reaction.assert_not_awaited()

    async def test_modal_saves_emojis(self):
        modal = autoreact.AutoReactEmojiModal(1)
        modal.emoji_input._value = "👍, 🎉"
        interaction = types.SimpleNamespace(
            guild=FakeGuild(), guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await modal.on_submit(interaction)
        self.assertEqual(autoreact.settings(1)["emojis"], ["👍", "🎉"])
        interaction.response.send_message.assert_awaited_once()

    async def test_settings_view_controls(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = autoreact.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children
                 if isinstance(item, (discord.ui.Select, discord.ui.ChannelSelect))]),
            1,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("リアクションを設定", labels)
        self.assertIn("自動リアクション", labels)
        emoji_button = next(item for item in view.children if getattr(item, "label", None) == "リアクションを設定")
        interaction = types.SimpleNamespace(
            user=FakeUser(),
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await emoji_button.callback(interaction)
        interaction.response.send_modal.assert_awaited_once()

    async def test_pending_task_cap_and_shutdown(self):
        self.addCleanup(setattr, autoreact, "MAX_TASKS", 100)
        autoreact.MAX_TASKS = 1
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        gate = asyncio.Event()

        async def slow(emoji):
            await gate.wait()

        first = FakeMessage(FakeGuild(), message_id=1)
        first.add_reaction = AsyncMock(side_effect=slow)
        second = FakeMessage(FakeGuild(), message_id=2)
        await autoreact.on_message(None, first)
        await asyncio.sleep(0)
        await autoreact.on_message(None, second)
        self.assertEqual(first.add_reaction.await_count, 1)
        second.add_reaction.assert_not_awaited()
        await autoreact.shutdown()
        self.assertFalse(autoreact._tasks)

    async def test_cog_unload_cancels_reaction_tasks(self):
        await autoreact.update_settings(
            1, autoreact.KEY, enabled=True, channel_id=100, emojis=["👍"],
        )
        gate = asyncio.Event()

        async def slow(emoji):
            await gate.wait()

        message = FakeMessage(FakeGuild())
        message.add_reaction = AsyncMock(side_effect=slow)
        await autoreact.on_message(None, message)
        await asyncio.sleep(0)
        self.assertTrue(autoreact._tasks)
        cog = ServerAssistCog(types.SimpleNamespace())
        cog.modules = {"autoreact": autoreact}
        await cog.cog_unload()
        self.assertFalse(autoreact._tasks)


if __name__ == "__main__":
    unittest.main()

