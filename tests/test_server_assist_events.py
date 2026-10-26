"""Tests for the event RSVP server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import events
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, name="あおい"):
        self.id = user_id
        self.display_name = name
        self.name = name
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=False)


class FakeMessage:
    def __init__(self, message_id=500):
        self.id = message_id
        self.edit = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=100, name="イベント"):
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
        self.member = FakeUser(2, "参加者")

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None

    def get_member(self, user_id):
        return self.member if user_id == self.member.id else None


def entry(**overrides):
    data = {
        "id": "ev-1", "guild_id": 1, "channel_id": 100, "author_id": 1,
        "author_name": "あおい", "title": "雑談会", "description": "集まりましょう",
        "when_text": "10月30日 20:00", "location": "VC雑談",
        "yes": [], "no": [], "maybe": [], "status": "open",
    }
    data.update(overrides)
    return data


class EventTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        events.reset_cache()
        events._entries = KVStore(
            "server_assist_events",
            client=self.db,
            path=os.path.join(self.tmp.name, "events.json"),
        )
        events.CREATE_COOLDOWN = 0.0
        events.RSVP_COOLDOWN = 0.0
        events.REFRESH_COOLDOWN = 0.0

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("events", keys)

    def test_defaults(self):
        self.assertEqual(events.settings(1), {"enabled": False, "channel_id": None})

    def test_build_embed_counts(self):
        embed = events.build_embed(entry(yes=[2, 3], no=[4], maybe=[5]))
        self.assertEqual(embed.title, "雑談会")
        self.assertIn("10月30日 20:00", embed.description)
        self.assertEqual(embed.fields[0].value, "2")
        self.assertEqual(embed.fields[1].value, "1")
        self.assertEqual(embed.fields[2].value, "1")

    async def test_modal_posts_and_stores(self):
        await events.update_settings(1, events.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = events.EventCreateModal(cog, 1)
        modal.title_input._value = "雑談会"
        modal.description_input._value = "集まりましょう"
        modal.when_input._value = "10月30日 20:00"
        modal.location_input._value = "VC雑談"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        guild.channel.send.assert_awaited_once()
        saved = (await events._cache_data())["500"]
        self.assertEqual(saved["title"], "雑談会")
        self.assertEqual(saved["yes"], [])

    async def test_rsvp_toggles_and_moves(self):
        await events._put_entry(500, entry())
        interaction = types.SimpleNamespace(
            message=FakeMessage(500), user=FakeUser(2),
            response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await events.handle_rsvp(None, interaction, "yes")
        self.assertEqual((await events._cache_data())["500"]["yes"], [2])
        await events.handle_rsvp(None, interaction, "yes")
        self.assertEqual((await events._cache_data())["500"]["yes"], [])
        await events.handle_rsvp(None, interaction, "maybe")
        self.assertEqual((await events._cache_data())["500"]["maybe"], [2])

    async def test_concurrent_rsvps_are_not_lost(self):
        await events._put_entry(500, entry())
        tasks = []
        for user_id in (2, 3):
            interaction = types.SimpleNamespace(
                message=FakeMessage(500), user=FakeUser(user_id),
                response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )
            tasks.append(events.handle_rsvp(None, interaction, "yes"))
        await asyncio.gather(*tasks)
        self.assertEqual((await events._cache_data())["500"]["yes"], [2, 3])

    async def test_closed_event_rejects_rsvp(self):
        await events._put_entry(500, entry(status="closed"))
        interaction = types.SimpleNamespace(
            message=FakeMessage(500), user=FakeUser(2),
            response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await events.handle_rsvp(None, interaction, "yes")
        interaction.followup.send.assert_awaited_once()
        self.assertEqual((await events._cache_data())["500"]["yes"], [])

    async def test_close_permission_and_display_repair(self):
        await events._put_entry(500, entry())
        stranger = types.SimpleNamespace(
            message=FakeMessage(500), user=FakeUser(2),
            response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await events.handle_close(None, stranger)
        stranger.followup.send.assert_awaited_once()
        self.assertEqual((await events._cache_data())["500"]["status"], "open")

        message = FakeMessage(500)
        message.edit = AsyncMock(side_effect=[RuntimeError("boom"), None])
        author = types.SimpleNamespace(
            message=message, user=FakeUser(1),
            response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await events.handle_close(None, author)
        self.assertEqual((await events._cache_data())["500"]["status"], "closed")
        await events.handle_close(None, author)
        self.assertEqual(message.edit.await_count, 2)

    async def test_refresh_does_not_change_answers(self):
        await events._put_entry(500, entry(yes=[2]))
        message = FakeMessage(500)
        interaction = types.SimpleNamespace(
            message=message, user=FakeUser(2),
            response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await events.handle_refresh(None, interaction)
        message.edit.assert_awaited_once()
        self.assertEqual((await events._cache_data())["500"]["yes"], [2])

    async def test_settings_view_and_panel_send(self):
        await events.update_settings(1, events.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = events.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children
                 if isinstance(item, (discord.ui.Select, discord.ui.ChannelSelect))]),
            1,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("イベント", labels)
        self.assertIn("パネルを送信", labels)
        panel = next(item for item in view.children if getattr(item, "label", None) == "パネルを送信")
        interaction = types.SimpleNamespace(
            guild=guild,
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await panel.callback(interaction)
        guild.channel.send.assert_awaited_once()
        interaction.response.defer.assert_awaited_once()
        interaction.followup.send.assert_awaited_once()

    def test_register_views(self):
        add_view = MagicMock()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(add_view=add_view))
        events.register_views(cog)
        self.assertEqual(add_view.call_count, 2)


if __name__ == "__main__":
    unittest.main()

