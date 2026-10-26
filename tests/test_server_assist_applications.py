"""Tests for the staff application form."""
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
from core.server_assist.features import applications
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1, name="あおい"):
        self.id = user_id
        self.display_name = name
        self.name = name
        self.mention = f"<@{user_id}>"
        self.bot = False
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=True)
        self.send = AsyncMock()


class FakeMessage:
    def __init__(self, message_id=500):
        self.id = message_id
        self.edit = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=100, name="applications"):
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
        self.me = types.SimpleNamespace(id=999)
        self.panel = FakeChannel(100, "apply")
        self.review = FakeChannel(101, "review")
        self.text_channels = [self.panel, self.review]
        self.member = FakeUser(1)
        self.channels = {channel.id: channel for channel in self.text_channels}

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    def get_member(self, user_id):
        return self.member if user_id == self.member.id else None


class ApplicationSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        applications.reset_cache()
        applications._entries = KVStore(
            "server_assist_applications",
            client=self.db,
            path=os.path.join(self.tmp.name, "applications.json"),
        )
        applications.APPLY_COOLDOWN = 0.0

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("applications", keys)

    def test_defaults(self):
        self.assertEqual(
            applications.settings(1),
            {"enabled": False, "panel_channel_id": None, "review_channel_id": None},
        )

    async def test_modal_posts_and_stores_application(self):
        await applications.update_settings(
            1, applications.KEY, enabled=True, panel_channel_id=100, review_channel_id=101,
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = applications.ApplicationModal(cog, 1)
        modal.name_input._value = "あおい"
        modal.reason_input._value = "運営を手伝いたい"
        modal.experience_input._value = "モデレーション経験"
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        guild.review.send.assert_awaited_once()
        entry = (await applications._cache_data())["500"]
        self.assertEqual(entry["status"], "pending")
        self.assertEqual(entry["name"], "あおい")

    async def test_review_accepts_and_dms(self):
        await applications._put_entry(500, {
            "id": "app-1", "guild_id": 1, "applicant_id": 1, "applicant_name": "あおい",
            "name": "あおい", "reason": "理由", "experience": "経験",
            "status": "pending", "decided_by": None,
        })
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        interaction = types.SimpleNamespace(
            guild=guild,
            user=FakeUser(2),
            client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
            message=FakeMessage(500),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await applications.handle_review(cog, interaction, "accept")
        entry = (await applications._cache_data())["500"]
        self.assertEqual(entry["status"], "accepted")
        self.assertTrue(entry.get("notified"))
        guild.member.send.assert_awaited_once()
        self.assertEqual(interaction.message.edit.await_count, 2)

    async def test_review_requires_manage_guild(self):
        await applications._put_entry(500, {
            "id": "app-1", "applicant_id": 1, "status": "pending", "name": "a",
            "reason": "b", "experience": "c", "decided_by": None,
        })
        user = FakeUser(2)
        user.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=False)
        interaction = types.SimpleNamespace(
            guild=FakeGuild(), user=user, message=FakeMessage(500),
            response=types.SimpleNamespace(send_message=AsyncMock(), edit_message=AsyncMock()),
        )
        await applications.handle_review(None, interaction, "accept")
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual((await applications._cache_data())["500"]["status"], "pending")

    async def test_already_decided_is_rejected(self):
        await applications._put_entry(500, {
            "id": "app-1", "applicant_id": 1, "status": "accepted", "name": "a",
            "reason": "b", "experience": "c", "decided_by": 2,
        })
        interaction = types.SimpleNamespace(
            guild=FakeGuild(), user=FakeUser(2), message=FakeMessage(500),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await applications.handle_review(None, interaction, "deny")
        interaction.followup.send.assert_awaited_once()
        self.assertEqual((await applications._cache_data())["500"]["status"], "accepted")

    async def test_concurrent_reviews_only_decide_once(self):
        await applications._put_entry(500, {
            "id": "app-1", "applicant_id": 1, "status": "pending", "name": "a",
            "reason": "b", "experience": "c", "decided_by": None,
        })
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        message = FakeMessage(500)

        def interaction(action):
            return types.SimpleNamespace(
                guild=guild,
                user=FakeUser(2),
                client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
                message=message,
                response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )

        accept = interaction("accept")
        deny = interaction("deny")
        await asyncio.gather(
            applications.handle_review(cog, accept, "accept"),
            applications.handle_review(cog, deny, "deny"),
        )
        entry = (await applications._cache_data())["500"]
        self.assertIn(entry["status"], {"accepted", "denied"})
        self.assertGreaterEqual(message.edit.await_count, 1)
        self.assertEqual(guild.member.send.await_count, 1)

    async def test_failed_display_and_dm_are_repaired_on_retry(self):
        await applications._put_entry(500, {
            "id": "app-1", "applicant_id": 1, "status": "pending", "name": "a",
            "reason": "b", "experience": "c", "decided_by": None,
        })
        guild = FakeGuild()
        message = FakeMessage(500)
        message.edit = AsyncMock(side_effect=[RuntimeError("edit failed"), None, None])
        guild.member.send = AsyncMock(side_effect=[RuntimeError("dm failed"), None])
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        interaction = types.SimpleNamespace(
            guild=guild, user=FakeUser(2),
            client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
            message=message,
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await applications.handle_review(cog, interaction, "accept")
        entry = (await applications._cache_data())["500"]
        self.assertEqual(entry["status"], "accepted")
        self.assertFalse(entry.get("notified"))
        await applications.handle_review(cog, interaction, "accept")
        entry = (await applications._cache_data())["500"]
        self.assertEqual(entry["status"], "accepted")
        self.assertTrue(entry.get("notified"))
        self.assertEqual(message.edit.await_count, 3)
        self.assertEqual(guild.member.send.await_count, 2)

    async def test_fetch_failure_keeps_dm_retryable(self):
        await applications._put_entry(500, {
            "id": "app-1", "applicant_id": 2, "status": "pending", "name": "a",
            "reason": "b", "experience": "c", "decided_by": None,
        })
        guild = FakeGuild()
        message = FakeMessage(500)
        fetched = FakeUser(2)
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        interaction = types.SimpleNamespace(
            guild=guild, user=FakeUser(3),
            client=types.SimpleNamespace(fetch_user=AsyncMock(side_effect=[RuntimeError("api"), fetched])),
            message=message,
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await applications.handle_review(cog, interaction, "accept")
        entry = (await applications._cache_data())["500"]
        self.assertFalse(entry.get("notified"))
        await applications.handle_review(cog, interaction, "accept")
        entry = (await applications._cache_data())["500"]
        self.assertTrue(entry.get("notified"))
        fetched.send.assert_awaited_once()
        self.assertEqual(message.edit.await_count, 3)

    async def test_concurrent_applications_keep_one_pending(self):
        await applications.update_settings(
            1, applications.KEY, enabled=True, panel_channel_id=100, review_channel_id=101,
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = applications.ApplicationModal(cog, 1)
        modal.name_input._value = "あおい"
        modal.reason_input._value = "理由"
        modal.experience_input._value = "経験"

        def interaction():
            return types.SimpleNamespace(
                guild=guild, guild_id=1, user=FakeUser(),
                response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )

        first = interaction()
        second = interaction()
        await asyncio.gather(modal.on_submit(first), modal.on_submit(second))
        self.assertEqual(guild.review.send.await_count, 1)
        rejected = first.followup.send.await_args_list + second.followup.send.await_args_list
        self.assertTrue(any("審査中" in str(call) for call in rejected))

    async def test_apply_cooldown_rejects_rapid_repeat(self):
        applications.APPLY_COOLDOWN = 100.0
        await applications.update_settings(
            1, applications.KEY, enabled=True, panel_channel_id=100, review_channel_id=101,
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = applications.ApplicationModal(cog, 1)
        modal.name_input._value = "あおい"
        modal.reason_input._value = "理由"
        modal.experience_input._value = "経験"
        first = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        second = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(first)
        await modal.on_submit(second)
        self.assertEqual(guild.review.send.await_count, 1)
        second.followup.send.assert_awaited_once()

    async def test_duplicate_pending_application_is_rejected(self):
        await applications.update_settings(
            1, applications.KEY, enabled=True, panel_channel_id=100, review_channel_id=101,
        )
        await applications._put_entry(500, {
            "id": "app-1", "guild_id": 1, "applicant_id": 1, "status": "pending",
            "name": "a", "reason": "b", "experience": "c", "decided_by": None,
        })
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        modal = applications.ApplicationModal(cog, 1)
        modal.name_input._value = "あおい"
        modal.reason_input._value = "理由"
        modal.experience_input._value = "経験"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        interaction.followup.send.assert_awaited_once()
        guild.review.send.assert_not_awaited()

    async def test_settings_panel_send(self):
        await applications.update_settings(
            1, applications.KEY, enabled=True, panel_channel_id=100, review_channel_id=101,
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = applications.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children if isinstance(item, discord.ui.ChannelSelect)]),
            2,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("応募フォーム", labels)
        self.assertIn("パネルを送信", labels)
        panel_button = next(item for item in view.children if getattr(item, "label", None) == "パネルを送信")
        interaction = types.SimpleNamespace(
            guild=guild,
            user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await panel_button.callback(interaction)
        guild.panel.send.assert_awaited_once()
        interaction.response.defer.assert_awaited_once()
        interaction.followup.send.assert_awaited_once()

    def test_register_views(self):
        add_view = __import__("unittest.mock", fromlist=["MagicMock"]).MagicMock()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(add_view=add_view))
        applications.register_views(cog)
        self.assertEqual(add_view.call_count, 2)


if __name__ == "__main__":
    unittest.main()
