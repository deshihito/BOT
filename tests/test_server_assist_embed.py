"""Tests for the embed builder server-assist feature."""
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
from core.server_assist.features import embedbuilder
from tests.fake_kv_supabase import FakeKVSupabase


class FakeUser:
    def __init__(self, user_id=1):
        self.id = user_id
        self.display_name = "あおい"
        self.name = "あおい"
        self.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=True)


class FakeMessage:
    def __init__(self, message_id=500):
        self.id = message_id


class FakeChannel:
    def __init__(self, channel_id=100, name="お知らせ"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock(return_value=FakeMessage())

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class EmbedBuilderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        embedbuilder.CREATE_COOLDOWN = 0.0
        embedbuilder.POST_COOLDOWN = 0.0
        embedbuilder._last_create.clear()
        embedbuilder._last_post.clear()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("embed", keys)

    def test_defaults(self):
        self.assertEqual(embedbuilder.settings(1), {"enabled": False, "channel_id": None})

    def test_parse_color(self):
        self.assertIsNone(embedbuilder.parse_color(""))
        self.assertEqual(embedbuilder.parse_color("#5865F2"), 0x5865F2)
        self.assertEqual(embedbuilder.parse_color("5865f2"), 0x5865F2)
        with self.assertRaises(ValueError):
            embedbuilder.parse_color("blue")

    async def test_modal_posts_embed(self):
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        modal = embedbuilder.EmbedCreateModal(1)
        modal.title_input._value = "お知らせ"
        modal.body_input._value = "本文です"
        modal.color_input._value = "#5865F2"
        modal.footer_input._value = "フッター"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        guild.channel.send.assert_awaited_once()
        embed = guild.channel.send.await_args.kwargs["embed"]
        self.assertEqual(embed.title, "お知らせ")
        self.assertEqual(embed.description, "本文です")
        self.assertEqual(embed.color.value, 0x5865F2)
        self.assertEqual(embed.footer.text, "フッター")
        interaction.response.defer.assert_awaited_once()

    async def test_invalid_color_is_rejected(self):
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        modal = embedbuilder.EmbedCreateModal(1)
        modal.title_input._value = "お知らせ"
        modal.body_input._value = "本文"
        modal.color_input._value = "blue"
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        guild.channel.send.assert_not_awaited()

    async def test_settings_view_and_create_button(self):
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = embedbuilder.build_view(cog, 1)
        self.assertEqual(
            len([item for item in view.children
                 if isinstance(item, (discord.ui.Select, discord.ui.ChannelSelect))]),
            1,
        )
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("埋め込みビルダー", labels)
        self.assertIn("埋め込みを作成", labels)
        self.assertIn("サーバーアシストへ戻る", labels)
        create = next(item for item in view.children if getattr(item, "label", None) == "埋め込みを作成")
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1,
            user=FakeUser(),
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await create.callback(interaction)
        interaction.response.send_modal.assert_awaited_once()

    async def test_create_button_requires_enabled_state(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = embedbuilder.build_view(cog, 1)
        create = next(item for item in view.children if getattr(item, "label", None) == "埋め込みを作成")
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1,
            user=FakeUser(),
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await create.callback(interaction)
        interaction.response.send_message.assert_awaited_once()
        interaction.response.send_modal.assert_not_awaited()

    async def test_modal_rejects_non_manager(self):
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        modal = embedbuilder.EmbedCreateModal(1)
        modal.title_input._value = "タイトル"
        modal.body_input._value = "本文"
        user = FakeUser()
        user.guild_permissions = types.SimpleNamespace(administrator=False, manage_guild=False)
        interaction = types.SimpleNamespace(
            guild=guild, guild_id=1, user=user,
            response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        await modal.on_submit(interaction)
        interaction.response.send_message.assert_awaited_once()
        guild.channel.send.assert_not_awaited()

    async def test_create_cooldown_rejects_rapid_repeat(self):
        embedbuilder.CREATE_COOLDOWN = 100.0
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        first = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        second = types.SimpleNamespace(
            guild=guild, guild_id=1, user=FakeUser(),
            response=types.SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock()),
        )
        await embedbuilder.handle_create(first)
        await embedbuilder.handle_create(second)
        first.response.send_modal.assert_awaited_once()
        second.response.send_message.assert_awaited_once()

    async def test_embed_total_length_limit(self):
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()

        def interaction():
            return types.SimpleNamespace(
                guild=guild, guild_id=1, user=FakeUser(),
                response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )

        too_long = embedbuilder.EmbedCreateModal(1)
        too_long.title_input._value = "a" * 256
        too_long.body_input._value = "b" * 4000
        too_long.footer_input._value = "c" * 1745
        rejected = interaction()
        await too_long.on_submit(rejected)
        rejected.response.send_message.assert_awaited_once()
        self.assertIn("6000", rejected.response.send_message.await_args.args[0])
        guild.channel.send.assert_not_awaited()

        exactly = embedbuilder.EmbedCreateModal(1)
        exactly.title_input._value = "a" * 256
        exactly.body_input._value = "b" * 4000
        exactly.footer_input._value = "c" * 1744
        accepted = interaction()
        await exactly.on_submit(accepted)
        guild.channel.send.assert_awaited_once()

    async def test_submit_cooldown_rejects_two_open_modals(self):
        embedbuilder.POST_COOLDOWN = 100.0
        await embedbuilder.update_settings(1, embedbuilder.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()

        def modal():
            item = embedbuilder.EmbedCreateModal(1)
            item.title_input._value = "タイトル"
            item.body_input._value = "本文"
            return item

        def interaction():
            return types.SimpleNamespace(
                guild=guild, guild_id=1, user=FakeUser(),
                response=types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                followup=types.SimpleNamespace(send=AsyncMock()),
            )

        first = interaction()
        second = interaction()
        await modal().on_submit(first)
        await modal().on_submit(second)
        guild.channel.send.assert_awaited_once()
        second.response.send_message.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()

