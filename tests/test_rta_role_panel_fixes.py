from __future__ import annotations

import types
import unittest
from unittest.mock import AsyncMock

import discord

from cogs.sokunuke_rta import SokuNukeRta
from cogs.support import RolePanelSendButton, RolePanelUserView


class FakeSettingsStore:
    def __init__(self, value=None):
        self.value = value or {}

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return self.value


class FakeVoiceChannel:
    def __init__(self):
        self.connect = AsyncMock()
        self.voice_states = {}


class FakeGuild:
    def __init__(self, voice_client):
        self.id = 1
        self.voice_client = voice_client
        self.voice_channels = []
        self.stage_channels = []
        self.channel = FakeVoiceChannel()

    def get_role(self, role_id):
        return types.SimpleNamespace(
            id=role_id,
            name="通知ロール",
            mention=f"<@&{role_id}>",
            managed=False,
            is_default=lambda: False,
        )

    def get_channel(self, channel_id):
        return self.channel


class SokuNukeRtaFixTest(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_voice_client_does_not_block_auto_join(self):
        import cogs.sokunuke_rta as module

        store = FakeSettingsStore()
        old_store = module.guild_settings.get_store
        module.guild_settings.get_store = lambda: store
        self.addCleanup(setattr, module.guild_settings, "get_store", old_store)

        voice_client = types.SimpleNamespace(is_connected=lambda: False)
        guild = FakeGuild(voice_client)
        member = types.SimpleNamespace(id=2, bot=False, guild=guild)
        state = types.SimpleNamespace(channel=guild.channel, member=member)
        guild.channel.voice_states[member.id] = state
        guild.voice_channels.append(guild.channel)

        await SokuNukeRta(types.SimpleNamespace()).on_voice_state_update(
            member,
            types.SimpleNamespace(channel=None),
            types.SimpleNamespace(channel=guild.channel),
        )

        guild.channel.connect.assert_awaited_once_with(self_deaf=True)

    async def test_leaderboard_disables_mentions(self):
        import cogs.sokunuke_rta as module

        store = FakeSettingsStore({"records": [{"user_id": "2", "elapsed": 1.5}]})
        old_store = module.guild_settings.get_store
        module.guild_settings.get_store = lambda: store
        self.addCleanup(setattr, module.guild_settings, "get_store", old_store)

        followup = types.SimpleNamespace(send=AsyncMock())
        interaction = types.SimpleNamespace(
            guild_id=1,
            user=types.SimpleNamespace(id=2),
            followup=followup,
        )
        await SokuNukeRta(types.SimpleNamespace()).leaderboard(interaction)

        allowed = followup.send.await_args.kwargs["allowed_mentions"]
        self.assertFalse(allowed.users)
        self.assertFalse(allowed.roles)
        self.assertFalse(allowed.everyone)


class RolePanelMentionFixTest(unittest.IsolatedAsyncioTestCase):
    async def test_panel_send_disables_role_mentions(self):
        channel = types.SimpleNamespace(send=AsyncMock())
        channel.mention = "<#10>"
        guild = FakeGuild(None)
        guild.channel = channel
        parent = types.SimpleNamespace(
            settings={"enabled": True, "roles": [10]},
            panel_channel_id=10,
            can_manage=lambda interaction: True,
        )
        button = RolePanelSendButton(parent)
        interaction = types.SimpleNamespace(
            guild=guild,
            response=types.SimpleNamespace(defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )

        await button.callback(interaction)

        allowed = channel.send.await_args.kwargs["allowed_mentions"]
        self.assertFalse(allowed.users)
        self.assertFalse(allowed.roles)
        self.assertFalse(allowed.everyone)
        self.assertIsInstance(channel.send.await_args.kwargs["view"], RolePanelUserView)
