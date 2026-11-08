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

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist import discover_features, format_template
from core.support.server_assist.features import welcome
from core.support.panel_v2 import as_panel_v2
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
        self.assertEqual(feature.module_name, "core.support.server_assist.features.welcome")

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
    def test_support_panel_exposes_assist_features_in_genres(self):
        # サーバーアシスト再編: 旧ハブ（server_assist / assist ジャンル）は
        # 廃止し、各機能が既存ジャンルの一級アクションとして並ぶ。
        values = [choice.value for choice in SUPPORT_ACTIONS]
        self.assertNotIn("server_assist", values)
        self.assertNotIn("assist", SUPPORT_GENRES)
        expected_genres = {
            "assist_automod": "moderation",
            "assist_warnings": "moderation",
            "assist_applications": "moderation",
            "assist_autorole": "roles",
            "assist_leveling": "roles",
            "assist_reactionroles": "roles",
            "assist_stickyroles": "roles",
            "assist_serverlog": "logs",
            "assist_invites": "logs",
            "assist_welcome": "automation",
            "assist_tempvoice": "automation",
            "assist_timed": "automation",
        }
        for value, genre in expected_genres.items():
            self.assertIn(value, values)
            self.assertIn(value, [v for _label, v in SUPPORT_ACTIONS_BY_GENRE[genre]])
        for genre, items in SUPPORT_ACTIONS_BY_GENRE.items():
            # 機能数再編: automation は34件になり25件を超える。パネルは
            # ページング（core/support/panel.py の support_action_pages）で
            # 全件選べることが前提（tests/test_panel_warps.py が固定）。
            if genre == "automation":
                self.assertEqual(len(items), 34, genre)
            else:
                self.assertLessEqual(len(items), 25, genre)
        # 旧ハブ値の権限エントリは互換分岐（案内のみ）のために残る。
        self.assertEqual(SupportCog.SUPPORT_REQUIRED_PERMISSIONS["server_assist"], "manage_guild")

    def test_support_actions_labels_match_features(self):
        features = {feature.key: feature for feature in discover_features()}
        names = {choice.value: choice.name for choice in SUPPORT_ACTIONS}
        assist_values = [value for value in names if value.startswith("assist_")]
        # 機能数再編: assist_ には元機能への preset 入口（ASSIST_PRESET_ACTIONS）
        # も含まれる。FEATURE と一致するのは元機能分だけ。
        from core.support.entry import ASSIST_PRESET_ACTIONS

        feature_values = [value for value in assist_values if value not in ASSIST_PRESET_ACTIONS]
        self.assertEqual(len(feature_values), len(features))
        self.assertTrue(set(ASSIST_PRESET_ACTIONS) <= set(assist_values))
        for value in feature_values:
            feature = features[value.removeprefix("assist_")]
            self.assertEqual(names[value], feature.label, value)

    async def test_support_dispatch_opens_assist_feature(self):
        assistant = types.SimpleNamespace(show_feature=AsyncMock())
        bot = types.SimpleNamespace(get_cog=lambda name: assistant if name == "ServerAssistCog" else None)
        cog = SupportCog(bot)
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            guild_id=1,
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await cog.dispatch(interaction, "assist_welcome")
        assistant.show_feature.assert_awaited_once_with(interaction, "welcome")

    async def test_support_dispatch_legacy_server_assist_guides(self):
        # 保存済みショートカット等に残る旧ハブ値は、行き止まりにせず案内する。
        bot = types.SimpleNamespace(get_cog=lambda name: None)
        cog = SupportCog(bot)
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            guild_id=1,
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        await cog.dispatch(interaction, "server_assist")
        interaction.response.send_message.assert_awaited_once()
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("各ジャンルに分かれました", message)

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
        self.assertIn("サポートへ戻る", labels)

    async def test_back_button_returns_to_support_panel(self):
        # 設定画面の戻るボタンは、その機能が属するジャンルの /support
        # パネルへ戻す（旧ハブへは戻らない）。
        import discord
        guild = FakeGuild()
        cog = types.SimpleNamespace(
            bot=types.SimpleNamespace(get_guild=lambda _id: guild),
            show_panel_edit=AsyncMock(),
        )
        view = welcome.build_view(cog, guild.id)
        button = next(
            item for item in view.children
            if isinstance(item, discord.ui.Button) and item.label == "サポートへ戻る"
        )
        interaction = types.SimpleNamespace()
        await button.callback(interaction)
        cog.show_panel_edit.assert_awaited_once_with(interaction, "welcome")

    async def test_show_panel_edit_opens_feature_genre(self):
        from unittest.mock import patch

        from core.support.panel import SupportPanelView
        from core.support.server_assist.cog import ServerAssistCog

        support_cog = types.SimpleNamespace()
        bot = types.SimpleNamespace(
            get_cog=lambda name: support_cog if name == "SupportCog" else None)
        cog = ServerAssistCog(bot)
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=7,
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            guild_id=1,
            response=types.SimpleNamespace(send_message=AsyncMock()),
        )
        captured = {}

        def capture_panel(view):
            captured["view"] = view
            return view

        with patch(
            "core.support.server_assist.cog.edit_panel_v2",
            new=AsyncMock(),
        ) as edit_mock, patch(
            "core.support.server_assist.cog.as_panel_v2",
            side_effect=capture_panel,
        ):
            await cog.show_panel_edit(interaction, "welcome")
        edit_mock.assert_awaited_once()
        panel = captured["view"]
        self.assertIsInstance(panel, SupportPanelView)
        self.assertEqual(panel.genre, "automation")

    def test_views_fit_components_v2_action_row_limits(self):
        from core.support.panel_v2 import as_panel_v2
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        for view in (welcome.build_view(cog, guild.id),):
            wrapper = as_panel_v2(view)
            container = wrapper.children[0]
            rows = [row for row in container.children if getattr(row, "children", None)]
            self.assertLessEqual(len(rows), 5)
            for row in rows:
                self.assertLessEqual(len(row.children), 5)

    async def test_wrapped_welcome_toggle_refreshes_without_signature_error(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        panel = welcome.build_view(cog, guild.id)
        wrapped = as_panel_v2(panel)
        button = next(
            item
            for row in wrapped.children[0].children
            for item in getattr(row, "children", [])
            if getattr(item, "label", None) == "参加メッセージ"
        )
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=1,
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                edit_message=AsyncMock(),
                send_message=AsyncMock(),
            ),
        )
        await button.callback(interaction)
        interaction.response.edit_message.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
