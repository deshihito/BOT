# -*- coding: utf-8 -*-
"""boardNotify RTA の「記録時点の順位」保存のテスト。Discord / DB には接続しない。

記録時に、最速/最遅 × サーバー内/全体 の4順位を算出して bump_rta_events の
当該行へ保存すること、完了通知 embed に順位が載ること、順位まわりが失敗
（SQL マイグレーション未適用など）しても記録本体が壊れないことを検証する。
あわせて、全サービスを通したユーザー単位の「総合」順位（rank_all_*）が
保存・表示されること、総合ぶんのマイグレーション未適用時は通常の順位
だけが残ることも検証する。
順位の定義は「その記録が各ランキングに入る位置」= 上位のエントリ数 + 1。
ランキング基準は全サービスの「ユーザー × サービス種類」エントリを
pooled した統合ボードで、同じユーザーの別サービスのエントリも
それぞれ順位に数える。
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

    def __init__(self, *, fail_ranks=False, combined_ranks=True):
        self.combined_ranks = combined_ranks
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
            # エントリ基準: p_event_type は互換のため受け取るだけで使わない。
            # local は records / worst_records の全行がエントリ、global は
            # events を (user_id, event_type) で集計した min / max がエントリ。
            gid, elapsed = params["p_guild_id"], params["p_elapsed_ms"]
            fast_local = 1 + sum(
                1 for r in self.tables["bump_rta_records"]
                if r["guild_id"] == gid and r["event_type"] != "legacy"
                and r["elapsed_ms"] < elapsed)
            slow_local = 1 + sum(
                1 for r in self.tables["bump_rta_worst_records"]
                if r["guild_id"] == gid and r["event_type"] != "legacy"
                and r["elapsed_ms"] > elapsed)

            def entry_extremes(pick):
                per_entry = {}
                for e in self.tables["bump_rta_events"]:
                    if e["event_type"] == "legacy":
                        continue
                    key = (e["user_id"], e["event_type"])
                    per_entry[key] = pick(
                        per_entry.get(key, e["elapsed_ms"]), e["elapsed_ms"])
                return per_entry.values()

            fast_global = 1 + sum(1 for v in entry_extremes(min) if v < elapsed)
            slow_global = 1 + sum(1 for v in entry_extremes(max) if v > elapsed)
            ranks = {
                "rank_fast_local": fast_local, "rank_fast_global": fast_global,
                "rank_slow_local": slow_local, "rank_slow_global": slow_global,
            }
            if self.combined_ranks:
                # 総合: ユーザー単位に潰す（最速=全サービス中の最小、
                # 最遅=最大）。local はギルドの records / worst_records、
                # global は全 events から集計する。
                def user_extremes(rows, pick, *, guild_only):
                    per_user = {}
                    for r in rows:
                        if r["event_type"] == "legacy":
                            continue
                        if guild_only and r["guild_id"] != gid:
                            continue
                        per_user[r["user_id"]] = pick(
                            per_user.get(r["user_id"], r["elapsed_ms"]),
                            r["elapsed_ms"])
                    return per_user.values()

                ranks.update({
                    "rank_all_fast_local": 1 + sum(
                        1 for v in user_extremes(
                            self.tables["bump_rta_records"], min,
                            guild_only=True) if v < elapsed),
                    "rank_all_slow_local": 1 + sum(
                        1 for v in user_extremes(
                            self.tables["bump_rta_worst_records"], max,
                            guild_only=True) if v > elapsed),
                    "rank_all_fast_global": 1 + sum(
                        1 for v in user_extremes(
                            self.tables["bump_rta_events"], min,
                            guild_only=False) if v < elapsed),
                    "rank_all_slow_global": 1 + sum(
                        1 for v in user_extremes(
                            self.tables["bump_rta_events"], max,
                            guild_only=False) if v > elapsed),
                })
            return FakeResponse([ranks])
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
        self.assertEqual(event["rank_all_fast_local"], 1)
        self.assertEqual(event["rank_all_fast_global"], 1)
        self.assertEqual(event["rank_all_slow_local"], 1)
        self.assertEqual(event["rank_all_slow_global"], 1)
        description = sent_embed(cog).description
        self.assertIn("最速: サーバー内 **1位** / 全サーバー **1位**", description)
        self.assertIn("最遅: サーバー内 **1位** / 全サーバー **1位**", description)
        self.assertIn("総合最速: サーバー内 **1位** / 全サーバー **1位**", description)
        self.assertIn("総合最遅: サーバー内 **1位** / 全サーバー **1位**", description)

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

    async def test_ranks_use_all_services_entries_basis(self):
        db = FakeDb()
        # A の記録が別サービス（up / vote / dicoall）だけでも順位に数える
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "vote",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "999", "user_id": "111", "event_type": "dicoall",
             "elapsed_ms": 30000, "bump_message_id": "a1", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "up",
             "elapsed_ms": 200000, "bump_message_id": "a2", "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=60, message_id="c1")
        event = [e for e in db.tables["bump_rta_events"]
                 if e["bump_message_id"] == "c1"][0]
        self.assertEqual(event["rank_fast_local"], 2)   # A の up ベスト30秒が上位
        self.assertEqual(event["rank_slow_local"], 2)   # A の vote ワースト200秒が上位
        self.assertEqual(event["rank_fast_global"], 2)  # A の dicoall 最小30秒が上位
        self.assertEqual(event["rank_slow_global"], 2)  # A の up 最大200秒が上位

    async def test_ranks_count_each_service_entry_not_each_user(self):
        db = FakeDb()
        # A（user 111）は1人だが、サービス別に2エントリずつ持っている。
        # ユーザー単位に潰す旧基準なら順位は 2 になるが、エントリ基準では
        # 上位エントリが2つあるため 3 位になる。
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 10000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 20000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 400000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "vote",
             "elapsed_ms": 350000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "999", "user_id": "111", "event_type": "dicoall",
             "elapsed_ms": 5000, "bump_message_id": "a1", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "sharkbot",
             "elapsed_ms": 15000, "bump_message_id": "a2", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "up",
             "elapsed_ms": 500000, "bump_message_id": "a3", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "takasumi",
             "elapsed_ms": 450000, "bump_message_id": "a4", "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        # C（user 321）が 60秒で記録
        await self.record(cog, db, start=T0, seconds=60, message_id="c1")
        event = [e for e in db.tables["bump_rta_events"]
                 if e["bump_message_id"] == "c1"][0]
        self.assertEqual(event["rank_fast_local"], 3)   # A の bump / up 両エントリが上位
        self.assertEqual(event["rank_slow_local"], 3)   # A の bump / vote 両エントリが上位
        self.assertEqual(event["rank_fast_global"], 3)  # A の dicoall / sharkbot が上位
        self.assertEqual(event["rank_slow_global"], 3)  # A の up / takasumi が上位

    async def test_combined_ranks_count_each_user_once(self):
        db = FakeDb()
        # エントリ基準のテストと同じ並び: A（user 111）はサービス別に
        # 2エントリずつ持つ。エントリ順位は 3 位になるが、総合は
        # ユーザー単位に潰すので A を1回だけ数えて 2 位になる。
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 10000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 20000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 400000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "vote",
             "elapsed_ms": 350000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "999", "user_id": "111", "event_type": "dicoall",
             "elapsed_ms": 5000, "bump_message_id": "a1", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "sharkbot",
             "elapsed_ms": 15000, "bump_message_id": "a2", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "up",
             "elapsed_ms": 500000, "bump_message_id": "a3", "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "111", "event_type": "takasumi",
             "elapsed_ms": 450000, "bump_message_id": "a4", "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=60, message_id="c1")
        event = [e for e in db.tables["bump_rta_events"]
                 if e["bump_message_id"] == "c1"][0]
        self.assertEqual(event["rank_fast_local"], 3)
        self.assertEqual(event["rank_all_fast_local"], 2)   # A の最小10秒のみ
        self.assertEqual(event["rank_all_slow_local"], 2)   # A の最大400秒のみ
        self.assertEqual(event["rank_all_fast_global"], 2)  # A の最小5秒のみ
        self.assertEqual(event["rank_all_slow_global"], 2)  # A の最大500秒のみ
        description = sent_embed(cog).description
        self.assertIn("総合最速: サーバー内 **2位** / 全サーバー **2位**", description)
        self.assertIn("総合最遅: サーバー内 **2位** / 全サーバー **2位**", description)

    async def test_without_combined_migration_base_ranks_remain(self):
        # SQL マイグレーション未適用（関数が総合順位を返さない）環境では、
        # 通常の順位だけが保存・表示され、総合の行は付かない。
        db = FakeDb(combined_ranks=False)
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        event = db.tables["bump_rta_events"][0]
        self.assertEqual(event["rank_fast_local"], 1)
        self.assertNotIn("rank_all_fast_local", event)
        description = sent_embed(cog).description
        self.assertIn("最速: サーバー内 **1位** / 全サーバー **1位**", description)
        self.assertNotIn("総合", description)

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
