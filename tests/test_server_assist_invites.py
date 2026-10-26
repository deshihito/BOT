"""Tests for the invite tracker."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import invites
from tests.fake_kv_supabase import FakeKVSupabase


class FakeInviter:
    def __init__(self, user_id=2):
        self.id = user_id
        self.mention = f"<@{user_id}>"


class FakeInvite:
    def __init__(self, guild, code="abc", uses=0, inviter=None):
        self.guild = guild
        self.code = code
        self.uses = uses
        self.inviter = inviter or FakeInviter()


class FakeChannel:
    def __init__(self, channel_id=100, name="invite-log"):
        self.id = channel_id
        self.name = name
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock()

    def permissions_for(self, member):
        return types.SimpleNamespace(send_messages=True)


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.me = types.SimpleNamespace(id=999)
        self.channel = FakeChannel()
        self.text_channels = [self.channel]
        self.invite = FakeInvite(self, uses=0)
        self.invites = AsyncMock(return_value=[self.invite])

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class FakeMember:
    def __init__(self, guild, member_id=1):
        self.guild = guild
        self.id = member_id
        self.mention = f"<@{member_id}>"
        self.created_at = datetime.now(timezone.utc)


class InviteSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        invites.reset_cache()

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("invites", keys)

    def test_defaults(self):
        self.assertEqual(invites.settings(1), {"enabled": False, "channel_id": None})

    async def test_prime_caches_invites(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(
            bot=types.SimpleNamespace(guilds=[guild], wait_until_ready=AsyncMock()),
        )
        await invites.prime(cog)
        self.assertEqual(invites._invites["1:abc"], 0)

    async def test_join_logs_used_invite(self):
        await invites.update_settings(1, invites.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        cog = types.SimpleNamespace(
            bot=types.SimpleNamespace(guilds=[guild], wait_until_ready=AsyncMock()),
        )
        await invites.prime(cog)
        guild.invite.uses = 1
        await invites.on_member_join(cog, FakeMember(guild))
        guild.channel.send.assert_awaited_once()
        embed = guild.channel.send.await_args.kwargs["embed"]
        self.assertEqual(embed.title, "招待で参加")
        self.assertIn("<@2>", embed.fields[1].value)

    async def test_disabled_does_nothing(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(guilds=[guild]))
        await invites.on_member_join(cog, FakeMember(guild))
        guild.channel.send.assert_not_awaited()

    async def test_unprimed_join_is_logged_as_unknown(self):
        await invites.update_settings(1, invites.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        guild.invite.uses = 5
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(guilds=[guild]))
        await invites.on_member_join(cog, FakeMember(guild))
        embed = guild.channel.send.await_args.kwargs["embed"]
        self.assertIn("不明", embed.fields[1].value)
        self.assertEqual(invites._invites["1:abc"], 5)

    async def test_failed_fetch_is_not_marked_primed(self):
        await invites.update_settings(1, invites.KEY, enabled=True, channel_id=100)
        guild = FakeGuild()
        guild.invite.uses = 100
        forbidden = discord.Forbidden(
            types.SimpleNamespace(status=403, reason="Forbidden"), "no permission",
        )
        guild.invites.side_effect = [forbidden, [guild.invite], [guild.invite]]
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(guilds=[guild]))
        await invites.on_member_join(cog, FakeMember(guild))
        self.assertNotIn(1, invites._primed)
        guild.invite.uses = 101
        await invites.on_member_join(cog, FakeMember(guild))
        self.assertIn(1, invites._primed)
        guild.invite.uses = 102
        await invites.on_member_join(cog, FakeMember(guild))
        embed = guild.channel.send.await_args.kwargs["embed"]
        self.assertNotIn("不明", embed.fields[1].value)

    async def test_invite_create_and_delete_update_cache(self):
        guild = FakeGuild()
        invite = FakeInvite(guild, code="new", uses=3)
        await invites.on_invite_create(None, invite)
        self.assertEqual(invites._invites["1:new"], 3)
        await invites.on_invite_delete(None, invite)
        self.assertNotIn("1:new", invites._invites)

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = invites.build_view(cog, guild.id)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 1)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("招待トラッカー", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
