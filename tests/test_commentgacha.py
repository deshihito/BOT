"""Tests for the comment gacha easter egg (always-on, keyword-triggered)."""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core.general.commentgacha import cog as commentgacha
from core.general.commentgacha.cog import CommentGachaCog


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
    def __init__(self, content="コメントガチャ", *, channel=None, bot=False, guild=True):
        self.id = 999
        self.content = content
        self.guild = (
            types.SimpleNamespace(id=1, me=types.SimpleNamespace(id=5)) if guild else None
        )
        self.author = make_author("引いた人", bot=bot, user_id=2)
        self.channel = channel or FakeChannel()


class CommentGachaCogTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self, clock=lambda: 1000.0):
        return CommentGachaCog(types.SimpleNamespace(), clock=clock)

    def test_registered_in_general_entry(self):
        import cogs.general

        modules = dict(cogs.general._FEATURE_MODULES)
        self.assertEqual(modules.get("commentgacha"), "core.general.commentgacha.cog")
        self.assertIs(cogs.general.CommentGachaCog, CommentGachaCog)

    async def test_trigger_reposts_drawn_message_via_webhook(self):
        channel = FakeChannel([hist_message(7, "昔の名言", author=make_author("名言の主", user_id=7))])
        message = FakeMessage(channel=channel)
        cog = self.make_cog()
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await cog.on_message(message)
        channel.create_webhook.assert_awaited_once_with(name=commentgacha.WEBHOOK_NAME)
        channel.webhook.send.assert_awaited_once()
        kwargs = channel.webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "昔の名言")
        self.assertEqual(kwargs["username"], "名言の主")
        self.assertEqual(kwargs["avatar_url"], "https://example.com/avatar.png")
        self.assertTrue(kwargs["_agobot_skip_localization"])
        mentions = kwargs["allowed_mentions"]
        self.assertFalse(mentions.everyone or mentions.users or mentions.roles)

    async def test_trigger_phrase_inside_longer_message_also_fires(self):
        channel = FakeChannel([hist_message(7, "掘り起こし")])
        message = FakeMessage(content="ねえコメントガチャして", channel=channel)
        cog = self.make_cog()
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await cog.on_message(message)
        channel.webhook.send.assert_awaited_once()

    async def test_no_trigger_no_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        cog = self.make_cog()
        await cog.on_message(FakeMessage(content="関係ない言葉", channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_bot_author_and_dm_are_ignored(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel, bot=True))
        await cog.on_message(FakeMessage(channel=channel, guild=False))
        channel.create_webhook.assert_not_awaited()

    async def test_trigger_calls_are_not_candidates(self):
        channel = FakeChannel([
            hist_message(8, "コメントガチャ"),
            hist_message(9, "前のコメントガチャして"),
        ])
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_cooldown_blocks_second_draw(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        cog = self.make_cog()
        with patch.object(commentgacha.random, "randrange", return_value=0):
            await cog.on_message(FakeMessage(channel=channel))
            await cog.on_message(FakeMessage(channel=channel))
        channel.webhook.send.assert_awaited_once()

    async def test_without_webhook_permission_no_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")], manage_webhooks=False)
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()
        channel.webhook.send.assert_not_awaited()

    async def test_count_candidates_counts_only_eligible(self):
        channel = FakeChannel([
            hist_message(1, "対象"),
            hist_message(2, "ボット", author=make_author("bot", bot=True)),
            hist_message(3, "webhook", webhook_id=42),
            hist_message(4, ""),
            hist_message(5, "対象2"),
        ])
        self.assertEqual(await commentgacha.count_candidates(channel, exclude_id=999), 2)

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


if __name__ == "__main__":
    unittest.main()
