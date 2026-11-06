"""Tests for one-shot reminders in the timed feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import guild_settings
from core.storage import KVStore
from core.support.server_assist.features import timed
from tests.fake_kv_supabase import FakeKVSupabase

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


class FakeChannel:
    def __init__(self, channel_id=100):
        self.id = channel_id
        self.send = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.channel = FakeChannel()

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class ReminderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_parse_relative_time(self):
        self.assertEqual(timed.parse_relative_time("10分"), timedelta(minutes=10))
        self.assertEqual(timed.parse_relative_time("2時間"), timedelta(hours=2))
        self.assertEqual(timed.parse_relative_time("1日"), timedelta(days=1))
        self.assertEqual(timed.parse_relative_time("30m"), timedelta(minutes=30))
        self.assertEqual(timed.parse_relative_time("45"), timedelta(minutes=45))
        self.assertEqual(timed.parse_relative_time("90秒"), timedelta(seconds=90))

    def test_parse_relative_time_rejects_out_of_range(self):
        self.assertIsNone(timed.parse_relative_time("10秒"))   # 30秒未満
        self.assertIsNone(timed.parse_relative_time("31日"))
        self.assertIsNone(timed.parse_relative_time("明日"))
        self.assertIsNone(timed.parse_relative_time(""))
        self.assertIsNone(timed.parse_relative_time("-5分"))

    async def _add(self, reminder_id, due_at, message="会議", user_id=42):
        await timed.update_settings(1, timed.KEY, reminders=[{
            "id": reminder_id, "user_id": user_id, "channel_id": 100,
            "message": message, "due_at": due_at.isoformat(),
        }])

    async def test_due_reminder_is_sent_with_mention_and_removed(self):
        await self._add("a", NOW - timedelta(minutes=1))
        guild = FakeGuild()
        await timed.send_due_reminders(guild, timed.settings(1), NOW)
        guild.channel.send.assert_awaited_once()
        kwargs = guild.channel.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "<@42>")
        self.assertEqual(timed.settings(1)["reminders"], [])

    async def test_future_reminder_is_kept(self):
        await self._add("b", NOW + timedelta(hours=1))
        guild = FakeGuild()
        await timed.send_due_reminders(guild, timed.settings(1), NOW)
        guild.channel.send.assert_not_awaited()
        self.assertEqual(len(timed.settings(1)["reminders"]), 1)

    async def test_stale_reminder_is_dropped_without_sending(self):
        await self._add("c", NOW - timedelta(days=8))
        guild = FakeGuild()
        await timed.send_due_reminders(guild, timed.settings(1), NOW)
        guild.channel.send.assert_not_awaited()
        self.assertEqual(timed.settings(1)["reminders"], [])

    async def test_modal_registers_reminder(self):
        await timed.update_settings(1, timed.KEY, enabled=True, channel_id=100, schedules=[])
        guild = FakeGuild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_guild=lambda _id: guild))
        view = timed.build_view(cog, 1)
        modal = timed.ReminderModal(view)
        modal.after_input._value = "10分"
        modal.message_input._value = "10分後にお知らせ"
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=42, guild_permissions=types.SimpleNamespace(administrator=False, manage_guild=False),
            ),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock(), edit_message=AsyncMock(),
            ),
            guild=guild,
            guild_id=1,
        )
        before = datetime.now(timezone.utc)
        await modal.on_submit(interaction)
        reminders = timed.settings(1)["reminders"]
        self.assertEqual(len(reminders), 1)
        self.assertEqual(reminders[0]["user_id"], 42)
        self.assertEqual(reminders[0]["channel_id"], 100)
        due = datetime.fromisoformat(reminders[0]["due_at"])
        self.assertTrue(before + timedelta(minutes=9) < due < before + timedelta(minutes=11))

    def test_settings_normalizes_and_sorts_reminders(self):
        raw = [
            {"id": "z", "user_id": 1, "channel_id": 100, "message": "later",
             "due_at": (NOW + timedelta(hours=2)).isoformat()},
            {"id": "y", "user_id": 1, "channel_id": 100, "message": "sooner",
             "due_at": (NOW + timedelta(hours=1)).isoformat()},
            {"id": "bad", "user_id": "x", "message": "no", "due_at": "junk"},
        ]
        normalized = [timed._normalize_reminder(item) for item in raw]
        self.assertIsNotNone(normalized[0])
        self.assertIsNone(normalized[2])


if __name__ == "__main__":
    unittest.main()
