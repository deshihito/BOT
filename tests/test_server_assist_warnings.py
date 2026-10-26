"""Tests for the warning server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import warnings
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id=5, name="モデレーター"):
        self.id = role_id
        self.name = name
        self.managed = False

    def is_default(self):
        return False


class FakeUser:
    def __init__(self, user_id=1, name="あおい", manage_guild=True, roles=None):
        self.id = user_id
        self.display_name = name
        self.name = name
        self.bot = False
        self.guild_permissions = types.SimpleNamespace(
            administrator=False, manage_guild=manage_guild,
        )
        self.roles = list(roles or [])
        self.send = AsyncMock()


class FakeMessage:
    def __init__(self, message_id=500):
        self.id = message_id


class FakeChannel:
    def __init__(self, channel_id=100, name="通報"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock(return_value=FakeMessage())

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テストサーバー"
        self.me = types.SimpleNamespace(id=999)
        self.panel = FakeChannel(100, "staff")
        self.log = FakeChannel(101, "warn-log")
        self.text_channels = [self.panel, self.log]
        self.roles = [FakeRole()]
        self.member = FakeUser(2, "対象")
        self.channels = {self.panel.id: self.panel, self.log.id: self.log}

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    def get_member(self, user_id):
        return self.member if user_id == self.member.id else None


class WarningTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        warnings.reset_cache()
        warnings._entries = KVStore(
            "server_assist_warnings",
            client=self.db,
            path=os.path.join(self.tmp.name, "warnings.json"),
        )
        warnings.WARN_COOLDOWN = 0.0

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("warnings", keys)

    def test_defaults(self):
        self.assertEqual(
            warnings.settings(1),
            {"enabled": False, "panel_channel_id": None, "log_channel_id": None, "mod_role_id": None},
        )

    def test_can_warn(self):
        manager = FakeUser(manage_guild=True)
        self.assertTrue(warnings.can_warn(types.SimpleNamespace(user=manager, guild_id=1)))
        role_user = FakeUser(manage_guild=False, roles=[FakeRole(5)])
        self.assertFalse(warnings.can_warn(types.SimpleNamespace(user=role_user, guild_id=1)))

    async def test_mod_role_can_warn(self):
        await warnings.update_settings(1, warnings.KEY, mod_role_id=5)
        role_user = FakeUser(manage_guild=False, roles=[FakeRole(5)])
        self.assertTrue(warnings.can_warn(types.SimpleNamespace(user=role_user, guild_id=1)))

    async def test_panel_select_opens_modal_or_rejects(self):
        await warnings.update_settings(1, warnings.KEY, mod_role_id=5)
        guild = FakeGuild()
        select = warnings.WarningMemberSelect(None)
        select._values = [guild.member]
        allowed = types.SimpleNamespace(
            user=FakeUser(manage_guild=False, roles=[FakeRole(5)]),
            guild_id=1,
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await select.callback(allowed)
        allowed.response.send_modal.assert_awaited_once()

        denied = types.SimpleNamespace(
            user=FakeUser(manage_guild=False),
            guild_id=1,
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await select.callback(denied)
        denied.response.send_message.assert_awaited_once()
        denied.response.send_modal.assert_not_awaited()

    async def test_modal_records_logs_and_dms(self):
        await warnings.update_settings(
            1, warnings.KEY, enabled=True, panel_channel_id=100, log_channel_id=101,
        )
        guild = FakeGuild()
        modal = warnings.WarningReasonModal(None, 1, 2, "対象")
        modal.reason_input._value = "荒らし"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        entry = (await warnings._cache_data())["1:2"]
        self.assertEqual(entry["total"], 1)
        self.assertEqual(entry["warnings"][0]["reason"], "荒らし")
        guild.log.send.assert_awaited_once()
        guild.member.send.assert_awaited_once()
        interaction.followup.send.assert_awaited_once()

    async def test_dm_failure_does_not_block_recording(self):
        await warnings.update_settings(
            1, warnings.KEY, enabled=True, panel_channel_id=100, log_channel_id=101,
        )
        guild = FakeGuild()
        guild.member.send = AsyncMock(side_effect=RuntimeError("dm closed"))
        modal = warnings.WarningReasonModal(None, 1, 2, "対象")
        modal.reason_input._value = "理由"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        self.assertEqual((await warnings._cache_data())["1:2"]["total"], 1)
        guild.log.send.assert_awaited_once()
        self.assertIn("DMは送れませんでした", interaction.followup.send.await_args.args[0])

    async def test_concurrent_warnings_are_not_lost(self):
        await warnings.update_settings(1, warnings.KEY, enabled=True, panel_channel_id=100)
        guild = FakeGuild()
        first = warnings.WarningReasonModal(None, 1, 2, "対象")
        first.reason_input._value = "1回目"
        second = warnings.WarningReasonModal(None, 1, 2, "対象")
        second.reason_input._value = "2回目"

        def interaction(user_id):
            return types.SimpleNamespace(
                guild=guild, guild_id=1, user=FakeUser(user_id),
                client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
                response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )

        await asyncio.gather(first.on_submit(interaction(1)), second.on_submit(interaction(3)))
        entry = (await warnings._cache_data())["1:2"]
        self.assertEqual(entry["total"], 2)
        self.assertEqual(len(entry["warnings"]), 2)

    async def test_settings_view_and_panel_send(self):
        await warnings.update_settings(1, warnings.KEY, enabled=True, panel_channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = warnings.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children
                 if isinstance(item, (discord.ui.Select, discord.ui.ChannelSelect))]),
            3,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("警告", labels)
        self.assertIn("パネルを送信", labels)
        panel = next(item for item in view.children if getattr(item, "label", None) == "パネルを送信")
        interaction = types.SimpleNamespace(
            guild=guild,
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await panel.callback(interaction)
        guild.panel.send.assert_awaited_once()
        interaction.response.defer.assert_awaited_once()
        interaction.followup.send.assert_awaited_once()

    async def test_warning_cooldown_rejects_rapid_repeat(self):
        warnings.WARN_COOLDOWN = 100.0
        await warnings.update_settings(
            1, warnings.KEY, enabled=True, panel_channel_id=100, log_channel_id=101,
        )
        guild = FakeGuild()
        modal = warnings.WarningReasonModal(None, 1, 2, "対象")
        modal.reason_input._value = "理由"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            client=types.SimpleNamespace(fetch_user=AsyncMock(return_value=guild.member)),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual((await warnings._cache_data())["1:2"]["total"], 1)

    def test_register_views(self):
        add_view = MagicMock()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(add_view=add_view))
        warnings.register_views(cog)
        self.assertEqual(add_view.call_count, 1)


if __name__ == "__main__":
    unittest.main()

