"""Tests for custom reply extensions: variables, role grant action, permission role."""
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

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist.features import customreplies
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id, position=1):
        self.id = role_id
        self.position = position

    def __lt__(self, other):
        return self.position < other.position


class FakeAuthor:
    def __init__(self, roles=(), admin=False, user_id=2):
        self.id = user_id
        self.bot = False
        self.mention = f"<@{user_id}>"
        self.display_name = "テスト"
        self.name = "test"
        self.roles = list(roles)
        self.guild_permissions = types.SimpleNamespace(
            administrator=admin, manage_guild=False,
        )
        self.add_roles = AsyncMock(side_effect=self._add)

    async def _add(self, role, reason=None):
        self.roles.append(role)


class FakeGuild:
    def __init__(self, role=None):
        self.id = 1
        self.name = "テスト鯖"
        self.member_count = 123
        self.role = role or FakeRole(555, position=1)
        self.me = types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(manage_roles=True),
            top_role=FakeRole(999, position=10),
        )

    def get_role(self, role_id):
        return self.role if role_id == self.role.id else None


class FakeMessage:
    def __init__(self, content, author, guild):
        self.content = content
        self.author = author
        self.guild = guild
        self.channel = types.SimpleNamespace(send=AsyncMock())
        self.reply = AsyncMock()


class CustomReplyExtTest(unittest.IsolatedAsyncioTestCase):
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

    async def _setup(self, replies, **extra):
        await customreplies.update_settings(1, customreplies.KEY, enabled=True, replies=replies, **extra)

    async def test_variables_are_expanded(self):
        await self._setup([{
            "id": "a", "trigger": "挨拶",
            "response": "{user} ようこそ{name}さん、{server}は{count}人、IDは{id}",
        }])
        message = FakeMessage("挨拶", FakeAuthor(), FakeGuild())
        await customreplies.on_message(None, message)
        sent = message.reply.await_args.args[0]
        self.assertEqual(sent, "<@2> ようこそテストさん、テスト鯖は123人、IDは2")

    async def test_role_is_granted_on_trigger(self):
        await self._setup([{"id": "a", "trigger": "参加", "response": "ok", "role_id": 555}])
        author = FakeAuthor()
        message = FakeMessage("参加", author, FakeGuild())
        await customreplies.on_message(None, message)
        author.add_roles.assert_awaited_once()
        self.assertIn(555, [role.id for role in author.roles])
        message.reply.assert_awaited_once()

    async def test_role_not_granted_twice(self):
        await self._setup([{"id": "a", "trigger": "参加", "response": "ok", "role_id": 555}])
        author = FakeAuthor(roles=[FakeRole(555)])
        message = FakeMessage("参加", author, FakeGuild())
        await customreplies.on_message(None, message)
        author.add_roles.assert_not_awaited()

    async def test_min_role_blocks_members_without_role(self):
        await self._setup(
            [{"id": "a", "trigger": "ping", "response": "pong"}],
            min_role_id=777,
        )
        message = FakeMessage("ping", FakeAuthor(), FakeGuild())
        await customreplies.on_message(None, message)
        message.reply.assert_not_awaited()

    async def test_min_role_allows_member_with_role_and_admin(self):
        await self._setup(
            [{"id": "a", "trigger": "ping", "response": "pong"}],
            min_role_id=777,
        )
        with_role = FakeMessage("ping", FakeAuthor(roles=[FakeRole(777)]), FakeGuild())
        await customreplies.on_message(None, with_role)
        with_role.reply.assert_awaited_once()
        admin = FakeMessage("ping", FakeAuthor(admin=True, user_id=3), FakeGuild())
        await customreplies.on_message(None, admin)
        admin.reply.assert_awaited_once()

    def test_normalize_keeps_valid_role_id_only(self):
        self.assertEqual(
            customreplies._normalize({"trigger": "a", "response": "b", "role_id": 5})["role_id"], 5)
        self.assertIsNone(
            customreplies._normalize({"trigger": "a", "response": "b", "role_id": "5"})["role_id"])
        self.assertIsNone(
            customreplies._normalize({"trigger": "a", "response": "b"})["role_id"])


if __name__ == "__main__":
    unittest.main()
