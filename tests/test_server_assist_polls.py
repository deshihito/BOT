"""Tests for the poll server-assist feature."""
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
from core.server_assist.features import polls
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
    def __init__(self, channel_id=100, name="投票"):
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


def entry(**overrides):
    data = {
        "guild_id": 1, "channel_id": 100, "author_id": 1, "author_name": "あおい",
        "question": "何がいい？", "options": ["ラーメン", "カレー"], "votes": [[], []],
        "multiple": False, "status": "open",
    }
    data.update(overrides)
    return data


class PollTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        polls.reset_cache()
        polls._entries = KVStore(
            "server_assist_polls",
            client=self.db,
            path=os.path.join(self.tmp.name, "polls.json"),
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("polls", keys)

    def test_defaults(self):
        self.assertEqual(
            polls.settings(1),
            {"enabled": False, "channel_id": None, "multiple": False},
        )

    def test_build_embed_shows_counts_and_state(self):
        embed = polls.build_embed(entry(votes=[[1, 2], [3]]))
        self.assertEqual(embed.title, "投票")
        self.assertTrue(embed.fields[0].value.startswith("2票"))
        self.assertTrue(embed.fields[1].value.startswith("1票"))
        self.assertIn("受付中", embed.footer.text)
        self.assertIn("1つ選択", embed.footer.text)
        closed = polls.build_embed(entry(status="closed"))
        self.assertIn("締め切り", closed.footer.text)

    async def test_modal_posts_and_stores_poll(self):
        await polls.update_settings(1, polls.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = polls.PollCreateModal(cog, 1)
        modal.question_input._value = "何がいい？"
        modal.options_input._value = "ラーメン\nカレー"
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        guild.channel.send.assert_awaited_once()
        interaction.response.defer.assert_awaited_once()
        saved = (await polls._cache_data())["500"]
        self.assertEqual(saved["question"], "何がいい？")
        self.assertEqual(saved["options"], ["ラーメン", "カレー"])
        self.assertEqual(saved["votes"], [[], []])
        self.assertFalse(saved["multiple"])

    async def test_modal_requires_two_distinct_options(self):
        await polls.update_settings(1, polls.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = polls.PollCreateModal(cog, 1)
        modal.question_input._value = "何がいい？"
        modal.options_input._value = "ラーメン\nラーメン"
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        guild.channel.send.assert_not_awaited()

    async def test_single_vote_toggles_and_moves(self):
        await polls._put_entry(500, entry())
        user = FakeUser(2)
        interaction = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500),
            user=user,
            data={"values": ["0"]},
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_vote(None, interaction, ["0"])
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[2], []])
        await polls.handle_vote(None, interaction, ["0"])
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[], []])
        await polls.handle_vote(None, interaction, ["1"])
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[], [2]])

    async def test_multiple_vote_replaces_selection(self):
        await polls._put_entry(500, entry(options=["A", "B", "C"], votes=[[], [], []], multiple=True))
        interaction = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500),
            user=FakeUser(2),
            data={"values": ["0", "2"]},
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_vote(None, interaction, ["0", "2"])
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[2], [], [2]])
        await polls.handle_vote(None, interaction, ["2"])
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[], [], [2]])

    async def test_concurrent_votes_are_not_lost(self):
        await polls._put_entry(500, entry())
        responses = []
        for user_id in (2, 3):
            interaction = types.SimpleNamespace(
                message=types.SimpleNamespace(id=500),
                user=FakeUser(user_id),
                data={"values": ["0"]},
                response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
            )
            responses.append(polls.handle_vote(None, interaction, ["0"]))
        await asyncio.gather(*responses)
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[2, 3], []])

    async def test_closed_poll_rejects_vote(self):
        await polls._put_entry(500, entry(status="closed"))
        interaction = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500),
            user=FakeUser(2),
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_vote(None, interaction, ["0"])
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual((await polls._cache_data())["500"]["votes"], [[], []])

    async def test_close_allowed_for_author_or_manager_only(self):
        await polls._put_entry(500, entry())
        author = types.SimpleNamespace(
            message=types.SimpleNamespace(id=500), user=FakeUser(1),
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_close(None, author)
        self.assertEqual((await polls._cache_data())["500"]["status"], "closed")

        await polls._put_entry(501, entry())
        stranger = types.SimpleNamespace(
            message=types.SimpleNamespace(id=501), user=FakeUser(2),
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_close(None, stranger)
        stranger.response.send_message.assert_awaited_once()
        self.assertEqual((await polls._cache_data())["501"]["status"], "open")

        manager = FakeUser(3)
        manager.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=True)
        moderator = types.SimpleNamespace(
            message=types.SimpleNamespace(id=501), user=manager,
            response=types.SimpleNamespace(edit_message=AsyncMock(), send_message=AsyncMock()),
        )
        await polls.handle_close(None, moderator)
        self.assertEqual((await polls._cache_data())["501"]["status"], "closed")

    async def test_settings_view_controls_and_panel_send(self):
        await polls.update_settings(1, polls.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = polls.build_view(cog, 1)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("投票", labels)
        self.assertIn("複数選択: オフ", labels)
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
        polls.register_views(cog)
        self.assertEqual(add_view.call_count, 2)


if __name__ == "__main__":
    unittest.main()

