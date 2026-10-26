"""Tests for the AutoRole server-assist feature."""
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
from core.server_assist.features import autorole
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id, name, *, position=10, managed=False, default=False):
        self.id = role_id
        self.name = name
        self.mention = f"<@&{role_id}>"
        self.position = position
        self.managed = managed
        self._default = default

    def is_default(self):
        return self._default

    def __ge__(self, other):
        return self.position >= getattr(other, "position", 0)


class FakeMember:
    def __init__(self, guild, member_id=1, *, bot=False):
        self.guild = guild
        self.id = member_id
        self.bot = bot
        self.roles = []
        self.add_roles = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.everyone = FakeRole(1, "@everyone", position=0, default=True)
        self.normal = FakeRole(10, "メンバー", position=10)
        self.managed = FakeRole(11, "BOTロール", position=11, managed=True)
        self.high = FakeRole(12, "管理者", position=1000)
        self.me = types.SimpleNamespace(
            top_role=FakeRole(999, "AGOBOT", position=999),
            guild_permissions=types.SimpleNamespace(manage_roles=True),
        )
        self.roles = [self.everyone, self.normal, self.managed, self.high]

    def get_role(self, role_id):
        return next((role for role in self.roles if role.id == role_id), None)


class AutoRoleSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("autorole", keys)

    def test_defaults(self):
        self.assertEqual(
            autorole.settings(1),
            {"enabled": False, "role_ids": [], "include_bots": False},
        )

    async def test_role_ids_are_deduplicated_and_limited(self):
        await autorole.update_settings(1, autorole.KEY, role_ids=[10, 10, "x", 11] + list(range(20, 40)))
        settings = autorole.settings(1)
        self.assertEqual(settings["role_ids"], [10, 11] + list(range(20, 28)))

    def test_assignable_roles_exclude_everyone_managed_and_higher(self):
        guild = FakeGuild()
        roles = autorole._assignable_roles(guild)
        self.assertEqual([role.id for role in roles], [10])

    async def test_join_assigns_configured_roles(self):
        await autorole.update_settings(1, autorole.KEY, enabled=True, role_ids=[10])
        guild = FakeGuild()
        member = FakeMember(guild)
        await autorole.on_member_join(None, member)
        member.add_roles.assert_awaited_once()
        args = member.add_roles.await_args.args
        self.assertEqual([role.id for role in args], [10])

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        member = FakeMember(guild)
        await autorole.on_member_join(None, member)
        member.add_roles.assert_not_awaited()

    async def test_bot_is_ignored_by_default(self):
        await autorole.update_settings(1, autorole.KEY, enabled=True, role_ids=[10])
        member = FakeMember(FakeGuild(), bot=True)
        await autorole.on_member_join(None, member)
        member.add_roles.assert_not_awaited()

    async def test_bot_can_be_included(self):
        await autorole.update_settings(1, autorole.KEY, enabled=True, role_ids=[10], include_bots=True)
        member = FakeMember(FakeGuild(), bot=True)
        await autorole.on_member_join(None, member)
        member.add_roles.assert_awaited_once()

    async def test_forbidden_is_swallowed(self):
        await autorole.update_settings(1, autorole.KEY, enabled=True, role_ids=[10])
        guild = FakeGuild()
        member = FakeMember(guild)
        member.add_roles.side_effect = discord.Forbidden(
            types.SimpleNamespace(status=403, reason="Forbidden"), "missing permissions"
        )
        with self.assertLogs("core.server_assist.features.autorole", level="WARNING"):
            await autorole.on_member_join(None, member)

    def test_settings_view_lists_only_assignable_roles(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = autorole.build_view(cog, guild.id)
        select = next(item for item in view.children if isinstance(item, discord.ui.Select))
        self.assertEqual([option.value for option in select.options], ["10"])
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("自動ロール", labels)
        self.assertIn("BOTにも付与", labels)
        self.assertIn("自分に適用して確認", labels)

    async def test_select_rejects_missing_manage_roles(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = autorole.build_view(cog, guild.id)
        select = next(item for item in view.children if isinstance(item, discord.ui.Select))
        select._values = ["10"]
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=False, manage_roles=False),
                top_role=FakeRole(999, "user", position=999),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await select.callback(interaction)
        interaction.response.send_message.assert_awaited_once()

    async def test_select_rejects_role_above_actor(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = autorole.build_view(cog, guild.id)
        select = next(item for item in view.children if isinstance(item, discord.ui.Select))
        select._values = ["10"]
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=False, manage_roles=True),
                top_role=FakeRole(5, "user", position=5),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await select.callback(interaction)
        interaction.response.send_message.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
