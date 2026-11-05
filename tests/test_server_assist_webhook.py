"""Tests for the webhook builder feature."""
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
from core.server_assist.features import webhookbuilder as wb
from tests.fake_kv_supabase import FakeKVSupabase


class FakeWebhook:
    def __init__(self, name=wb.WEBHOOK_NAME, owner_id=999):
        self.name = name
        self.user = types.SimpleNamespace(id=owner_id)
        self.token = "tok"
        self.send = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id=100, webhooks=()):
        self.id = channel_id
        self.mention = f"<#{channel_id}>"
        self._webhooks = list(webhooks)
        self.created = []

    async def webhooks(self):
        return list(self._webhooks)

    async def create_webhook(self, name):
        webhook = FakeWebhook(name=name)
        self.created.append(webhook)
        self._webhooks.append(webhook)
        return webhook

    def permissions_for(self, member):
        return types.SimpleNamespace(manage_webhooks=True, send_messages=True)


class FakeGuild:
    def __init__(self, channel=None):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.channel = channel or FakeChannel()
        self.text_channels = [self.channel]

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class WebhookBuilderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        wb._webhook_cache.clear()
        wb._last_post.clear()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("webhook", keys)

    def test_defaults(self):
        self.assertEqual(wb.settings(1), {"enabled": False, "channel_id": None})

    def test_sanitize_username(self):
        self.assertIsNone(wb.sanitize_username(""))
        self.assertIsNone(wb.sanitize_username("   "))
        self.assertEqual(wb.sanitize_username("お知らせ"), "お知らせ")
        self.assertNotEqual(wb.sanitize_username("Discord公式"), "Discord公式")
        self.assertEqual(wb.sanitize_username("everyone"), "everyoneさん")
        self.assertEqual(len(wb.sanitize_username("x" * 100)), 80)

    def test_valid_avatar_url(self):
        self.assertEqual(wb.valid_avatar_url("https://example.com/a.png"), "https://example.com/a.png")
        self.assertIsNone(wb.valid_avatar_url("ftp://example.com/a.png"))
        self.assertIsNone(wb.valid_avatar_url(""))

    async def test_get_or_create_reuses_bot_webhook(self):
        existing = FakeWebhook()
        channel = FakeChannel(webhooks=[existing])
        webhook = await wb.get_or_create_webhook(channel, 999)
        self.assertIs(webhook, existing)
        self.assertEqual(channel.created, [])

    async def test_get_or_create_creates_when_missing(self):
        other = FakeWebhook(name="AGOBOT-Translate")
        channel = FakeChannel(webhooks=[other])
        webhook = await wb.get_or_create_webhook(channel, 999)
        self.assertEqual(webhook.name, wb.WEBHOOK_NAME)
        self.assertEqual(len(channel.created), 1)

    async def test_post_via_webhook_sends_with_overrides(self):
        channel = FakeChannel()
        await wb.post_via_webhook(channel, 999, content="hello", username="告知", avatar_url=None)
        webhook = channel.created[0]
        webhook.send.assert_awaited_once()
        kwargs = webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "hello")
        self.assertEqual(kwargs["username"], "告知")

    async def test_modal_posts(self):
        await wb.update_settings(1, wb.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = wb.build_view(cog, 1)
        modal = wb.WebhookPostModal(view)
        modal.username_input._value = "運営"
        modal.avatar_input._value = ""
        modal.content_input._value = "メンテナンスのお知らせ"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=7, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock(),
                edit_message=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
            guild=guild,
            guild_id=1,
            client=types.SimpleNamespace(user=types.SimpleNamespace(id=999)),
        )
        await modal.on_submit(interaction)
        webhook = guild.channel.created[0]
        webhook.send.assert_awaited_once()
        self.assertEqual(webhook.send.await_args.kwargs["username"], "運営")
        self.assertEqual(webhook.send.await_args.kwargs["content"], "メンテナンスのお知らせ")

    def test_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = wb.build_view(cog, 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("Webhookビルダー", labels)
        self.assertIn("Webhookで投稿", labels)


if __name__ == "__main__":
    unittest.main()
