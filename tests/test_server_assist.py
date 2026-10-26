"""Tests for the unified ProBot-style server assist hub."""
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

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features, format_template
from core.server_assist.features import welcome
from cogs.support import (
    SUPPORT_ACTIONS,
    SUPPORT_ACTIONS_BY_GENRE,
    SUPPORT_GENRES,
    SupportCog,
)
from tests.fake_kv_supabase import FakeKVSupabase


class FakeChannel:
    def __init__(self, channel_id=100, name="welcome"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self, guild_id=1):
        self.id = guild_id
        self.name = "テストサーバー"
        self.member_count = 42
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class FakeMember:
    def __init__(self, guild, *, bot=False):
        self.guild = guild
        self.id = 123
        self.display_name = "あおい"
        self.name = "aoi"
        self.mention = "<@123>"
        self.bot = bot
        self.display_avatar = types.SimpleNamespace(url="https://example.com/avatar.png")


class ServerAssistSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_welcome_feature_is_discovered(self):
        features = discover_features(refresh=True)
        self.assertIn("welcome", [feature.key for feature in features])
        feature = next(feature for feature in features if feature.key == "welcome")
        self.assertEqual(feature.label, "参加・退出メッセージ")
        self.assertEqual(feature.module_name, "core.server_assist.features.welcome")

    def test_defaults_are_disabled(self):
        settings = welcome.settings(1)
        self.assertFalse(settings["welcome_enabled"])
        self.assertFalse(settings["goodbye_enabled"])
        self.assertIsNone(settings["welcome_channel_id"])
        self.assertEqual(settings["welcome_message"], welcome.DEFAULT_WELCOME)

    async def test_settings_round_trip(self):
        await welcome.update_settings(
            1,
            welcome.KEY,
            welcome_enabled=True,
            welcome_channel_id=100,
            welcome_message="ようこそ {user}",
        )
        settings = welcome.settings(1)
        self.assertTrue(settings["welcome_enabled"])
        self.assertEqual(settings["welcome_channel_id"], 100)
        self.assertEqual(settings["welcome_message"], "ようこそ {user}")

    def test_format_template_replaces_placeholders(self):
        guild = FakeGuild()
        member = FakeMember(guild)
        text = format_template("{user} / {name} / {server} / {count} / {id}", member, guild)
        self.assertEqual(text, "<@123> / あおい / テストサーバー / 42 / 123")

    async def test_welcome_message_is_sent(self):
        await welcome.update_settings(
            1, welcome.KEY, welcome_enabled=True, welcome_channel_id=100,
            welcome_message="**{user}** さん、{server} へようこそ！",
        )
        guild = FakeGuild()
        member = FakeMember(guild)
        await welcome.on_member_join(None, member)
        guild.channel.send.assert_awaited_once()
        kwargs = guild.channel.send.await_args.kwargs
        embed = kwargs["embed"]
        self.assertEqual(embed.color.value, 0xFFFFFF)
        self.assertIn("<@123>", embed.description)
        self.assertIn("テストサーバー", embed.description)
        self.assertFalse(kwargs["allowed_mentions"].everyone)

    async def test_disabled_welcome_is_not_sent(self):
        await welcome.update_settings(1, welcome.KEY, welcome_enabled=False, welcome_channel_id=100)
        guild = FakeGuild()
        await welcome.on_member_join(None, FakeMember(guild))
        guild.channel.send.assert_not_awaited()

    async def test_bot_join_is_ignored(self):
        await welcome.update_settings(1, welcome.KEY, welcome_enabled=True, welcome_channel_id=100)
        guild = FakeGuild()
        await welcome.on_member_join(None, FakeMember(guild, bot=True))
        guild.channel.send.assert_not_awaited()

    async def test_goodbye_falls_back_to_welcome_channel(self):
        await welcome.update_settings(
            1, welcome.KEY,
            welcome_channel_id=100,
            goodbye_enabled=True,
            goodbye_channel_id=None,
            goodbye_message="{name} さんが退出しました。",
        )
        guild = FakeGuild()
        await welcome.on_member_remove(None, FakeMember(guild))
        guild.channel.send.assert_awaited_once()
        embed = guild.channel.send.await_args.kwargs["embed"]
        self.assertIn("あおい", embed.description)


class ServerAssistPanelTest(unittest.IsolatedAsyncioTestCase):
    def test_support_panel_exposes_server_assist(self):
        self.assertIn("server_assist", [choice.value for choice in SUPPORT_ACTIONS])
        self.assertIn("assist", SUPPORT_GENRES)
        self.assertEqual(
            SUPPORT_ACTIONS_BY_GENRE["assist"],
            [("サーバーアシスト設定", "server_assist")],
        )
        self.assertEqual(SupportCog.SUPPORT_REQUIRED_PERMISSIONS["server_assist"], "manage_guild")

    async def test_support_dispatch_opens_server_assist_home(self):
        assistant = types.SimpleNamespace(show_home=AsyncMock())
        bot = types.SimpleNamespace(get_cog=lambda name: assistant if name == "ServerAssistCog" else None)
        cog = SupportCog(bot)
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            guild_id=1,
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await cog.dispatch(interaction, "server_assist")
        assistant.show_home.assert_awaited_once_with(interaction)

    def test_welcome_view_has_channel_selects_and_buttons(self):
        import discord
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = welcome.build_view(cog, guild.id)
        selects = [item for item in view.children if isinstance(item, discord.ui.Select)]
        buttons = [item for item in view.children if isinstance(item, discord.ui.Button)]
        self.assertEqual(len(selects), 2)
        labels = {item.label for item in buttons}
        self.assertIn("参加メッセージ", labels)
        self.assertIn("退出メッセージ", labels)
        self.assertIn("テスト送信", labels)
        self.assertIn("サーバーアシストへ戻る", labels)

    def test_home_view_lists_discovered_features(self):
        from cogs.server_assist import AssistFeatureSelect, ServerAssistCog, ServerAssistHomeView
        cog = ServerAssistCog(types.SimpleNamespace())
        view = ServerAssistHomeView(cog)
        self.assertIn("welcome", [feature.key for feature in cog.features])
        select = next(item for item in view.children if isinstance(item, AssistFeatureSelect))
        self.assertIn("welcome", [option.value for option in select.options])
        self.assertIn("参加・退出メッセージ", [field.name for field in view.embed().fields])

    def test_views_fit_components_v2_action_row_limits(self):
        from core.panel_v2 import as_panel_v2
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        for view in (welcome.build_view(cog, guild.id),):
            wrapper = as_panel_v2(view)
            container = wrapper.children[0]
            rows = [row for row in container.children if getattr(row, "children", None)]
            self.assertLessEqual(len(rows), 5)
            for row in rows:
                self.assertLessEqual(len(row.children), 5)


if __name__ == "__main__":
    unittest.main()
