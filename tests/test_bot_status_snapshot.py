"""サービスステータスのスナップショット生成（純粋部分）のテスト。

公開境界の要: スナップショットにサーバーID・サーバー名等の ID 類が
含まれないこと（件数だけを公開する）。
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.bot_status.snapshot import (
    build_history, build_snapshot, collect_snapshot)

NOW = datetime.datetime(2026, 11, 8, 12, 0, tzinfo=datetime.timezone.utc)
STARTED = datetime.datetime(2026, 11, 5, 9, 30, tzinfo=datetime.timezone.utc)


class FakeGuild:
    def __init__(self, guild_id, name, member_count):
        self.id = guild_id
        self.name = name
        self.member_count = member_count


class FakeBot:
    def __init__(self, guilds, latency):
        self.guilds = guilds
        self.latency = latency


class BuildHistoryTest(unittest.TestCase):
    def snapshot(self, guilds=3, users=1234):
        return build_snapshot(
            guild_count=guilds, member_count=users, latency_ms=42,
            started_at=STARTED, now=NOW)

    def test_first_sample_creates_today(self):
        history = build_history(None, self.snapshot(), {}, now=NOW)
        # NOW は UTC 12:00 = JST 21:00 で同日
        self.assertEqual(history["days"], {
            "2026-11-08": {"samples": 1, "guilds": 3, "users": 1234}})
        self.assertEqual(history["cmd_hours"], {})

    def test_same_day_accumulates_and_refreshes_counts(self):
        first = build_history(None, self.snapshot(), {}, now=NOW)
        second = build_history(first, self.snapshot(guilds=4, users=1300), {}, now=NOW)
        entry = second["days"]["2026-11-08"]
        self.assertEqual(entry["samples"], 2)
        self.assertEqual(entry["guilds"], 4)
        self.assertEqual(entry["users"], 1300)

    def test_prunes_days_older_than_30_and_hours_over_48(self):
        previous = {"days": {
            "2026-10-01": {"samples": 288, "guilds": 1, "users": 10},
            "2026-11-07": {"samples": 100, "guilds": 2, "users": 20},
        }}
        hours = {f"2026-11-0{1 + i // 24}T{i % 24:02d}": i for i in range(72)}
        history = build_history(previous, self.snapshot(), hours, now=NOW)
        self.assertNotIn("2026-10-01", history["days"])
        self.assertIn("2026-11-07", history["days"])
        self.assertEqual(len(history["cmd_hours"]), 48)
        self.assertEqual(max(history["cmd_hours"]), "2026-11-03T23")


class BuildSnapshotTest(unittest.TestCase):
    def test_shape(self):
        snapshot = build_snapshot(
            guild_count=3, member_count=1234, latency_ms=42,
            started_at=STARTED, now=NOW,
        )
        self.assertEqual(snapshot, {
            "updated_at": NOW.isoformat(),
            "started_at": STARTED.isoformat(),
            "guild_count": 3,
            "member_count": 1234,
            "latency_ms": 42,
        })

    def test_optional_fields_become_none(self):
        snapshot = build_snapshot(
            guild_count=0, member_count=0, latency_ms=None,
            started_at=None, now=NOW,
        )
        self.assertIsNone(snapshot["started_at"])
        self.assertIsNone(snapshot["latency_ms"])

    def test_bad_counts_are_clamped(self):
        snapshot = build_snapshot(
            guild_count=-5, member_count="abc", latency_ms=-1,
            started_at=STARTED, now=NOW,
        )
        self.assertEqual(snapshot["guild_count"], 0)
        self.assertEqual(snapshot["member_count"], 0)
        self.assertEqual(snapshot["latency_ms"], 0)


class CollectSnapshotTest(unittest.TestCase):
    def test_collects_counts_and_latency_without_ids(self):
        bot = FakeBot(
            guilds=[
                FakeGuild(111111111111111111, "ひみつのサーバーA", 100),
                FakeGuild(222222222222222222, "ひみつのサーバーB", 250),
            ],
            latency=0.0424,
        )
        snapshot = collect_snapshot(bot, started_at=STARTED, now=NOW)
        self.assertEqual(snapshot["guild_count"], 2)
        self.assertEqual(snapshot["member_count"], 350)
        self.assertEqual(snapshot["latency_ms"], 42)
        # ID 類・サーバー名が JSON のどこにも漏れていないこと
        dumped = json.dumps(snapshot, ensure_ascii=False)
        self.assertNotIn("111111111111111111", dumped)
        self.assertNotIn("ひみつのサーバー", dumped)

    def test_nan_latency_becomes_none(self):
        bot = FakeBot(guilds=[], latency=float("nan"))
        snapshot = collect_snapshot(bot, started_at=STARTED, now=NOW)
        self.assertIsNone(snapshot["latency_ms"])
        self.assertEqual(snapshot["guild_count"], 0)

    def test_missing_member_count_counts_as_zero(self):
        class NoCountGuild:
            member_count = None

        bot = FakeBot(guilds=[NoCountGuild()], latency=0.1)
        snapshot = collect_snapshot(bot, started_at=STARTED, now=NOW)
        self.assertEqual(snapshot["guild_count"], 1)
        self.assertEqual(snapshot["member_count"], 0)


if __name__ == "__main__":
    unittest.main()
