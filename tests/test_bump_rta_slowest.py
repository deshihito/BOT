import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cogs.game import BumpRta

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

    def delete(self):
        self.op = "delete"
        return self

    def upsert(self, payload, on_conflict=None):
        self.op, self.payload = "upsert", payload
        return self

    def execute(self):
        return self.db.run_query(self)


class FakeRpcCall:
    def __init__(self, db, name, params):
        self.db, self.name, self.params = db, name, params

    def execute(self):
        return self.db.run_rpc(self.name, self.params)


class FakeDb:
    """bump_rta 系テーブルと RPC の意味論を再現するインメモリ Fake。"""

    def __init__(self, *, fail_worst=False):
        self.tables = {
            "bump_rta_pending": [],
            "bump_rta_events": [],
            "bump_rta_records": [],
            "bump_rta_worst_records": [],
            "bump_rta_settings": [],
        }
        self.rpc_calls = []
        self.fail_worst = fail_worst

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
        if query.op == "delete":
            self.tables[query.table] = [r for r in rows if not self._match(r, query.filters)]
            return FakeResponse([])
        if query.op == "upsert":
            key = {k: query.payload[k] for k in ("guild_id", "user_id", "event_type")
                   if k in query.payload} or dict(query.payload)
            for row in rows:
                if all(str(row.get(k)) == str(v) for k, v in key.items()):
                    row.update(query.payload)
                    return FakeResponse([])
            rows.append(dict(query.payload))
            return FakeResponse([])
        data = [dict(r) for r in rows if self._match(r, query.filters)]
        for column, desc in reversed(query.orders):
            data.sort(key=lambda r: r[column], reverse=desc)
        if query.limit_n is not None:
            data = data[:query.limit_n]
        return FakeResponse(data)

    def run_rpc(self, name, params):
        self.rpc_calls.append((name, dict(params)))
        if name == "record_bump_rta_worst" and self.fail_worst:
            raise RuntimeError("function record_bump_rta_worst does not exist")
        if name in ("record_bump_rta_best", "record_bump_rta_worst"):
            table = "bump_rta_records" if name.endswith("_best") else "bump_rta_worst_records"
            rows = self.tables[table]
            for row in rows:
                if (row["guild_id"] == params["p_guild_id"] and row["user_id"] == params["p_user_id"]
                        and row["event_type"] == params["p_event_type"]):
                    better = (params["p_elapsed_ms"] < row["elapsed_ms"]) if table.endswith("_records") and name.endswith("_best") \
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
        if name in ("get_bump_rta_global_ranking", "get_bump_rta_global_slowest_ranking"):
            slowest = name.endswith("_slowest_ranking")
            grouped = {}
            for event in self.tables["bump_rta_events"]:
                if event["event_type"] != params["p_event_type"]:
                    continue
                entry = grouped.setdefault(event["user_id"], {"elapsed": [], "attempts": 0})
                entry["elapsed"].append(event["elapsed_ms"])
                entry["attempts"] += 1
            data = [{
                "user_id": uid,
                "elapsed_ms": (max(v["elapsed"]) if slowest else min(v["elapsed"])),
                "attempts": v["attempts"],
            } for uid, v in grouped.items()]
            data.sort(key=lambda r: r["elapsed_ms"], reverse=slowest)
            return FakeResponse(data[:params.get("p_limit", 10)])
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


class WorstRecordingTest(unittest.IsolatedAsyncioTestCase):
    async def record(self, cog, db, *, start, seconds, message_id):
        seed_pending(db, bump_at=start, message_id=message_id)
        await cog._record_rta_event(make_message(), "bump", 321, start + timedelta(seconds=seconds))

    async def test_worst_updates_independently_of_best(self):
        db = FakeDb()
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        self.assertEqual(db.tables["bump_rta_records"][0]["elapsed_ms"], 90000)
        self.assertEqual(db.tables["bump_rta_worst_records"][0]["elapsed_ms"], 90000)
        # 速い記録: 最速だけ更新され、最遅は残る
        await self.record(cog, db, start=T0 + timedelta(hours=3), seconds=30, message_id="112")
        self.assertEqual(db.tables["bump_rta_records"][0]["elapsed_ms"], 30000)
        self.assertEqual(db.tables["bump_rta_worst_records"][0]["elapsed_ms"], 90000)
        # 遅い記録: 最遅だけ更新され、最速は残る
        await self.record(cog, db, start=T0 + timedelta(hours=6), seconds=150, message_id="113")
        self.assertEqual(db.tables["bump_rta_records"][0]["elapsed_ms"], 30000)
        self.assertEqual(db.tables["bump_rta_worst_records"][0]["elapsed_ms"], 150000)
        names = [name for name, _ in db.rpc_calls]
        self.assertEqual(names.count("record_bump_rta_best"), 3)
        self.assertEqual(names.count("record_bump_rta_worst"), 3)
        self.assertEqual(db.tables["bump_rta_pending"], [])

    async def test_worst_rpc_failure_does_not_break_recording(self):
        db = FakeDb(fail_worst=True)
        cog = make_cog(db)
        await self.record(cog, db, start=T0, seconds=90, message_id="111")
        self.assertEqual(db.tables["bump_rta_records"][0]["elapsed_ms"], 90000)
        self.assertEqual(db.tables["bump_rta_pending"], [])
        cog._send_timed.assert_awaited()


def make_interaction(user_id=321):
    return SimpleNamespace(
        user=SimpleNamespace(id=user_id, display_name="自分"),
        guild_id=456,
        guild=SimpleNamespace(id=456, get_member=lambda uid: None),
        followup=SimpleNamespace(send=AsyncMock()),
    )


async def board_text(cog, interaction, **kwargs):
    await cog.leaderboard(interaction, **kwargs)
    return interaction.followup.send.await_args.kwargs["embed"].description


class SlowestLeaderboardTest(unittest.IsolatedAsyncioTestCase):
    async def test_local_slowest_is_descending(self):
        db = FakeDb()
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 150000, "completed_at": T0.isoformat()},
        ]
        text = await board_text(make_cog(db), make_interaction(),
                                event_type="bump", scope="local", slowest=True)
        self.assertIn("このサーバー bump 最遅ランキング", text)
        self.assertLess(text.index("user-111"), text.index("user-222"))
        self.assertLess(text.index("150.00秒"), text.index("90.00秒"))

    async def test_local_fastest_board_unchanged(self):
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
        ]
        text = await board_text(make_cog(db), make_interaction(),
                                event_type="bump", scope="local")
        self.assertIn("このサーバー bump RTAランキング", text)
        self.assertNotIn("最遅", text)
        self.assertLess(text.index("user-111"), text.index("user-222"))
        self.assertLess(text.index("30.00秒"), text.index("90.00秒"))

    async def test_global_slowest_uses_max_per_user(self):
        db = FakeDb()
        db.tables["bump_rta_events"] = [
            {"guild_id": "1", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "2", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
            {"guild_id": "1", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 120000, "completed_at": T0.isoformat()},
        ]
        text = await board_text(make_cog(db), make_interaction(),
                                event_type="bump", scope="global", slowest=True)
        self.assertIn("全サーバー bump 最遅ランキング", text)
        self.assertLess(text.index("user-111"), text.index("user-222"))
        self.assertIn("200.00秒", text)
        self.assertIn("（2回）", text)

    async def test_me_slowest(self):
        db = FakeDb()
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 150000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "999", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 5000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        text = await board_text(cog, make_interaction(), event_type="bump", scope="me", slowest=True)
        self.assertIn("最遅記録", text)
        self.assertIn("150.00秒", text)
        self.assertIn("200.00秒", text)
        text = await board_text(cog, make_interaction(), event_type="bump", scope="me")
        self.assertIn("自己ベスト", text)
        self.assertNotIn("最遅", text)


if __name__ == "__main__":
    unittest.main()
