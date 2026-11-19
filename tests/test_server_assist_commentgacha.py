"""Tests for the history gacha server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist import discover_features
from core.support.server_assist.features import commentgacha
from tests.fake_kv_supabase import FakeKVSupabase


def make_author(name="誰か", *, bot=False, user_id=10):
    return types.SimpleNamespace(
        id=user_id,
        bot=bot,
        display_name=name,
        display_avatar=types.SimpleNamespace(url="https://example.com/avatar.png"),
    )


class FakeWebhook:
    def __init__(self):
        self.send = AsyncMock()


class FakeChannel:
    def __init__(self, messages=(), *, manage_webhooks=True, read_history=True):
        self.id = 100
        self._messages = list(messages)
        self.webhook = FakeWebhook()
        self.create_webhook = AsyncMock(return_value=self.webhook)
        self._permissions = types.SimpleNamespace(
            manage_webhooks=manage_webhooks,
            read_message_history=read_history,
        )

    def history(self, limit=None):
        messages = list(self._messages)

        async def gen():
            for item in messages:
                yield item

        return gen()

    async def webhooks(self):
        return []

    def permissions_for(self, me):
        return self._permissions


def hist_message(msg_id, content, *, author=None, webhook_id=None, attachments=()):
    return types.SimpleNamespace(
        id=msg_id,
        content=content,
        author=author or make_author(f"user{msg_id}", user_id=msg_id),
        webhook_id=webhook_id,
        type=None,
        attachments=list(attachments),
    )


class FakeMessage:
    def __init__(self, content="ガチャ", *, channel=None, bot=False):
        self.id = 999
        self.content = content
        self.guild = types.SimpleNamespace(id=1, me=types.SimpleNamespace(id=5))
        self.author = make_author("引いた人", bot=bot, user_id=2)
        self.channel = channel or FakeChannel()


class CommentGachaTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        commentgacha.reset_cache()

    async def enable(self, triggers=None):
        await commentgacha.update_settings(
            1,
            commentgacha.KEY,
            enabled=True,
            triggers=triggers if triggers is not None else [{"id": "a", "trigger": "ガチャ", "match": "exact"}],
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("commentgacha", keys)

    def test_defaults(self):
        self.assertEqual(
            commentgacha.settings(1),
            {"enabled": False, "triggers": []},
        )

    async def test_settings_deduplicates_triggers(self):
        await commentgacha.update_settings(1, commentgacha.KEY, triggers=[
            {"id": "a", "trigger": " ガチャ ", "match": "exact"},
            {"id": "b", "trigger": "ガチャ", "match": "exact"},
            {"id": "c", "trigger": "ガチャ", "match": "contains"},
            {"id": "d", "trigger": " ", "match": "exact"},
        ])
        triggers = commentgacha.settings(1)["triggers"]
        self.assertEqual([t["id"] for t in triggers], ["a", "c"])

    async def test_draw_filters_ineligible_messages(self):
        channel = FakeChannel([
            hist_message(1, "ボットの発言", author=make_author("bot", bot=True)),
            hist_message(2, "webhookの発言", webhook_id=123),
            hist_message(3, ""),
            hist_message(999, "トリガー発言自体"),
            hist_message(4, "対象の発言"),
        ])
        with patch.object(commentgacha.random, "randrange", return_value=0):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        self.assertEqual(chosen.id, 4)

    async def test_draw_returns_none_without_candidates(self):
        channel = FakeChannel([hist_message(1, "", author=make_author("bot", bot=True))])
        chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        self.assertIsNone(chosen)

    async def test_draw_rolls_against_total_and_fetches_only_that_one(self):
        channel = FakeChannel([
            hist_message(1, "最初の発言"),
            hist_message(2, "次の発言"),
            hist_message(3, "最後の発言"),
        ])
        with patch.object(commentgacha.random, "randrange", return_value=2) as roll:
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        roll.assert_called_once_with(3)
        self.assertEqual(chosen.id, 3)

    async def test_count_candidates_counts_only_eligible(self):
        channel = FakeChannel([
            hist_message(1, "対象"),
            hist_message(2, "ボット", author=make_author("bot", bot=True)),
            hist_message(3, "対象2"),
        ])
        self.assertEqual(await commentgacha.count_candidates(channel, exclude_id=999), 2)

    async def test_on_message_reposts_drawn_message_via_webhook(self):
        await self.enable()
        channel = FakeChannel([hist_message(7, "昔の名言", author=make_author("名言の主", user_id=7))])
        message = FakeMessage(channel=channel)
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await commentgacha.on_message(None, message)
        channel.create_webhook.assert_awaited_once_with(name=commentgacha.WEBHOOK_NAME)
        channel.webhook.send.assert_awaited_once()
        kwargs = channel.webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "昔の名言")
        self.assertEqual(kwargs["username"], "名言の主")
        self.assertEqual(kwargs["avatar_url"], "https://example.com/avatar.png")
        self.assertTrue(kwargs["_agobot_skip_localization"])
        mentions = kwargs["allowed_mentions"]
        self.assertFalse(mentions.everyone or mentions.users or mentions.roles)

    async def test_on_message_contains_match(self):
        await self.enable(triggers=[{"id": "a", "trigger": "ガチャ", "match": "contains"}])
        channel = FakeChannel([hist_message(7, "掘り起こし")])
        message = FakeMessage(content="今日はガチャの日", channel=channel)
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await commentgacha.on_message(None, message)
        channel.webhook.send.assert_awaited_once()

    async def test_on_message_disabled_or_unmatched_does_nothing(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        await commentgacha.on_message(None, FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()
        await self.enable()
        await commentgacha.on_message(None, FakeMessage(content="関係ない言葉", channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_on_message_cooldown_blocks_second_draw(self):
        await self.enable()
        channel = FakeChannel([hist_message(7, "昔の名言")])
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await commentgacha.on_message(None, FakeMessage(channel=channel))
            await commentgacha.on_message(None, FakeMessage(channel=channel))
        channel.webhook.send.assert_awaited_once()

    async def test_on_message_without_webhook_permission_does_nothing(self):
        await self.enable()
        channel = FakeChannel(
            [hist_message(7, "昔の名言")], manage_webhooks=False,
        )
        await commentgacha.on_message(None, FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()
        channel.webhook.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
