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


if __name__ == "__main__":
    unittest.main()
