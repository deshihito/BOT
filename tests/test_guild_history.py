"""導入履歴（guild_history）と直近導入数の集計のテスト。"""
from __future__ import annotations

import datetime
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.guild_registry import GuildRegistry, count_recent_joins


class FakeKV:
    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.set_calls = []

    async def load_all(self):
        return dict(self.rows)

    async def set(self, key, value, *, wait=True):
        self.set_calls.append((key, value))
        self.rows[str(key)] = value

    async def delete(self, key, *, wait=True):
        self.rows.pop(str(key), None)


def fake_guild(guild_id, name="サーバー", member_count=42):
    return types.SimpleNamespace(id=guild_id, name=name, member_count=member_count, icon=None)


class GuildHistoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_record_event_appends_joined(self):
        history = FakeKV()
        registry = GuildRegistry(FakeKV(), history)
        await registry.record_event(fake_guild(123, "テスト鯖", 7), "joined")
        self.assertEqual(len(history.set_calls), 1)
        key, value = history.set_calls[0]
        self.assertTrue(key.endswith(":123:joined"))
        self.assertEqual(value["guild_id"], "123")
        self.assertEqual(value["name"], "テスト鯖")
        self.assertEqual(value["member_count"], 7)
        self.assertEqual(value["event"], "joined")
        self.assertIn("at", value)

    async def test_record_event_removed_keeps_history(self):
        history = FakeKV()
        registry = GuildRegistry(FakeKV(), history)
        await registry.record_event(fake_guild(123), "removed")
        self.assertEqual(len(history.set_calls), 1)
        self.assertEqual(history.set_calls[0][1]["event"], "removed")

    async def test_record_event_ignores_unknown_event(self):
        history = FakeKV()
        registry = GuildRegistry(FakeKV(), history)
        await registry.record_event(fake_guild(123), "exploded")
        self.assertEqual(history.set_calls, [])

    async def test_snapshot_record_does_not_write_history(self):
        history = FakeKV()
        registry = GuildRegistry(FakeKV(), history)
        await registry.record(fake_guild(123))
        self.assertEqual(history.set_calls, [])


class CountRecentJoinsTest(unittest.TestCase):
    def test_counts_only_recent_joined(self):
        now = datetime.datetime(2026, 11, 7, tzinfo=datetime.timezone.utc)

        def at(days_ago):
            return (now - datetime.timedelta(days=days_ago)).isoformat()

        events = [
            {"event": "joined", "at": at(1)},
            {"event": "joined", "at": at(6)},
            {"event": "joined", "at": at(8)},
            {"event": "removed", "at": at(1)},
            {"event": "joined", "at": "not-a-date"},
            {"event": "joined"},
            "garbage",
        ]
        self.assertEqual(count_recent_joins(events, now=now, days=7), 2)
        self.assertEqual(count_recent_joins(events, now=now, days=30), 3)
        self.assertEqual(count_recent_joins(None, now=now, days=7), 0)


if __name__ == "__main__":
    unittest.main()
