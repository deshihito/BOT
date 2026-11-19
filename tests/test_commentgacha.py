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
    """messages は新しい順（実Discordの既定の履歴順）に渡す。"""

    def __init__(self, messages=(), *, manage_webhooks=True, read_history=True, channel_id=100, name="general"):
        self.id = channel_id
        self.name = name
        self._messages = list(messages)
        self.last_message_id = self._messages[0].id if self._messages else None
        self.webhook = FakeWebhook()
        self.create_webhook = AsyncMock(return_value=self.webhook)
        self._permissions = types.SimpleNamespace(
            manage_webhooks=manage_webhooks,
            read_message_history=read_history,
        )

    def history(self, limit=None, *, before=None, after=None, around=None, oldest_first=None):
        items = list(self._messages)
        if after is not None:
            items = [m for m in items if m.id > after.id]
        if before is not None:
            items = [m for m in items if m.id < before.id]
        if oldest_first:
            items.reverse()
        if limit is not None:
            items = items[:limit]

        async def gen():
            for item in items:
                yield item

        return gen()

    async def webhooks(self):
        return []

    def permissions_for(self, me):
        return self._permissions


def hist_message(msg_id, content, *, author=None, webhook_id=None, attachments=(), mentions=(), role_mentions=()):
    return types.SimpleNamespace(
        id=msg_id,
        content=content,
        author=author or make_author(f"user{msg_id}", user_id=msg_id),
        webhook_id=webhook_id,
        type=None,
        attachments=list(attachments),
        mentions=list(mentions),
        role_mentions=list(role_mentions),
    )


def make_guild(*channels):
    return types.SimpleNamespace(
        id=1,
        me=types.SimpleNamespace(id=5),
        text_channels=list(channels),
        threads=[],
        get_channel=lambda cid: {c.id: c for c in channels}.get(cid),
    )


class FakeMessage:
    def __init__(self, content="コメントガチャ", *, channel=None, bot=False, guild=True, channel_mentions=()):
        self.id = 999
        self.content = content
        if guild is True:
            self.guild = types.SimpleNamespace(id=1, me=types.SimpleNamespace(id=5))
        elif guild:
            self.guild = guild
        else:
            self.guild = None
        self.author = make_author("引いた人", bot=bot, user_id=2)
        self.channel = channel or FakeChannel()
        self.channel_mentions = list(channel_mentions)


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
        await cog.on_message(message)
        channel.webhook.send.assert_awaited_once()

    async def test_bot_fixer_blocked_guild_does_not_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        cog = self.make_cog()
        with patch("core.general.commentgacha.cog.command_control.guard_message",
                   new=AsyncMock(return_value=False)) as guard:
            await cog.on_message(FakeMessage(channel=channel))
        guard.assert_awaited_once()
        self.assertEqual(guard.await_args.args[1], "general:commentgacha")
        channel.create_webhook.assert_not_awaited()

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
            hist_message(9, "前のコメントガチャして"),
            hist_message(8, "コメントガチャ"),
        ])
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_cooldown_is_one_second(self):
        # クールダウンは1秒。同時発火だけが抑止され、1秒空ければまた引ける。
        channel = FakeChannel([hist_message(7, "昔の名言")])
        now = [1000.0]
        cog = self.make_cog(clock=lambda: now[0])
        await cog.on_message(FakeMessage(channel=channel))
        await cog.on_message(FakeMessage(channel=channel))
        self.assertEqual(channel.webhook.send.await_count, 1)
        now[0] += 1.1
        await cog.on_message(FakeMessage(channel=channel))
        self.assertEqual(channel.webhook.send.await_count, 2)

    async def test_repost_neutralizes_mentions(self):
        mentioned_user = make_author("タロウ", user_id=42)
        role = types.SimpleNamespace(id=55, name="お知らせ")
        channel = FakeChannel([
            hist_message(
                700, "<@42> @everyone <@&55> <#777> 見て",
                mentions=[mentioned_user], role_mentions=[role],
            ),
        ])
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel))
        kwargs = channel.webhook.send.await_args.kwargs
        # 名前が引けるメンションは @名前 のプレーンテキストに、
        # @everyone はゼロ幅スペースで無力化。チャンネルメンションは残る。
        self.assertEqual(kwargs["content"], "@タロウ @​everyone @お知らせ <#777> 見て")
        self.assertNotIn("<@42>", kwargs["content"])
        self.assertNotIn("<@&55>", kwargs["content"])

    async def test_channel_mention_targets_other_channel(self):
        here = FakeChannel([], channel_id=100, name="general")
        there = FakeChannel(
            [hist_message(700, "雑談の名発言")], channel_id=200, name="雑談",
        )
        cog = self.make_cog()
        message = FakeMessage(
            "コメントガチャ <#200>",
            channel=here,
            guild=make_guild(here, there),
            channel_mentions=[there],
        )
        await cog.on_message(message)
        # 掘り返し先は #雑談、再投稿は発動したチャンネルへ。
        kwargs = here.webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "雑談の名発言")
        there.webhook.send.assert_not_awaited()

    async def test_trailing_channel_name_targets_other_channel(self):
        here = FakeChannel([], channel_id=100, name="general")
        there = FakeChannel(
            [hist_message(700, "雑談の名発言")], channel_id=200, name="雑談",
        )
        cog = self.make_cog()
        message = FakeMessage(
            "コメントガチャ#雑談",
            channel=here,
            guild=make_guild(here, there),
        )
        await cog.on_message(message)
        kwargs = here.webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "雑談の名発言")

    async def test_unknown_channel_name_does_nothing(self):
        here = FakeChannel([hist_message(700, "ここの発言")], channel_id=100, name="general")
        cog = self.make_cog()
        message = FakeMessage(
            "コメントガチャ#存在しない",
            channel=here,
            guild=make_guild(here),
        )
        await cog.on_message(message)
        here.webhook.send.assert_not_awaited()
        here.create_webhook.assert_not_awaited()

    async def test_without_webhook_permission_no_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")], manage_webhooks=False)
        cog = self.make_cog()
        await cog.on_message(FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()
        channel.webhook.send.assert_not_awaited()

    async def test_draw_picks_candidate_after_random_pivot(self):
        channel = FakeChannel([
            hist_message(300, "最新の発言"),
            hist_message(200, "真ん中の発言"),
            hist_message(100, "最古の発言"),
        ])
        with patch.object(commentgacha.random, "randint", return_value=150) as roll, \
                patch.object(commentgacha.random, "choice", side_effect=lambda seq: seq[0]):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        roll.assert_called_once_with(100, 300)
        self.assertEqual(chosen.id, 200)

    async def test_draw_skips_ineligible_messages_after_pivot(self):
        channel = FakeChannel([
            hist_message(300, "対象の発言"),
            hist_message(200, "ボット", author=make_author("bot", bot=True)),
            hist_message(100, "最古の発言"),
        ])
        with patch.object(commentgacha.random, "randint", return_value=150), \
                patch.object(commentgacha.random, "choice", side_effect=lambda seq: seq[0]):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        self.assertEqual(chosen.id, 300)

    async def test_draw_uses_no_oldest_fetch_on_fast_path(self):
        channel = FakeChannel([
            hist_message(300, "最新の発言"),
            hist_message(200, "真ん中の発言"),
            hist_message(100, "最古の発言"),
        ])
        calls = []
        original = channel.history

        def recording(**kwargs):
            calls.append(kwargs)
            return original(**kwargs)

        channel.history = recording
        with patch.object(commentgacha.random, "randint", return_value=150), \
                patch.object(commentgacha.random, "choice", side_effect=lambda seq: seq[0]):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        self.assertEqual(chosen.id, 200)
        # 通常経路では窓取得（limit=DRAW_WINDOW）だけを使い、
        # 最古取得（after=0 / limit=1）を叩かない。
        self.assertTrue(calls)
        self.assertTrue(all(c.get("limit") == commentgacha.DRAW_WINDOW for c in calls))

    async def test_draw_falls_back_to_fetching_latest_without_cache(self):
        channel = FakeChannel([
            hist_message(300, "最新の発言"),
            hist_message(200, "真ん中の発言"),
            hist_message(100, "最古の発言"),
        ])
        channel.last_message_id = None
        with patch.object(commentgacha.random, "randint", return_value=150) as roll, \
                patch.object(commentgacha.random, "choice", side_effect=lambda seq: seq[0]):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        roll.assert_called_once_with(100, 300)
        self.assertEqual(chosen.id, 200)

    async def test_draw_returns_none_without_candidates(self):
        channel = FakeChannel([
            hist_message(200, "ボット2", author=make_author("bot", bot=True)),
            hist_message(100, "ボット1", author=make_author("bot", bot=True)),
        ])
        with patch.object(commentgacha.random, "randint", return_value=150):
            chosen = await commentgacha.draw_random_message(channel, exclude_id=999)
        self.assertIsNone(chosen)


if __name__ == "__main__":
    unittest.main()
