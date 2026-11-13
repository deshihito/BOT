# -*- coding: utf-8 -*-
"""サーバー対抗アクティブランキングのテスト。

対象: core/general/server_ranking/scoring.py（期間集計・スコア・
キャップ・オプトアウト・同点処理・ライバル）、board.py の描画、
サーバー分析ストアのオプトアウト判定と全ギルドスナップショット、
公開スナップショット（core/support/public_ranking）への servers 追加、
レジストリ登録。
"""
from __future__ import annotations

import unittest
from datetime import date, timedelta

from core.general.server_ranking import scoring
from core.general.server_ranking.board import render_board_png

TODAY = date(2026, 11, 13)


def _day(messages=0, users=None, vc_seconds=None):
    return {
        "messages": messages,
        "users": dict(users or {}),
        "vc_seconds": dict(vc_seconds or {}),
        "new_members": 0,
        "emojis": {},
        "reacted": {},
        "mentioned": {},
        "hours": [0] * 24,
    }


def _snapshot(days):
    return {"started_at": "2026-11-01T00:00:00+09:00", "days": days}


def _key(d: date) -> str:
    return d.isoformat()


class ScoringTest(unittest.TestCase):
    def test_today_counts_only_today(self):
        snap = _snapshot({
            _key(TODAY): _day(messages=10, users={1: 10}),
            _key(TODAY - timedelta(days=1)): _day(messages=999, users={2: 999}),
        })
        agg = scoring.aggregate_guild(snap, period="today", today=TODAY)
        self.assertEqual(agg["messages"], 10)
        # 10件 + 活動1人*5
        self.assertEqual(agg["points"], 10 + 5)

    def test_week_window_is_seven_days(self):
        days = {}
        for i in range(9):
            days[_key(TODAY - timedelta(days=i))] = _day(messages=1)
        agg = scoring.aggregate_guild(
            _snapshot(days), period="week", today=TODAY)
        self.assertEqual(agg["messages"], 7)

    def test_month_window_is_thirty_days(self):
        days = {}
        for i in range(35):
            days[_key(TODAY - timedelta(days=i))] = _day(messages=1)
        agg = scoring.aggregate_guild(
            _snapshot(days), period="month", today=TODAY)
        self.assertEqual(agg["messages"], 30)

    def test_weights_and_vc_minutes(self):
        # 発言100件 + VC延べ120分 + 活動3人 → 100 + 120 + 15
        snap = _snapshot({_key(TODAY): _day(
            messages=100, users={1: 60, 2: 40},
            vc_seconds={2: 3600, 3: 3600})})
        agg = scoring.aggregate_guild(snap, period="today", today=TODAY)
        self.assertEqual(agg["vc_seconds"], 7200)
        self.assertEqual(agg["actives"], 3)
        self.assertEqual(agg["points"], 100 + 120 + 3 * 5)

    def test_caps_apply_per_day(self):
        snap = _snapshot({_key(TODAY): _day(
            messages=999_999,
            users={i: 1 for i in range(5_000)},
            vc_seconds={1: 10_000_000})})
        agg = scoring.aggregate_guild(snap, period="today", today=TODAY)
        # 表示用の実績値は生値のまま
        self.assertEqual(agg["messages"], 999_999)
        self.assertEqual(agg["actives"], 5_000)
        # pt はキャップ後: 10,000 + 6,000 + 300*5
        self.assertEqual(agg["points"], 10_000 + 6_000 + 300 * 5)

    def test_cap_is_per_day_not_per_period(self):
        days = {
            _key(TODAY): _day(messages=20_000),
            _key(TODAY - timedelta(days=1)): _day(messages=20_000),
        }
        agg = scoring.aggregate_guild(
            _snapshot(days), period="week", today=TODAY)
        self.assertEqual(agg["points"], 10_000 * 2)

    def test_actives_union_across_days_for_display(self):
        days = {
            _key(TODAY): _day(users={1: 3, 2: 2}),
            _key(TODAY - timedelta(days=1)): _day(users={2: 1, 3: 5}),
        }
        agg = scoring.aggregate_guild(
            _snapshot(days), period="week", today=TODAY)
        self.assertEqual(agg["actives"], 3)
        # pt 側の活動人数は日ごとに数える（1日目2人 + 2日目2人）× 5pt
        self.assertEqual(agg["points"], (2 + 2) * 5)


class BuildRowsTest(unittest.TestCase):
    def _snapshots(self):
        return {
            100: _snapshot({_key(TODAY): _day(messages=50, users={1: 50})}),
            200: _snapshot({_key(TODAY): _day(messages=50, users={1: 50})}),
            300: _snapshot({_key(TODAY): _day(messages=500, users={1: 500})}),
            400: _snapshot({_key(TODAY): _day(messages=0)}),
            500: _snapshot({}),
        }

    def test_order_tiebreak_and_zero_exclusion(self):
        rows = scoring.build_rows(self._snapshots(), period="today",
                                  today=TODAY)
        # 300 が首位。同点の 100/200 はギルドID昇順。0pt と無データは除外。
        self.assertEqual([r["guild_id"] for r in rows], [300, 100, 200])
        self.assertEqual([r["rank"] for r in rows], [1, 2, 3])

    def test_opted_out_excluded(self):
        rows = scoring.build_rows(self._snapshots(), period="today",
                                  today=TODAY, opted_out={300})
        self.assertEqual([r["guild_id"] for r in rows], [100, 200])

    def test_rival_info(self):
        rows = scoring.build_rows(self._snapshots(), period="today",
                                  today=TODAY)
        top = scoring.rival_info(rows, 300)
        self.assertEqual(top["rank"], 1)
        self.assertIsNone(top["above_guild_id"])
        self.assertEqual(top["gap"], 0)
        second = scoring.rival_info(rows, 100)
        self.assertEqual(second["rank"], 2)
        self.assertEqual(second["above_guild_id"], 300)
        self.assertEqual(second["gap"], rows[0]["points"] - rows[1]["points"])
        self.assertIsNone(scoring.rival_info(rows, 999))

    def test_paginate(self):
        rows = scoring.build_rows(self._snapshots(), period="today",
                                  today=TODAY)
        page_rows, total, page = scoring.paginate(rows, 5)
        self.assertEqual(total, 1)
        self.assertEqual(page, 0)
        self.assertEqual(len(page_rows), 3)

    def test_format_vc(self):
        self.assertEqual(scoring.format_vc(0), "0分")
        self.assertEqual(scoring.format_vc(59), "0分")
        self.assertEqual(scoring.format_vc(60), "1分")
        self.assertEqual(scoring.format_vc(8 * 3600 + 47 * 60), "8時間47分")

    def test_format_vc_compact(self):
        self.assertEqual(scoring.format_vc_compact(0), "0m")
        self.assertEqual(scoring.format_vc_compact(45 * 60), "45m")
        self.assertEqual(scoring.format_vc_compact(89 * 3600), "89h")
        self.assertEqual(scoring.format_vc_compact(89 * 3600 + 59 * 60), "89h")


class OptOutTest(unittest.TestCase):
    def test_section_optout(self):
        from core.support.server_analytics import store as sa_store

        self.assertFalse(sa_store.section_ranking_opted_out({}))
        self.assertFalse(sa_store.section_ranking_opted_out(None))
        self.assertFalse(sa_store.section_ranking_opted_out(
            {"ranking_optout": False}))
        self.assertFalse(sa_store.section_ranking_opted_out(
            {"ranking_optout": "true"}))
        self.assertTrue(sa_store.section_ranking_opted_out(
            {"ranking_optout": True}))

    def test_store_optout_via_settings(self):
        from core.support.server_analytics import store as sa_store

        class FakeSettings:
            def __init__(self, section):
                self._section = section

            def get(self, guild_id, section):
                return dict(self._section)

        self.assertTrue(sa_store.server_ranking_opted_out(
            FakeSettings({"ranking_optout": True}), 123))
        self.assertFalse(sa_store.server_ranking_opted_out(
            FakeSettings({}), 123))
        self.assertFalse(sa_store.server_ranking_opted_out(
            FakeSettings({}), None))


class StoreSnapshotsTest(unittest.TestCase):
    def test_all_guild_snapshots(self):
        import tempfile
        from pathlib import Path

        from core.support.server_analytics.store import ServerAnalyticsStore

        with tempfile.TemporaryDirectory() as tmp:
            store = ServerAnalyticsStore(Path(tmp) / "sa.json")
            store.record_message(111, 42, [], [])
            store.record_vc_seconds(222, 43, 600)
            snaps = store.all_guild_snapshots()
            self.assertEqual(set(snaps), {111, 222})
            today_key = date.today().isoformat()
            # JST の日付キーで記録されていること（実行環境TZに依存しない範囲）
            self.assertTrue(snaps[111]["days"])
            self.assertEqual(snaps[222]["days"][
                next(iter(snaps[222]["days"]))]["vc_seconds"], {43: 600})
            del today_key


class BoardRenderTest(unittest.TestCase):
    def test_render_with_and_without_icons(self):
        rows = [
            {"guild_id": 1, "points": 1937, "messages": 1011,
             "vc_seconds": 8 * 3600 + 47 * 60, "actives": 64, "rank": 1},
            {"guild_id": 2, "points": 1899, "messages": 626,
             "vc_seconds": 23 * 3600, "actives": 58, "rank": 2},
            {"guild_id": 3, "points": 1771, "messages": 493,
             "vc_seconds": 35 * 3600, "actives": 20, "rank": 3},
            {"guild_id": 4, "points": 976, "messages": 672,
             "vc_seconds": 3 * 3600, "actives": 21, "rank": 4},
        ]
        names = {1: "maison de vacancier#QS", 2: "暇人の雑談広場",
                 3: "うどんの広場(完全招待制)", 4: "とても長いサーバー名" * 6}
        png = render_board_png(rows, period="today", page=0, total_pages=1,
                               names=names, icons={1: None, 2: None},
                               highlight_guild_id=2, top_points=1937)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 10_000)

    def test_render_empty(self):
        png = render_board_png([], period="week", page=0, total_pages=1)
        self.assertTrue(png.startswith(b"\x89PNG"))


class SnapshotServersTest(unittest.TestCase):
    def test_build_snapshot_includes_servers(self):
        from core.support.public_ranking.snapshot import build_snapshot

        boards = {
            "today": [
                {"guild_id": 10, "points": 100, "actives": 5,
                 "messages": 80, "vc_seconds": 600},
                {"guild_id": 20, "points": 50, "actives": 2,
                 "messages": 40, "vc_seconds": 0},
            ],
        }
        info = {
            10: {"name": "サーバーA", "icon": "https://cdn.example/a.png"},
            20: {"name": "サーバーB", "icon": None},
        }
        snap = build_snapshot([], [], {}, server_boards=boards,
                              server_guild_info=info)
        today = snap["servers"]["today"]
        self.assertEqual(len(today), 2)
        self.assertEqual(today[0]["name"], "サーバーA")
        self.assertEqual(today[0]["points"], 100)
        self.assertEqual(today[0]["icon"], "https://cdn.example/a.png")
        self.assertIsNone(today[1]["icon"])
        self.assertNotIn("guild_id", today[0])
        self.assertEqual(snap["servers"]["week"], [])
        self.assertEqual(snap["servers"]["month"], [])

    def test_build_snapshot_default_servers_empty(self):
        from core.support.public_ranking.snapshot import build_snapshot

        snap = build_snapshot([], [], {})
        self.assertEqual(snap["servers"],
                         {"today": [], "week": [], "month": []})

    def test_unknown_guild_dropped(self):
        from core.support.public_ranking.snapshot import build_snapshot

        boards = {"today": [
            {"guild_id": 99, "points": 10, "actives": 1,
             "messages": 5, "vc_seconds": 0}]}
        snap = build_snapshot([], [], {}, server_boards=boards,
                              server_guild_info={})
        self.assertEqual(snap["servers"]["today"], [])


class RegistryTest(unittest.TestCase):
    def test_server_ranking_registered(self):
        from core.general.action_registry import default_registry

        registry = default_registry()
        spec = registry.get("general:server_ranking")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "exp")
        self.assertIn("panel", spec.surfaces)


if __name__ == "__main__":
    unittest.main()
