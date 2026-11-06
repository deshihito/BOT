"""Tests for Discord Scheduled Events sync in the events feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core import guild_settings
from core.storage import KVStore
from core.support.server_assist.features import events
from tests.fake_kv_supabase import FakeKVSupabase

JST = events.JST
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=JST)


class FakeScheduledEvent:
    def __init__(self, event_id=777):
        self.id = event_id
        self.delete = AsyncMock()
        self.edit = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1
        self.scheduled = FakeScheduledEvent()
        self.create_scheduled_event = AsyncMock(return_value=self.scheduled)
        self.fetch_scheduled_event = AsyncMock(return_value=self.scheduled)


def entry(**overrides):
    data = {
        "id": "ev-1", "guild_id": 1, "channel_id": 100, "author_id": 1,
        "author_name": "あおい", "title": "雑談会", "description": "集まりましょう",
        "when_text": "10月30日 20:00", "location": "VC雑談",
        "yes": [], "no": [], "maybe": [], "status": "open",
    }
    data.update(overrides)
    return data


class ParseStartTimeTest(unittest.TestCase):
    def test_full_date(self):
        self.assertEqual(
            events.parse_start_time("2027/01/15 20:00", NOW),
            datetime(2027, 1, 15, 20, 0, tzinfo=JST),
        )

    def test_short_date_this_year(self):
        self.assertEqual(
            events.parse_start_time("10/30 20:00", NOW),
            datetime(2026, 10, 30, 20, 0, tzinfo=JST),
        )

    def test_japanese_date_rolls_to_next_year(self):
        self.assertEqual(
            events.parse_start_time("1月15日 20:00", NOW),
            datetime(2027, 1, 15, 20, 0, tzinfo=JST),
        )

    def test_past_full_date_is_none(self):
        self.assertIsNone(events.parse_start_time("2020/01/01 10:00", NOW))

    def test_unparseable_is_none(self):
        self.assertIsNone(events.parse_start_time("来週の金曜あたり", NOW))
        self.assertIsNone(events.parse_start_time("", NOW))
        self.assertIsNone(events.parse_start_time(None, NOW))


class SyncTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)
        events.reset_cache()
        events._entries = KVStore(
            "server_assist_events",
            client=self.db,
            path=os.path.join(self.tmp.name, "events.json"),
        )

    async def test_sync_create_passes_schedule(self):
        guild = FakeGuild()
        future_text = (datetime.now(JST) + timedelta(days=3)).strftime("%Y/%m/%d 20:00")
        scheduled_id = await events._sync_create(guild, entry(when_text=future_text))
        self.assertEqual(scheduled_id, 777)
        kwargs = guild.create_scheduled_event.await_args.kwargs
        self.assertEqual(kwargs["name"], "雑談会")
        self.assertEqual(kwargs["location"], "VC雑談")
        self.assertEqual(kwargs["entity_type"], discord.EntityType.external)
        self.assertEqual(kwargs["end_time"] - kwargs["start_time"], timedelta(hours=2))

    async def test_sync_create_skips_unparseable_date(self):
        guild = FakeGuild()
        self.assertIsNone(await events._sync_create(guild, entry(when_text="未定")))
        guild.create_scheduled_event.assert_not_awaited()

    async def test_sync_create_failure_returns_none(self):
        guild = FakeGuild()
        guild.create_scheduled_event = AsyncMock(side_effect=discord.HTTPException(
            types.SimpleNamespace(status=400, reason="Bad Request"), "bad"))
        future_text = (datetime.now(JST) + timedelta(days=3)).strftime("%Y/%m/%d 20:00")
        self.assertIsNone(await events._sync_create(guild, entry(when_text=future_text)))

    async def test_sync_delete_removes_event(self):
        guild = FakeGuild()
        await events._sync_delete(guild, entry(scheduled_event_id=777))
        guild.fetch_scheduled_event.assert_awaited_once_with(777)
        guild.scheduled.delete.assert_awaited_once()

    async def test_sync_delete_noop_without_id(self):
        guild = FakeGuild()
        await events._sync_delete(guild, entry())
        guild.fetch_scheduled_event.assert_not_awaited()

    async def test_sync_delete_cancels_when_delete_forbidden(self):
        guild = FakeGuild()
        guild.scheduled.delete = AsyncMock(side_effect=discord.HTTPException(
            types.SimpleNamespace(status=403, reason="Forbidden"), "no"))
        await events._sync_delete(guild, entry(scheduled_event_id=777))
        guild.scheduled.edit.assert_awaited_once()
        self.assertEqual(
            guild.scheduled.edit.await_args.kwargs["status"],
            discord.EventStatus.canceled,
        )


if __name__ == "__main__":
    unittest.main()
