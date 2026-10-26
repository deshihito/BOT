"""Tests for the suggestion box server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import suggestions
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, name="あおい"):
        self.id = user_id
        self.display_name = name
        self.name = name
        self.display_avatar = types.SimpleNamespace(url="https://example.com/avatar.png")


class FakeMessage:
    def __init__(self, message_id=500):
        self.id = message_id
        self.edit = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=100, name="提案"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.message = FakeMessage()
        self.send = AsyncMock(return_value=self.message)

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テストサーバー"
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class SuggestionSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        suggestions.reset_cache()
        suggestions._entries = KVStore(
            "server_assist_suggestions",
            client=self.db,
            path=os.path.join(self.tmp.name, "suggestions.json"),
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("suggestions", keys)

    def test_defaults(self):
        self.assertEqual(suggestions.settings(1), {"enabled": False, "channel_id": None})

    def test_build_embed_has_vote_counts(self):
        entry = {
            "title": "イベント案",
            "body": "新しいイベントがほしい",
            "author_name": "あおい",
            "up": [1, 2],
            "down": [3],
            "status": "受付中",
        }
        embed = suggestions.build_embed(entry)
        self.assertEqual(embed.title, "イベント案")
        self.assertEqual(embed.fields[0].value, "2")
        self.assertEqual(embed.fields[1].value, "1")
        self.assertEqual(embed.fields[2].value, "受付中")

    async def test_create_modal_posts_and_stores(self):
        await suggestions.update_settings(1, suggestions.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = suggestions.SuggestionCreateModal(cog, 1, 100)
        modal.title_input._value = "イベント案"
        modal.body_input._value = "新しいイベントがほしい"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await modal.on_submit(interaction)
        guild.channel.send.assert_awaited_once()
        entry = (await suggestions._entries_cache())["500"]
        self.assertEqual(entry["title"], "イベント案")
        self.assertEqual(entry["author_id"], 1)
        interaction.response.send_message.assert_awaited_once()

    async def test_vote_toggles_up_and_down(self):
        await suggestions._put_entry(500, {
            "guild_id": 1, "channel_id": 100, "author_id": 1, "author_name": "あおい",
            "title": "案", "body": "本文", "up": [], "down": [], "status": "受付中",
        })
        cog = types.SimpleNamespace()
        interaction = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500),
            user=FakeUser(2),
            response=types.SimpleNamespace(edit_message=AsyncMock()),
        )
        await suggestions.handle_vote(cog, interaction, "up")
        entry = (await suggestions._entries_cache())["500"]
        self.assertEqual(entry["up"], [2])
        await suggestions.handle_vote(cog, interaction, "down")
        entry = (await suggestions._entries_cache())["500"]
        self.assertEqual(entry["up"], [])
        self.assertEqual(entry["down"], [2])

    async def test_vote_cap_reports_error(self):
        await suggestions._put_entry(500, {
            "guild_id": 1, "channel_id": 100, "author_id": 1, "author_name": "あおい",
            "title": "案", "body": "本文", "up": list(range(500)), "down": [], "status": "受付中",
        })
        cog = types.SimpleNamespace()
        interaction = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500),
            user=FakeUser(999),
            response=types.SimpleNamespace(
                edit_message=AsyncMock(), send_message=AsyncMock(),
            ),
        )
        await suggestions.handle_vote(cog, interaction, "up")
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual(len((await suggestions._entries_cache())["500"]["up"]), 500)

    async def test_settings_view_controls_and_panel_send(self):
        await suggestions.update_settings(1, suggestions.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = suggestions.build_view(cog, 1)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("提案箱", labels)
        self.assertIn("パネルを送信", labels)
        self.assertIn("サーバーアシストへ戻る", labels)
        panel_button = next(item for item in view.children if getattr(item, "label", None) == "パネルを送信")
        interaction = types.SimpleNamespace(
            guild=guild,
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await panel_button.callback(interaction)
        guild.channel.send.assert_awaited_once()

    def test_register_views(self):
        add_view = MagicMock()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(add_view=add_view))
        suggestions.register_views(cog)
        self.assertEqual(add_view.call_count, 2)


if __name__ == "__main__":
    unittest.main()
