# -*- coding: utf-8 -*-
"""boardNotify RTA の「記録時点の順位」保存のテスト。Discord / DB には接続しない。

記録時に、最速/最遅 × サーバー内/全体 の4順位を算出して bump_rta_events の
当該行へ保存すること、完了通知 embed に順位が載ること、順位まわりが失敗
（SQL マイグレーション未適用など）しても記録本体が壊れないことを検証する。
順位の定義は「その記録が各ランキングに入る位置」= 上位のユーザー数 + 1。
"""

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cogs.game import BumpRta
from core.game.rta.helpers import _rank_line

T0 = datetime(2026, 11, 1, 0, 0, 0, tzinfo=timezone.utc)


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters = {}
        self.orders = []
        self.limit_n = None
        self.op = "select"
        self.payload = None

    def select(self, _cols="*"):
        self.op = "select"
        return self

    def eq(self, key, value):
        self.filters[key] = str(value)
        return self

    def order(self, column, desc=False):
        self.orders.append((column, bool(desc)))
        return self

    def limit(self, count):
        self.limit_n = int(count)
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        return self.db.run_query(self)


class FakeRpcCall:
    def __init__(self, db, name, params):
        self.db, self.name, self.params = db, name, params

    def execute(self):
        return self.db.run_rpc(self.name, self.params)


class FakeDb:
    """bump_rta 系テーブルと RPC の意味論（順位関数含む）を再現する Fake。"""

    def __init__(self, *, fail_ranks=False):
        self.tables = {
            "bump_rta_pending": [],
            "bump_rta_events": [],
            "bump_rta_records": [],
            "bump_rta_worst_records": [],
            "bump_rta_settings": [],
        }
        self.rpc_calls = []
        self.fail_ranks = fail_ranks

    def table(self, name):
        return FakeQuery(self, name)

    def rpc(self, name, params=None):
        return FakeRpcCall(self, name, params or {})

    def _match(self, row, filters):
        return all(str(row.get(k)) == v for k, v in filters.items())

    def run_query(self, query):
        rows = self.tables[query.table]
        if query.op == "insert":
            rows.append(dict(query.payload))
            return FakeResponse([])
        if query.op == "update":
            for row in rows:
                if self._match(row, query.filters):
                    row.update(query.payload)
            return FakeResponse([])
        if query.op == "delete":
            self.tables[query.table] = [r for r in rows if not self._match(r, query.filters)]
            return FakeResponse([])
        data = [dict(r) for r in rows if self._match(r, query.filters)]
        for column, desc in reversed(query.orders):
            data.sort(key=lambda r: r[column], reverse=desc)
        if query.limit_n is not None:
            data = data[:query.limit_n]
        return FakeResponse(data)

    def run_rpc(self, name, params):
        self.rpc_calls.append((name, dict(params)))
        if name in ("record_bump_rta_best", "record_bump_rta_worst"):
            table = "bump_rta_records" if name.endswith("_best") else "bump_rta_worst_records"
            rows = self.tables[table]
            for row in rows:
                if (row["guild_id"] == params["p_guild_id"] and row["user_id"] == params["p_user_id"]
                        and row["event_type"] == params["p_event_type"]):
                    better = (params["p_elapsed_ms"] < row["elapsed_ms"]) if name.endswith("_best") \
                        else (params["p_elapsed_ms"] > row["elapsed_ms"])
                    if better:
                        row["elapsed_ms"] = params["p_elapsed_ms"]
                        row["completed_at"] = params["p_completed_at"]
                    return FakeResponse(None)
            rows.append({
                "guild_id": params["p_guild_id"], "user_id": params["p_user_id"],
                "event_type": params["p_event_type"], "elapsed_ms": params["p_elapsed_ms"],
                "completed_at": params["p_completed_at"],
            })
            return FakeResponse(None)
        if name == "get_bump_rta_record_ranks":
            if self.fail_ranks:
                raise RuntimeError("function get_bump_rta_record_ranks does not exist")
            gid, kind, elapsed = params["p_guild_id"], params["p_event_type"], params["p_elapsed_ms"]
            fast_local = 1 + sum(
                1 for r in self.tables["bump_rta_records"]
                if r["guild_id"] == gid and r["event_type"] == kind and r["elapsed_ms"] < elapsed)
            slow_local = 1 + sum(
                1 for r in self.tables["bump_rta_worst_records"]
                if r["guild_id"] == gid and r["event_type"] == kind and r["elapsed_ms"] > elapsed)
            best_by_user, worst_by_user = {}, {}
            for event in self.tables["bump_rta_events"]:
                if event["event_type"] != kind:
                    continue
                uid = event["user_id"]
                best_by_user[uid] = min(best_by_user.get(uid, event["elapsed_ms"]), event["elapsed_ms"])
                worst_by_user[uid] = max(worst_by_user.get(uid, event["elapsed_ms"]), event["elapsed_ms"])
            fast_global = 1 + sum(1 for v in best_by_user.values() if v < elapsed)
            slow_global = 1 + sum(1 for v in worst_by_user.values() if v > elapsed)
            return FakeResponse([{
                "rank_fast_local": fast_local, "rank_fast_global": fast_global,
                "rank_slow_local": slow_local, "rank_slow_global": slow_global,
            }])
        raise AssertionError(f"unexpected rpc: {name}")


def make_cog(db):
    bot = SimpleNamespace(
        db_api=db,
        get_user=lambda uid: SimpleNamespace(
            id=uid, name=f"user-{uid}", display_name=f"user-{uid}", global_name=None),
    )
    cog = BumpRta(bot)
    cog._send_timed = AsyncMock()
    return cog


def seed_pending(db, *, bump_at, message_id="111", user_id="321"):
    db.tables["bump_rta_pending"].append({
        "guild_id": "456", "event_type": "bump", "user_id": user_id,
        "bump_message_id": message_id, "bump_at": bump_at.isoformat(),
    })


def make_message():
    return SimpleNamespace(
        id=999, guild=SimpleNamespace(id=456), channel=SimpleNamespace(id=789))


def sent_embed(cog):
    return cog._send_timed.await_args.kwargs["embed"]


class RecordRanksTest(unittest.IsolatedAsyncioTestCase):
    async def record(self, cog, db, *, start, seconds, message_id, user_id=321):
        seed_pending(db, bump_at=start, message_id=message_id, user_id=str(user_id))
        await cog._record_rta_event(
            make_message(), "bump", user_id, start + timedelta(seconds=seconds))

    async def test_first_record_is_rank_one_everywhere(self):
        db = FakeDb()
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        event = db.tables["bump_rta_events"][0]
        self.assertEqual(event["rank_fast_local"], 1)
        self.assertEqual(event["rank_fast_global"], 1)
        self.assertEqual(event["rank_slow_local"], 1)
        self.assertEqual(event["rank_slow_global"], 1)
        description = sent_embed(cog).description
        self.assertIn("最速: サーバー内 **1位** / 全サーバー **1位**", description)
        self.assertIn("最遅: サーバー内 **1位** / 全サーバー **1位**", description)

    async def test_ranks_reflect_position_among_other_users(self):
        db = FakeDb()
        # サーバー内ベスト: A=30秒, B=90秒 / サーバー内ワースト: A=200秒, B=50秒
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
        ]
        # 全体集計の元イベント: A は min30/max200, B は min50/max90
        db.tables["bump_rta_events"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 30000, "bump_message_id": "a1", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 200000, "bump_message_id": "a2", "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "bump_message_id": "b1", "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 50000, "bump_message_id": "b2", "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        # C（user 321）が 60秒で記録
        await self.record(cog, db, start=T0, seconds=60, message_id="c1")
        event = [e for e in db.tables["bump_rta_events"]
                 if e["bump_message_id"] == "c1"][0]
        self.assertEqual(event["rank_fast_local"], 2)   # A のベスト30秒のみ上位
        self.assertEqual(event["rank_slow_local"], 2)   # A のワースト200秒のみ上位
        self.assertEqual(event["rank_fast_global"], 3)  # A=30, B=50 が上位
        self.assertEqual(event["rank_slow_global"], 3)  # A=200, B=90 が上位
        description = sent_embed(cog).description
        self.assertIn("最速: サーバー内 **2位** / 全サーバー **3位**", description)
        self.assertIn("最遅: サーバー内 **2位** / 全サーバー **3位**", description)

    async def test_rank_failure_does_not_break_recording(self):
        db = FakeDb(fail_ranks=True)
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        # 記録本体（ベスト/ワースト/pending消化/通知）は通常どおり
        self.assertEqual(db.tables["bump_rta_records"][0]["elapsed_ms"], 90000)
        self.assertEqual(db.tables["bump_rta_worst_records"][0]["elapsed_ms"], 90000)
        self.assertEqual(db.tables["bump_rta_pending"], [])
        cog._send_timed.assert_awaited()
        # 順位は保存されず、通知にも順位行が付かない
        event = db.tables["bump_rta_events"][0]
        self.assertNotIn("rank_fast_local", event)
        self.assertNotIn("最速:", sent_embed(cog).description)

    async def test_redelivery_keeps_original_ranks(self):
        db = FakeDb()
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        names = [name for name, _ in db.rpc_calls]
        self.assertEqual(names.count("get_bump_rta_record_ranks"), 1)
        # 同じ bump_message_id で再送されても順位は再計算しない
        seed_pending(db, bump_at=T0, message_id="111")
        await cog._record_rta_event(
            make_message(), "bump", 321, T0 + timedelta(seconds=90))
        names = [name for name, _ in db.rpc_calls]
        self.assertEqual(names.count("get_bump_rta_record_ranks"), 1)
        self.assertEqual(db.tables["bump_rta_events"][0]["rank_fast_local"], 1)


class RankLineTest(unittest.TestCase):
    def test_rank_line(self):
        self.assertEqual(_rank_line("最速", 3, 15),
                         "最速: サーバー内 **3位** / 全サーバー **15位**")
        self.assertEqual(_rank_line("最速", None, 15), "")
        self.assertEqual(_rank_line("最速", 3, None), "")


if __name__ == "__main__":
    unittest.main()
