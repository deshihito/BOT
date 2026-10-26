"""Regression coverage for every server-assist settings toggle through the V2 wrapper."""
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
from core.panel_v2 import as_panel_v2
from core.server_assist.features import (
    automod,
    autorole,
    invites,
    leveling,
    reactionroles,
    serverlog,
    starboard,
    stats,
    stickyroles,
    suggestions,
    tempvoice,
    timed,
    welcome,
)
from core.storage import KVStore
from tests.fake_kv_supabase import FakeKVSupabase


class FakeRole:
    def __init__(self, role_id, name="role", *, position=10, managed=False, default=False):
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


class FakeChannel:
    def __init__(self, channel_id, name, *, guild=None):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.guild = guild
        self.members = []
        self.type = "text"
        self.send = AsyncMock()
        self.edit = AsyncMock()
        self.delete = AsyncMock()
        self.set_permissions = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(
            send_messages=True, manage_messages=True, manage_channels=True,
            connect=True, attach_files=True, view_channel=True,
        )

    def overwrites_for(self, target):
        return discord.PermissionOverwrite()

    async def fetch_message(self, message_id):
        return types.SimpleNamespace(id=message_id, edit=AsyncMock(), delete=AsyncMock())


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.name = "test"
        self.member_count = 10
        self.premium_subscription_count = 2
        self.me = types.SimpleNamespace(
            id=999,
            top_role=FakeRole(999, position=999),
            guild_permissions=types.SimpleNamespace(moderate_members=True),
        )
        self.normal = FakeRole(10, "normal")
        self.reaction = FakeRole(50, "reaction")
        self.default_role = FakeRole(1, "everyone", default=True)
        self.roles = [self.default_role, self.normal, self.reaction]
        self.text = FakeChannel(100, "text", guild=self)
        self.voice = FakeChannel(30, "voice", guild=self)
        self.join = FakeChannel(10, "join", guild=self)
        self.text_channels = [self.text]
        self.voice_channels = [self.join, self.voice]
        self.members = [types.SimpleNamespace(status=discord.Status.online, bot=False)]

    def get_channel(self, channel_id):
        for channel in self.text_channels + self.voice_channels:
            if channel.id == channel_id:
                return channel
        return None

    def get_role(self, role_id):
        return next((role for role in self.roles if role.id == role_id), None)

    def get_member(self, user_id):
        return types.SimpleNamespace(id=user_id, bot=False)


class AssistPanelRefreshRegressionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        self.guild = FakeGuild()
        self.cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: self.guild))

    def interaction(self):
        return types.SimpleNamespace(
            guild=self.guild,
            guild_id=1,
            user=types.SimpleNamespace(
                id=1,
                guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True, manage_roles=True),
                top_role=FakeRole(999, position=999),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                edit_message=AsyncMock(),
                send_message=AsyncMock(),
            ),
        )

    async def invoke_toggle(self, feature, label):
        panel = feature.build_view(self.cog, self.guild.id)
        wrapped = as_panel_v2(panel)
        button = next(
            item
            for row in wrapped.children[0].children
            for item in getattr(row, "children", [])
            if getattr(item, "label", None) == label
        )
        interaction = self.interaction()
        await button.callback(interaction)
        interaction.response.edit_message.assert_awaited_once()

    async def test_all_feature_toggles_survive_v2_wrapper(self):
        await tempvoice.update_settings(1, tempvoice.KEY, join_channel_id=10)
        await suggestions.update_settings(1, suggestions.KEY, channel_id=100)
        await serverlog.update_settings(1, serverlog.KEY, channel_id=100)
        await stats.update_settings(1, stats.KEY, member_channel_id=30)
        await timed.update_settings(1, timed.KEY, channel_id=100)
        await invites.update_settings(1, invites.KEY, channel_id=100)
        await reactionroles.update_settings(
            1, reactionroles.KEY,
            channel_id=100, message_id=500, mappings={"🎮": 50},
        )
        cases = [
            (welcome, "参加メッセージ"),
            (autorole, "自動ロール"),
            (starboard, "Starboard"),
            (leveling, "レベル報酬"),
            (tempvoice, "一時VC"),
            (suggestions, "提案箱"),
            (automod, "AutoMod"),
            (serverlog, "サーバーログ"),
            (stats, "サーバースタッツ"),
            (timed, "タイマー告知"),
            (invites, "招待トラッカー"),
            (reactionroles, "リアクションロール"),
            (stickyroles, "ロール復元"),
        ]
        for feature, label in cases:
            with self.subTest(feature=feature.KEY):
                await self.invoke_toggle(feature, label)


if __name__ == "__main__":
    unittest.main()
