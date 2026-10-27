"""Tests for exact-match custom replies."""
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
from core.server_assist.features import customreplies
from tests.fake_kv_supabase import FakeKVSupabase


class FakeChannel:
    def __init__(self):
        self.send = AsyncMock()


class FakeMessage:
    def __init__(self, content="こんにちは", *, bot=False):
        self.content = content
        self.guild = types.SimpleNamespace(id=1)
        self.author = types.SimpleNamespace(id=2, bot=bot)
        self.channel = FakeChannel()
        self.reply = AsyncMock()


class CustomReplySettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        customreplies.reset_cache()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("customreplies", keys)

    def test_defaults(self):
        self.assertEqual(customreplies.settings(1), {"enabled": False, "replies": []})

    def test_match_is_trimmed_and_case_insensitive(self):
        replies = [{"id": "a", "trigger": "Hello", "response": "hi"}]
        self.assertEqual(customreplies.match_reply(replies, "  hello  ")["id"], "a")
        self.assertIsNone(customreplies.match_reply(replies, "hello!"))
        self.assertIsNone(customreplies.match_reply(replies, "/hello"))

    async def test_settings_deduplicates_legacy_trigger_conflicts(self):
        await self.store.update(1, customreplies.KEY, replies=[
            {"id": "a", "trigger": " Hello ", "response": "first"},
            {"id": "b", "trigger": "hello", "response": "second"},
        ])
        replies = customreplies.settings(1)["replies"]
        self.assertEqual([item["id"] for item in replies], ["a"])

    async def test_on_message_replies(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[{"id": "a", "trigger": "おはよう", "response": "おはよう！"}],
        )
        message = FakeMessage("おはよう")
        await customreplies.on_message(None, message)
        message.reply.assert_awaited_once()

    async def test_disabled_bot_and_commands_are_ignored(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[{"id": "a", "trigger": "ping", "response": "pong"}],
        )
        for message in (FakeMessage("ping", bot=True), FakeMessage("/ping"), FakeMessage("!ping")):
            await customreplies.on_message(None, message)
            message.reply.assert_not_awaited()

    async def test_cooldown_blocks_immediate_repeat(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[{"id": "a", "trigger": "ping", "response": "pong"}],
        )
        first = FakeMessage("ping")
        second = FakeMessage("ping")
        await customreplies.on_message(None, first)
        await customreplies.on_message(None, second)
        first.reply.assert_awaited_once()
        second.reply.assert_not_awaited()

    async def test_modal_adds_reply(self):
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None))
        view = customreplies.build_view(cog, 1)
        modal = customreplies.CustomReplyModal(view)
        modal.trigger_input._value = "ping"
        modal.response_input._value = "pong"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
        )
        await modal.on_submit(interaction)
        replies = customreplies.settings(1)["replies"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["trigger"], "ping")

    async def test_modal_rejects_duplicate_trigger(self):
        await customreplies.update_settings(
            1, customreplies.KEY,
            replies=[{"id": "a", "trigger": "ping", "response": "pong"}],
        )
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None))
        view = customreplies.build_view(cog, 1)
        modal = customreplies.CustomReplyModal(view)
        modal.trigger_input._value = " PING "
        modal.response_input._value = "another response"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
        )
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual(len(customreplies.settings(1)["replies"]), 1)

    def test_settings_view_controls(self):
        view = customreplies.build_view(types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None)), 1)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("返信を追加", labels)
        self.assertIn("編集", labels)
        self.assertIn("削除", labels)
        self.assertIn("カスタム返信", labels)
        self.assertIn("サーバーアシストへ戻る", labels)

    async def test_concurrent_adds_are_both_kept(self):
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None))
        stale_view = customreplies.build_view(cog, 1)
        await customreplies.update_settings(
            1, customreplies.KEY,
            replies=[{"id": "a", "trigger": "a", "response": "A"}],
        )
        modal = customreplies.CustomReplyModal(stale_view)
        modal.trigger_input._value = "b"
        modal.response_input._value = "B"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
        )
        await modal.on_submit(interaction)
        triggers = {reply["trigger"] for reply in customreplies.settings(1)["replies"]}
        self.assertEqual(triggers, {"a", "b"})

    async def test_stale_delete_keeps_other_new_reply(self):
        await customreplies.update_settings(
            1, customreplies.KEY,
            replies=[{"id": "a", "trigger": "a", "response": "A"}],
        )
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None))
        stale_view = customreplies.build_view(cog, 1)
        stale_view.selected_id = "a"
        await customreplies.update_settings(
            1, customreplies.KEY,
            replies=[
                {"id": "a", "trigger": "a", "response": "A"},
                {"id": "b", "trigger": "b", "response": "B"},
            ],
        )
        button = next(item for item in stale_view.children if getattr(item, "label", None) == "削除")
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
        )
        await button.callback(interaction)
        triggers = {reply["trigger"] for reply in customreplies.settings(1)["replies"]}
        self.assertEqual(triggers, {"b"})

    async def test_stale_edit_does_not_revive_deleted_reply(self):
        await customreplies.update_settings(
            1, customreplies.KEY,
            replies=[{"id": "a", "trigger": "a", "response": "A"}],
        )
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: None))
        stale_view = customreplies.build_view(cog, 1)
        await customreplies.update_settings(1, customreplies.KEY, replies=[])
        modal = customreplies.CustomReplyModal(stale_view, stale_view.settings["replies"][0])
        modal.response_input._value = "changed"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
        )
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual(customreplies.settings(1)["replies"], [])


if __name__ == "__main__":
    unittest.main()
