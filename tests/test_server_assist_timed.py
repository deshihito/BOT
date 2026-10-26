"""Tests for scheduled announcements."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.server_assist import discover_features
from core.server_assist.features import timed
from tests.fake_kv_supabase import FakeKVSupabase


class FakeChannel:
    def __init__(self, channel_id=100, name="告知"):
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

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class TimedSettingsTest(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn("timed", keys)

    def test_defaults(self):
        self.assertEqual(
            timed.settings(1),
            {"enabled": False, "channel_id": None, "schedules": []},
        )

    def test_parse_time(self):
        self.assertEqual(timed.parse_time("9:05"), (9, 5))
        self.assertEqual(timed.parse_time("23:59"), (23, 59))
        self.assertIsNone(timed.parse_time("24:00"))
        self.assertIsNone(timed.parse_time("noon"))

    def test_due_schedules(self):
        current = {
            "schedules": [
                {"id": "a", "time": "12:00", "message": "x", "last_sent": ""},
                {"id": "b", "time": "12:00", "message": "y", "last_sent": "2026-10-26"},
                {"id": "c", "time": "12:01", "message": "z", "last_sent": ""},
            ]
        }
        now = datetime(2026, 10, 26, 12, 0)
        self.assertEqual([item["id"] for item in timed.due_schedules(current, now)], ["a"])
        self.assertEqual(
            [item["id"] for item in timed.due_schedules(current, datetime(2026, 10, 26, 12, 2))],
            ["a", "c"],
        )
        self.assertEqual(
            [item["id"] for item in timed.due_schedules(current, datetime(2026, 10, 27, 0, 0))],
            [],
        )

    async def test_send_due_marks_last_sent(self):
        now = datetime(2026, 10, 26, 12, 0)
        await timed.update_settings(
            1, timed.KEY, enabled=True, channel_id=100,
            schedules=[{"id": "a", "time": "12:00", "message": "告知です", "last_sent": ""}],
        )
        guild = FakeGuild()
        await timed.send_due(guild, timed.settings(1), now)
        guild.channel.send.assert_awaited_once()
        schedule = timed.settings(1)["schedules"][0]
        self.assertEqual(schedule["last_sent"], "2026-10-26")

    async def test_modal_adds_schedule(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = timed.build_view(cog, 1)
        modal = timed.TimedModal(view)
        modal.time_input._value = "20:00"
        modal.message_input._value = "夜の告知"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                edit_message=AsyncMock(),
            ),
            guild=guild,
            guild_id=1,
        )
        await modal.on_submit(interaction)
        schedules = timed.settings(1)["schedules"]
        self.assertEqual(len(schedules), 1)
        self.assertEqual(schedules[0]["time"], "20:00")

    async def test_stale_modal_does_not_rewind_last_sent(self):
        await timed.update_settings(
            1, timed.KEY, enabled=True, channel_id=100,
            schedules=[{"id": "a", "time": "12:00", "message": "old", "last_sent": ""}],
        )
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        stale_view = timed.build_view(cog, 1)
        await timed.update_settings(
            1, timed.KEY,
            schedules=[{"id": "a", "time": "12:00", "message": "old", "last_sent": "2026-10-26"}],
        )
        modal = timed.TimedModal(stale_view, stale_view.settings["schedules"][0])
        modal.message_input._value = "new"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=1, guild_permissions=types.SimpleNamespace(administrator=True, manage_guild=True),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
            guild=guild,
            guild_id=1,
        )
        await modal.on_submit(interaction)
        self.assertEqual(timed.settings(1)["schedules"][0]["last_sent"], "2026-10-26")

    async def test_send_due_preserves_concurrent_message_edit(self):
        await timed.update_settings(
            1, timed.KEY, enabled=True, channel_id=100,
            schedules=[{"id": "a", "time": "12:00", "message": "old", "last_sent": ""}],
        )
        guild = FakeGuild()

        async def send_side_effect(**kwargs):
            await timed.update_settings(
                1, timed.KEY,
                schedules=[{"id": "a", "time": "12:00", "message": "new", "last_sent": ""}],
            )

        guild.channel.send.side_effect = send_side_effect
        await timed.send_due(guild, timed.settings(1), datetime(2026, 10, 26, 12, 0))
        schedule = timed.settings(1)["schedules"][0]
        self.assertEqual(schedule["message"], "new")
        self.assertEqual(schedule["last_sent"], "2026-10-26")

    def test_settings_view_controls(self):
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = timed.build_view(cog, guild.id)
        self.assertEqual(len([item for item in view.children if isinstance(item, discord.ui.Select)]), 2)
        labels = {item.label for item in view.children if isinstance(item, discord.ui.Button)}
        self.assertIn("告知を追加", labels)
        self.assertIn("編集", labels)
        self.assertIn("削除", labels)
        self.assertIn("タイマー告知", labels)
        self.assertIn("サーバーアシストへ戻る", labels)


if __name__ == "__main__":
    unittest.main()
