"""公開ランキングのスナップショット生成（純粋部分）のテスト。

公開境界の要: スナップショットにユーザーID等の ID 類が含まれないこと。
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

from core.support.public_ranking.snapshot import TOP_N, build_snapshot

NOW = datetime.datetime(2026, 11, 7, 12, 0, tzinfo=datetime.timezone.utc)


def exp_row(user_id, value, level):
    return {"user_id": user_id, "value": value, "general_level": level}


class BuildSnapshotTest(unittest.TestCase):
    def test_shape_and_no_ids(self):
        exp_rows = [exp_row(111, 900, 12), exp_row(222, 800, 11)]
        coin_rows = [
            {"user_id": 333, "balance": 5000},
            {"user_id": 111, "balance": 7000},
        ]
        names = {111: "アゴ太郎", 222: "ミリィ", 333: "キーパー"}
        snapshot = build_snapshot(exp_rows, coin_rows, names, now=NOW)

        self.assertEqual(snapshot["updated_at"], NOW.isoformat())
        self.assertEqual(
            snapshot["exp"],
            [
                {"name": "アゴ太郎", "value": 900, "level": 12},
                {"name": "ミリィ", "value": 800, "level": 11},
            ],
        )
        # コインは残高の降順に並べ替える
        self.assertEqual(
            snapshot["coin"],
            [
                {"name": "アゴ太郎", "value": 7000},
                {"name": "キーパー", "value": 5000},
            ],
        )
        # ID 類が JSON のどこにも現れないこと
        text = json.dumps(snapshot, ensure_ascii=False)
        for forbidden in ("111", "222", "333", "user_id", "guild"):
            self.assertNotIn(forbidden, text)

    def test_top_n_cut(self):
        exp_rows = [exp_row(1000 + i, 100 - i, 1) for i in range(TOP_N + 10)]
        names = {1000 + i: f"u{i}" for i in range(TOP_N + 10)}
        snapshot = build_snapshot(exp_rows, [], names, now=NOW)
        self.assertEqual(len(snapshot["exp"]), TOP_N)
        self.assertEqual(snapshot["coin"], [])

    def test_missing_name_becomes_empty_string(self):
        snapshot = build_snapshot([exp_row(999, 5, 1)], [], {}, now=NOW)
        self.assertEqual(snapshot["exp"][0]["name"], "")

    def test_rta_entries_sorted_fastest_first_and_no_ids(self):
        bump_rows = [
            {"user_id": 222, "elapsed_ms": 12450},
            {"user_id": 111, "elapsed_ms": 5300},
        ]
        up_rows = [{"user_id": 333, "elapsed_ms": 9870}]
        names = {111: "アゴ太郎", 222: "ミリィ", 333: "キーパー"}
        snapshot = build_snapshot([], [], names, now=NOW,
                                  bump_rows=bump_rows, up_rows=up_rows)
        # RTA は速い順（elapsed_ms の昇順）に並ぶ
        self.assertEqual(
            snapshot["bump"],
            [
                {"name": "アゴ太郎", "value": 5300},
                {"name": "ミリィ", "value": 12450},
            ],
        )
        self.assertEqual(snapshot["up"], [{"name": "キーパー", "value": 9870}])
        text = json.dumps(snapshot, ensure_ascii=False)
        for forbidden in ("111", "222", "333", "user_id", "guild"):
            self.assertNotIn(forbidden, text)

    def test_rta_defaults_to_empty(self):
        snapshot = build_snapshot([], [], {}, now=NOW)
        self.assertEqual(snapshot["bump"], [])
        self.assertEqual(snapshot["up"], [])


if __name__ == "__main__":
    unittest.main()


from core.support.public_ranking.snapshot import (
    best_rta_rows, pool_rta_boards,
)


def event(user_id, elapsed_ms, completed_at):
    return {"user_id": user_id, "elapsed_ms": elapsed_ms,
            "completed_at": completed_at}


class BestRtaRowsTest(unittest.TestCase):
    def test_first_row_per_user_wins(self):
        rows = [
            event(111, 3000, "2026-12-01T10:00:00+00:00"),
            event(222, 4500, "2026-12-02T10:00:00+00:00"),
            event(111, 6000, "2026-12-03T10:00:00+00:00"),
        ]
        picked = best_rta_rows(rows)
        self.assertEqual(
            picked,
            [
                {"user_id": 111, "elapsed_ms": 3000,
                 "completed_at": "2026-12-01T10:00:00+00:00"},
                {"user_id": 222, "elapsed_ms": 4500,
                 "completed_at": "2026-12-02T10:00:00+00:00"},
            ],
        )

    def test_limit_and_bad_rows(self):
        rows = [event(1000 + i, 100 + i, None) for i in range(5)]
        rows.insert(0, {"user_id": "x", "elapsed_ms": 1, "completed_at": None})
        picked = best_rta_rows(rows, limit=3)
        self.assertEqual(len(picked), 3)
        self.assertEqual(picked[0]["completed_at"], None)


class PoolRtaBoardsTest(unittest.TestCase):
    def test_pools_entries_without_collapsing_users(self):
        boards = {
            "bump": [
                {"user_id": 111, "elapsed_ms": 5000,
                 "completed_at": "2026-12-01T10:00:00+00:00"},
                {"user_id": 222, "elapsed_ms": 8000,
                 "completed_at": "2026-12-02T10:00:00+00:00"},
            ],
            "up": [
                {"user_id": 222, "elapsed_ms": 4000,
                 "completed_at": "2026-12-05T10:00:00+00:00"},
                {"user_id": 333, "elapsed_ms": 9000,
                 "completed_at": "2026-12-06T10:00:00+00:00"},
            ],
        }
        pooled = pool_rta_boards(boards)
        # user 222 は bump と up の2エントリで載る（ユーザー単位に潰さない）
        self.assertEqual(
            [(r["user_id"], r["elapsed_ms"], r["service"]) for r in pooled],
            [(222, 4000, "up"), (111, 5000, "bump"),
             (222, 8000, "bump"), (333, 9000, "up")],
        )
        self.assertEqual(pooled[0]["completed_at"],
                         "2026-12-05T10:00:00+00:00")

    def test_slowest_pools_in_descending_order(self):
        boards = {
            "bump": [{"user_id": 111, "elapsed_ms": 5000, "completed_at": None}],
            "up": [{"user_id": 111, "elapsed_ms": 7000, "completed_at": None}],
        }
        pooled = pool_rta_boards(boards, slowest=True)
        self.assertEqual(
            [(r["elapsed_ms"], r["service"]) for r in pooled],
            [(7000, "up"), (5000, "bump")],
        )


class BuildSnapshotRtaBoardsTest(unittest.TestCase):
    def test_rta_shape_and_legacy_keys(self):
        boards = {
            "bump": {
                "fast": [{"user_id": 111, "elapsed_ms": 5300,
                          "completed_at": "2026-12-25T10:00:00+00:00"}],
                "slow": [{"user_id": 222, "elapsed_ms": 90000,
                          "completed_at": "2026-12-26T10:00:00+00:00"}],
            },
        }
        names = {111: "アゴ太郎", 222: "ミリィ"}
        snapshot = build_snapshot([], [], names, now=NOW, rta_boards=boards)
        # rta は日時・サービスつきの単一ボード（{fast, slow}）
        self.assertEqual(
            snapshot["rta"]["fast"],
            [{"name": "アゴ太郎", "value": 5300,
              "at": "2026-12-25T10:00:00+00:00", "service": "bump"}],
        )
        self.assertEqual(
            snapshot["rta"]["slow"],
            [{"name": "ミリィ", "value": 90000,
              "at": "2026-12-26T10:00:00+00:00", "service": "bump"}],
        )
        # サービス別のキーは持たない
        self.assertNotIn("bump", snapshot["rta"])
        self.assertNotIn("all", snapshot["rta"])
        # 旧キーは従来形式（name / value のみ）のまま
        self.assertEqual(snapshot["bump"], [{"name": "アゴ太郎", "value": 5300}])
        self.assertEqual(snapshot["up"], [])
        # ID 類が JSON のどこにも現れないこと
        text = json.dumps(snapshot, ensure_ascii=False)
        for forbidden in ("user_id", "guild"):
            self.assertNotIn(forbidden, text)

    def test_rta_board_keeps_same_user_per_service(self):
        boards = {
            "bump": {
                "fast": [{"user_id": 111, "elapsed_ms": 5300,
                          "completed_at": "2026-12-25T10:00:00+00:00"}],
                "slow": [],
            },
            "up": {
                "fast": [{"user_id": 111, "elapsed_ms": 4000,
                          "completed_at": "2026-12-24T10:00:00+00:00"}],
                "slow": [],
            },
        }
        names = {111: "アゴ太郎"}
        snapshot = build_snapshot([], [], names, now=NOW, rta_boards=boards)
        # 同じユーザーが bump と up の2エントリで載る
        self.assertEqual(
            snapshot["rta"]["fast"],
            [{"name": "アゴ太郎", "value": 4000,
              "at": "2026-12-24T10:00:00+00:00", "service": "up"},
             {"name": "アゴ太郎", "value": 5300,
              "at": "2026-12-25T10:00:00+00:00", "service": "bump"}],
        )
