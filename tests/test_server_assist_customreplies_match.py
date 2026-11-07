"""Tests for custom reply contains-matching and reaction actions."""
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

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist.features import customreplies
from tests.fake_kv_supabase import FakeKVSupabase


def reply(trigger, match="exact", reaction=None, rid=None):
    return {
        "id": rid or trigger,
        "trigger": trigger,
        "response": f"{trigger} への返信",
        "role_id": None,
        "match": match,
        "reaction": reaction,
    }


class MatchReplyTest(unittest.TestCase):
    def test_contains_matches_substring(self):
        replies = [reply("おはよう", match="contains")]
        self.assertIsNotNone(customreplies.match_reply(replies, "みんなおはよう！"))
        self.assertIsNone(customreplies.match_reply(replies, "こんばんは"))

    def test_exact_still_requires_full_match(self):
        replies = [reply("おはよう")]
        self.assertIsNotNone(customreplies.match_reply(replies, "おはよう"))
        self.assertIsNone(customreplies.match_reply(replies, "おはよう！"))

    def test_exact_wins_over_contains(self):
        replies = [reply("おはよう", match="contains", rid="c"), reply("おはよう", rid="e")]
        self.assertEqual(customreplies.match_reply(replies, "おはよう")["id"], "e")

    def test_longest_contains_trigger_wins(self):
        replies = [reply("おは", match="contains", rid="s"), reply("おはよう", match="contains", rid="l")]
        self.assertEqual(customreplies.match_reply(replies, "おはようございます")["id"], "l")

    def test_one_char_contains_trigger_never_matches(self):
        replies = [reply("あ", match="contains")]
        self.assertIsNone(customreplies.match_reply(replies, "あれ"))

    def test_contains_is_case_and_space_insensitive(self):
        replies = [reply("Hello World", match="contains")]
        self.assertIsNotNone(customreplies.match_reply(replies, "say hello   world please"))


class NormalizeMatchTest(unittest.TestCase):
    def test_defaults(self):
        normalized = customreplies._normalize({"trigger": "a", "response": "b"})
        self.assertEqual(normalized["match"], "exact")
        self.assertIsNone(normalized["reaction"])

    def test_unknown_match_falls_back_to_exact(self):
        normalized = customreplies._normalize({"trigger": "a", "response": "b", "match": "regex"})
        self.assertEqual(normalized["match"], "exact")

    def test_reaction_is_trimmed_and_capped(self):
        normalized = customreplies._normalize({"trigger": "a", "response": "b", "reaction": "  👋  "})
        self.assertEqual(normalized["reaction"], "👋")
        long = customreplies._normalize({"trigger": "a", "response": "b", "reaction": "x" * 40})
        self.assertEqual(len(long["reaction"]), 32)


class FakeAuthor:
    def __init__(self, user_id=2):
        self.id = user_id
        self.bot = False
        self.mention = f"<@{user_id}>"
        self.display_name = "テスト"
        self.name = "test"
        self.roles = []
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=False)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テスト鯖"
        self.member_count = 123
        self.me = types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(manage_roles=True), top_role=None,
        )

    def get_role(self, role_id):
        return None


class FakeMessage:
    def __init__(self, content, author, guild):
        self.content = content
        self.author = author
        self.guild = guild
        self.channel = types.SimpleNamespace(send=AsyncMock())
        self.reply = AsyncMock()
        self.add_reaction = AsyncMock()


class OnMessageAutomationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        customreplies.reset_cache()

    async def test_contains_rule_reacts_and_replies(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[reply("おはよう", match="contains", reaction="👋", rid="a")],
        )
        message = FakeMessage("おはようございます", FakeAuthor(), FakeGuild())
        await customreplies.on_message(None, message)
        message.add_reaction.assert_awaited_once_with("👋")
        message.reply.assert_awaited_once()

    async def test_rule_without_reaction_does_not_react(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True, replies=[reply("おはよう", rid="a")],
        )
        message = FakeMessage("おはよう", FakeAuthor(), FakeGuild())
        await customreplies.on_message(None, message)
        message.add_reaction.assert_not_awaited()
        message.reply.assert_awaited_once()

    async def test_bad_reaction_does_not_block_reply(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[reply("おはよう", reaction="not-an-emoji", rid="a")],
        )
        message = FakeMessage("おはよう", FakeAuthor(), FakeGuild())
        message.add_reaction = AsyncMock(side_effect=Exception("boom"))
        # 想定外の例外は on_message の呼び出し元 (cog 側) で握られる前提だが、
        # discord.HTTPException 系は _add_reaction 内で吸収されることを確認する
        import discord
        message.add_reaction = AsyncMock(side_effect=discord.HTTPException(
            types.SimpleNamespace(status=400, reason="Bad Request"), "unknown emoji"))
        await customreplies.on_message(None, message)
        message.reply.assert_awaited_once()

    async def test_exact_and_contains_same_trigger_coexist(self):
        await customreplies.update_settings(
            1, customreplies.KEY, enabled=True,
            replies=[
                reply("おはよう", rid="e"),
                reply("おはよう", match="contains", rid="c"),
            ],
        )
        saved = customreplies.settings(1)["replies"]
        self.assertEqual(len(saved), 2)


if __name__ == "__main__":
    unittest.main()
