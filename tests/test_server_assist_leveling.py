"""Tests for level role rewards."""
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

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import leveling
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id, name, *, position=10, managed=False):
        self.id = role_id
        self.name = name
        self.mention = f"<@&{role_id}>"
        self.position = position
        self.managed = managed

    def __ge__(self, other):
        return self.position >= getattr(other, "position", 0)


class FakeMember:
    def __init__(self, member_id=1):
        self.id = member_id
        self.mention = "<@1>"
        self.display_name = "あおい"
        self.name = "aoi"
        self.roles = []
        self.add_roles = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テストサーバー"
        self.me = types.SimpleNamespace(top_role=FakeRole(999, "AGOBOT", position=999))
        self.role = FakeRole(50, "Lv5", position=10)
        self.high_role = FakeRole(60, "Lv10", position=20)
        self.too_high = FakeRole(70, "上すぎ", position=1000)
        self.roles = [self.role, self.high_role, self.too_high]

    def get_role(self, role_id):
        return next((role for role in self.roles if role.id == role_id), None)


class LevelingRewardsTest(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn("leveling", keys)

    def test_defaults(self):
        self.assertEqual(leveling.settings(1), {"enabled": False, "role_rewards": {}})

    def test_reward_parser(self):
        self.assertEqual(leveling._parse_rewards("10=50\n20=60"), {"10": 50, "20": 60})
        with self.assertRaises(ValueError):
            leveling._parse_rewards("10")
        with self.assertRaises(ValueError):
            leveling._parse_rewards("1=50")
        with self.assertRaises(ValueError):
            leveling._parse_rewards("\n".join(f"{i}=50" for i in range(2, 13)))

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        member = FakeMember()
        await leveling.handle_level_rewards(None, guild, member, 1, 2)
        member.add_roles.assert_not_awaited()

    async def test_level_up_grants_highest_reward(self):
        await leveling.update_settings(
            1, leveling.KEY, enabled=True, role_rewards={"5": 50, "10": 60, "20": 70},
        )
        guild = FakeGuild()
        member = FakeMember()
        await leveling.handle_level_rewards(None, guild, member, 1, 12)
        member.add_roles.assert_awaited_once()
        self.assertEqual(member.add_roles.await_args.args[0].id, 60)

    async def test_already_has_reward_role(self):
        await leveling.update_settings(
            1, leveling.KEY, enabled=True, role_rewards={"10": 60},
        )
        guild = FakeGuild()
        member = FakeMember()
        member.roles = [guild.high_role]
        await leveling.handle_level_rewards(None, guild, member, 1, 10)
        member.add_roles.assert_not_awaited()

    async def test_reward_above_bot_role_is_skipped(self):
        await leveling.update_settings(
            1, leveling.KEY, enabled=True, role_rewards={"10": 70},
        )
        guild = FakeGuild()
        member = FakeMember()
        await leveling.handle_level_rewards(None, guild, member, 1, 10)
        member.add_roles.assert_not_awaited()

    async def test_same_level_does_nothing(self):
        await leveling.update_settings(1, leveling.KEY, enabled=True, role_rewards={"10": 60})
        guild = FakeGuild()
        member = FakeMember()
        await leveling.handle_level_rewards(None, guild, member, 5, 5)
        member.add_roles.assert_not_awaited()

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = leveling.build_view(cog, guild.id)
        self.assertFalse([item for item in view.children if isinstance(item, discord.ui.Select)])
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("レベル報酬", labels)
        self.assertIn("レベル報酬を設定", labels)
        self.assertIn("サーバーアシストへ戻る", labels)

    async def test_toggle_rejects_missing_manage_roles(self):
        await leveling.update_settings(1, leveling.KEY, role_rewards={"10": 50})
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = leveling.build_view(cog, 1)
        button = next(item for item in view.children if getattr(item, "label", None) == "レベル報酬")
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=False, manage_guild=True, manage_roles=False),
                top_role=FakeRole(999, "user", position=999),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock(), edit_message=AsyncMock()),
        )
        await button.callback(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertFalse(leveling.settings(1)["enabled"])

    async def test_toggle_rejects_role_above_actor(self):
        await leveling.update_settings(1, leveling.KEY, role_rewards={"10": 50})
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = leveling.build_view(cog, 1)
        button = next(item for item in view.children if getattr(item, "label", None) == "レベル報酬")
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=False, manage_guild=True, manage_roles=True),
                top_role=FakeRole(5, "user", position=5),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock(), edit_message=AsyncMock()),
        )
        await button.callback(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertFalse(leveling.settings(1)["enabled"])


class LevelingGeneralIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_general_on_message_notifies_rewards(self):
        from cogs import general as general_module
        from cogs.general import GeneralCog

        store = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            get=lambda _guild_id, _section: {},
        )
        cog = GeneralCog(types.SimpleNamespace())
        cog._notify_level_rewards = AsyncMock()
        cog._spawn = lambda coro: coro.close()
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=1),
            guild=types.SimpleNamespace(id=1),
            channel=types.SimpleNamespace(id=10),
            content="hello",
        )
        user = {"chat_exp": 0, "vc_exp": 0}
        with (
            patch.object(general_module, "_exp_load", AsyncMock(return_value={})),
            patch.object(general_module, "_exp_ensure", return_value=user),
            patch.object(general_module, "_grant_chat_exp", return_value=True),
            patch.object(general_module, "_exp_save", AsyncMock()),
            patch.object(general_module, "_user_general_level", side_effect=[1, 2]),
            patch.object(general_module.guild_settings, "get_store", return_value=store),
        ):
            await cog.on_message(message)
        cog._notify_level_rewards.assert_awaited_once()

    async def test_general_calls_server_assist_reward_handler(self):
        from cogs.general import GeneralCog
        handler = AsyncMock()
        assist = types.SimpleNamespace(handle_level_rewards=handler)
        bot = types.SimpleNamespace(get_cog=lambda name: assist if name == "ServerAssistCog" else None)
        cog = GeneralCog(bot)
        guild, member = FakeGuild(), FakeMember()
        await cog._notify_level_rewards(guild, member, 1, 2)
        handler.assert_awaited_once_with(guild, member, 1, 2)
        await cog._notify_level_rewards(guild, member, 2, 2)
        handler.assert_awaited_once()

    async def test_general_ignores_missing_assist_cog(self):
        from cogs.general import GeneralCog
        cog = GeneralCog(types.SimpleNamespace(get_cog=lambda _name: None))
        await cog._notify_level_rewards(FakeGuild(), FakeMember(), 1, 2)


if __name__ == "__main__":
    unittest.main()
