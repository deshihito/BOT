"""Tests for sticky roles."""
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
from core.server_assist.features import stickyroles
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id=10, *, position=10, managed=False, default=False):
        self.id = role_id
        self.mention = f"<@&{role_id}>"
        self.position = position
        self.managed = managed
        self._default = default

    def is_default(self):
        return self._default

    def __ge__(self, other):
        return self.position >= getattr(other, "position", 0)


class FakeMember:
    def __init__(self, guild, member_id=1, *, bot=False, roles=None):
        self.guild = guild
        self.id = member_id
        self.bot = bot
        self.roles = list(roles or [])
        self.add_roles = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(top_role=FakeRole(999, position=999))
        self.normal = FakeRole(10)
        self.high = FakeRole(20, position=1000)
        self.roles = [self.normal, self.high]

    def get_role(self, role_id):
        return next((role for role in self.roles if role.id == role_id), None)


class StickyRolesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        stickyroles.reset_cache()
        stickyroles._entries = KVStore(
            "server_assist_stickyroles",
            client=self.db,
            path=os.path.join(self.tmp.name, "stickyroles.json"),
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("stickyroles", keys)

    def test_defaults(self):
        self.assertEqual(stickyroles.settings(1), {"enabled": False, "ignore_bots": True})

    async def test_remove_stores_and_join_restores(self):
        await stickyroles.update_settings(1, stickyroles.KEY, enabled=True)
        guild = FakeGuild()
        member = FakeMember(guild, roles=[guild.normal])
        await stickyroles.on_member_remove(None, member)
        self.assertEqual((await stickyroles._cache_data())["1:1"], [10])
        rejoined = FakeMember(guild)
        await stickyroles.on_member_join(None, rejoined)
        rejoined.add_roles.assert_awaited_once()
        self.assertEqual(rejoined.add_roles.await_args.args[0].id, 10)
        self.assertNotIn("1:1", await stickyroles._cache_data())

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        member = FakeMember(guild, roles=[guild.normal])
        await stickyroles.on_member_remove(None, member)
        self.assertNotIn("1:1", await stickyroles._cache_data())

    async def test_bot_is_ignored(self):
        await stickyroles.update_settings(1, stickyroles.KEY, enabled=True)
        guild = FakeGuild()
        member = FakeMember(guild, bot=True, roles=[guild.normal])
        await stickyroles.on_member_remove(None, member)
        self.assertNotIn("1:1", await stickyroles._cache_data())

    async def test_high_role_is_not_stored(self):
        await stickyroles.update_settings(1, stickyroles.KEY, enabled=True)
        guild = FakeGuild()
        member = FakeMember(guild, roles=[guild.normal, guild.high])
        await stickyroles.on_member_remove(None, member)
        self.assertEqual((await stickyroles._cache_data())["1:1"], [10])

    async def test_restore_failure_keeps_stored_roles(self):
        await stickyroles.update_settings(1, stickyroles.KEY, enabled=True)
        guild = FakeGuild()
        await stickyroles._cache_data()
        stickyroles._cache["1:1"] = [10]
        member = FakeMember(guild)
        member.add_roles.side_effect = discord.Forbidden(
            types.SimpleNamespace(status=403, reason="Forbidden"), "missing permissions",
        )
        await stickyroles.on_member_join(None, member)
        self.assertIn("1:1", await stickyroles._cache_data())

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = stickyroles.build_view(cog, guild.id)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("ロール復元", labels)
        self.assertIn("BOTを除外", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
