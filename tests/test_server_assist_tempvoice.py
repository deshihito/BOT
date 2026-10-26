"""Tests for temporary voice channels."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import tempvoice
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id=1):
        self.id = role_id
        self.mention = f"<@&{role_id}>"


class FakeMessage:
    def __init__(self, message_id=900):
        self.id = message_id
        self.edit = AsyncMock()
        self.delete = AsyncMock()


class FakeChannel:
    def __init__(self, channel_id, name, *, members=None, user_limit=0):
        self.id = channel_id
        self.name = name
        self.category = None
        self.members = list(members or [])
        self.user_limit = user_limit
        self.mention = f"<#{channel_id}>"
        self.panel = FakeMessage(900 + channel_id)
        self.send = AsyncMock(return_value=self.panel)
        self.fetch_message = AsyncMock(return_value=self.panel)
        self.edit = AsyncMock()
        self.delete = AsyncMock()
        self.set_permissions = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(connect=True, send_messages=True, manage_channels=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "テストサーバー"
        self.me = types.SimpleNamespace(id=999)
        self.default_role = FakeRole()
        self.join = FakeChannel(10, "VCを作る")
        self.temp = FakeChannel(20, "あおいのVC", members=[])
        self.channels = {10: self.join, 20: self.temp}
        self.voice_channels = [self.join]
        self.create_voice_channel = AsyncMock(return_value=self.temp)

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)


class FakeMember:
    def __init__(self, guild, member_id=1, *, bot=False):
        self.guild = guild
        self.id = member_id
        self.bot = bot
        self.display_name = "あおい"
        self.name = "aoi"
        self.roles = []
        self.move_to = AsyncMock()


class TempVoiceSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        tempvoice.reset_cache()
        tempvoice._entries = KVStore(
            "server_assist_tempvoice",
            client=self.db,
            path=os.path.join(self.tmp.name, "tempvoice.json"),
        )

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("tempvoice", keys)

    def test_defaults(self):
        self.assertEqual(
            tempvoice.settings(1),
            {
                "enabled": False,
                "join_channel_id": None,
                "name_template": "{user}のVC",
                "user_limit": 0,
            },
        )

    def make_cog(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        return cog, guild

    async def test_join_creates_temp_channel_and_panel(self):
        await tempvoice.update_settings(1, tempvoice.KEY, enabled=True, join_channel_id=10)
        cog, guild = self.make_cog()
        member = FakeMember(guild)
        before = types.SimpleNamespace(channel=None)
        after = types.SimpleNamespace(channel=guild.join)
        await tempvoice.on_voice_state_update(cog, member, before, after)
        guild.create_voice_channel.assert_awaited_once()
        self.assertEqual(guild.create_voice_channel.await_args.args[0], "あおいのVC")
        member.move_to.assert_awaited_once_with(guild.temp, reason="TempVoice")
        guild.temp.send.assert_awaited_once()
        entry = (await tempvoice._entries_cache())["20"]
        self.assertEqual(entry["owner_id"], 1)
        self.assertEqual(entry["panel_id"], guild.temp.panel.id)

    async def test_existing_owner_is_moved_without_new_channel(self):
        await tempvoice.update_settings(1, tempvoice.KEY, enabled=True, join_channel_id=10)
        cog, guild = self.make_cog()
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        member = FakeMember(guild)
        before = types.SimpleNamespace(channel=None)
        after = types.SimpleNamespace(channel=guild.join)
        await tempvoice.on_voice_state_update(cog, member, before, after)
        guild.create_voice_channel.assert_not_awaited()
        member.move_to.assert_awaited_once_with(guild.temp, reason="TempVoice existing")

    async def test_empty_temp_channel_is_deleted(self):
        await tempvoice.update_settings(1, tempvoice.KEY, enabled=True, join_channel_id=10)
        cog, guild = self.make_cog()
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        member = FakeMember(guild)
        before = types.SimpleNamespace(channel=guild.temp)
        after = types.SimpleNamespace(channel=None)
        await tempvoice.on_voice_state_update(cog, member, before, after)
        guild.temp.delete.assert_awaited_once()
        self.assertNotIn("20", await tempvoice._entries_cache())

    async def test_non_empty_temp_channel_is_kept(self):
        await tempvoice.update_settings(1, tempvoice.KEY, enabled=True, join_channel_id=10)
        cog, guild = self.make_cog()
        guild.temp.members = [FakeMember(guild, 2)]
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        before = types.SimpleNamespace(channel=guild.temp)
        after = types.SimpleNamespace(channel=None)
        await tempvoice.on_voice_state_update(cog, FakeMember(guild), before, after)
        guild.temp.delete.assert_not_awaited()
        self.assertIn("20", await tempvoice._entries_cache())

    async def test_owner_can_lock(self):
        cog, guild = self.make_cog()
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            channel_id=20,
            user=types.SimpleNamespace(id=1, guild_permissions=types.SimpleNamespace(administrator=False, manage_channels=False)),
            response=types.SimpleNamespace(send_message=AsyncMock(), send_modal=AsyncMock()),
        )
        await tempvoice.handle_action(cog, interaction, "lock")
        guild.temp.set_permissions.assert_awaited_once()
        self.assertFalse(guild.temp.set_permissions.await_args.kwargs["connect"])
        interaction.response.send_message.assert_awaited_once()

    async def test_other_member_without_permission_is_denied(self):
        cog, guild = self.make_cog()
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            channel_id=20,
            user=types.SimpleNamespace(id=2, guild_permissions=types.SimpleNamespace(administrator=False, manage_channels=False)),
            response=types.SimpleNamespace(send_message=AsyncMock(), send_modal=AsyncMock()),
        )
        await tempvoice.handle_action(cog, interaction, "delete")
        guild.temp.delete.assert_not_awaited()
        self.assertIn("20", await tempvoice._entries_cache())

    async def test_delete_action_removes_channel_and_entry(self):
        cog, guild = self.make_cog()
        await tempvoice._put_entry(20, {"channel_id": 20, "guild_id": 1, "owner_id": 1, "panel_id": 900})
        interaction = types.SimpleNamespace(
            guild=guild,
            guild_id=1,
            channel_id=20,
            user=types.SimpleNamespace(id=1, guild_permissions=types.SimpleNamespace(administrator=False, manage_channels=False)),
            response=types.SimpleNamespace(send_message=AsyncMock(), send_modal=AsyncMock()),
        )
        await tempvoice.handle_action(cog, interaction, "delete")
        guild.temp.delete.assert_awaited_once()
        self.assertNotIn("20", await tempvoice._entries_cache())

    def test_control_view_and_settings_view(self):
        cog, guild = self.make_cog()
        view = tempvoice.TempVoiceControlView(cog)
        self.assertEqual(len(view.children), 5)
        self.assertEqual(
            [item.custom_id for item in view.children],
            [
                "assist:tempvoice:rename",
                "assist:tempvoice:limit",
                "assist:tempvoice:lock",
                "assist:tempvoice:unlock",
                "assist:tempvoice:delete",
            ],
        )
        settings_view = tempvoice.build_view(cog, guild.id)
        self.assertEqual(len([item for item in settings_view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in settings_view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("一時VC", labels)
        self.assertIn("名前テンプレート", labels)
        self.assertIn("既定の人数上限", labels)
        self.assertIn("サーバーアシストへ戻る", labels)

    def test_register_views(self):
        add_view = MagicMock()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(add_view=add_view))
        tempvoice.register_views(cog)
        add_view.assert_called_once()


if __name__ == "__main__":
    unittest.main()
