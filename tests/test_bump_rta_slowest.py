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
        if name in ("get_bump_rta_global_combined_ranking",
                    "get_bump_rta_global_combined_slowest_ranking"):
            # 統合 RPC: (user_id, event_type) ごとに集計したエントリを
            # pooled で返す（legacy はエントリにしない）。
            slowest = name.endswith("_slowest_ranking")
            grouped = {}
            for event in self.tables["bump_rta_events"]:
                if event["event_type"] == "legacy":
                    continue
                key = (event["user_id"], event["event_type"])
                entry = grouped.setdefault(key, {"elapsed": [], "attempts": 0})
                entry["elapsed"].append(event["elapsed_ms"])
                entry["attempts"] += 1
            data = [{
                "user_id": uid, "event_type": event_type,
                "elapsed_ms": (max(v["elapsed"]) if slowest else min(v["elapsed"])),
                "attempts": v["attempts"],
            } for (uid, event_type), v in grouped.items()]
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


async def board_rows(cog, **kwargs):
    """_rta_ranking_rows の (表題, 行) を返す（画像化前の並びを検証する）。"""
    return await cog._rta_ranking_rows(
        kwargs.get("scope", "local"), kwargs.get("slowest", False), 456)


async def board_embed(cog, **kwargs):
    """build_rta_board の (embed, png) を返す。"""
    return await cog.build_rta_board(
        kwargs.get("scope", "local"), kwargs.get("slowest", False),
        guild_id=456, user_id=321, user_name="自分")


class SlowestLeaderboardTest(unittest.IsolatedAsyncioTestCase):
    async def test_local_slowest_is_descending(self):
        db = FakeDb()
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 150000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="local", slowest=True)
        self.assertEqual(title, "このサーバー 最遅ランキング")
        self.assertEqual([r["user_id"] for r in data], ["111", "222"])
        self.assertEqual([r["elapsed_ms"] for r in data], [150000, 90000])
        embed, png = await board_embed(cog, scope="local", slowest=True)
        self.assertEqual(embed.title, title)
        self.assertTrue(png.startswith(b"\x89PNG"))

    async def test_local_fastest_board_unchanged(self):
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="local")
        self.assertEqual(title, "このサーバー RTAランキング")
        self.assertNotIn("最遅", title)
        self.assertEqual([r["user_id"] for r in data], ["111", "222"])
        self.assertEqual([r["elapsed_ms"] for r in data], [30000, 90000])
        embed, png = await board_embed(cog, scope="local")
        self.assertEqual(embed.title, title)
        self.assertTrue(png.startswith(b"\x89PNG"))

    async def test_global_slowest_uses_max_per_user_and_type(self):
        db = FakeDb()
        db.tables["bump_rta_events"] = [
            {"guild_id": "1", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "2", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
            {"guild_id": "1", "user_id": "222", "event_type": "bump",
             "elapsed_ms": 120000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="global", slowest=True)
        self.assertEqual(title, "全サーバー 最遅ランキング")
        self.assertEqual([r["user_id"] for r in data], ["111", "222"])
        self.assertEqual(data[0]["elapsed_ms"], 200000)
        self.assertEqual(data[0]["attempts"], 2)

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
        embed, png = await board_embed(cog, scope="me", slowest=True)
        self.assertIsNone(png)
        self.assertIn("最遅記録", embed.description)
        # 種類別エントリとして bump の行に両スコープの値が並ぶ
        self.assertIn("bump: このサーバー **150.00秒** / 全サーバー **200.00秒**",
                      embed.description)
        embed, png = await board_embed(cog, scope="me")
        self.assertIsNone(png)
        self.assertIn("自己ベスト", embed.description)
        self.assertNotIn("最遅", embed.description)
        # 最速側はこのサーバーに記録がなく、全サーバーの最小だけが出る
        self.assertIn("bump: このサーバー 記録なし / 全サーバー **5.00秒**",
                      embed.description)

    async def test_leaderboard_sends_image_board(self):
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        interaction = make_interaction()
        await cog.leaderboard(interaction, scope="local")
        kwargs = interaction.followup.send.await_args.kwargs
        self.assertEqual(kwargs["embed"].title, "このサーバー RTAランキング")
        self.assertIn("file", kwargs)


class EntryBoardTest(unittest.IsolatedAsyncioTestCase):
    """統合ランキング: 行は (ユーザー × サービス種類) のエントリ単位。

    同じユーザーが bump と up の記録を持てば両方載り、ユーザー単位には
    潰さない。最速は records の全行、最遅は worst_records の全行を
    pooled で並べる。
    """

    async def test_local_fastest_pools_service_entries(self):
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "vote",
             "elapsed_ms": 42000, "completed_at": T0.isoformat()},
            # 別サーバーの記録は混ざらない
            {"guild_id": "999", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 1000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="local")
        self.assertEqual(title, "このサーバー RTAランキング")
        # user 111 が up と bump の2行で載る（ユーザー単位に潰さない）
        self.assertEqual([r["user_id"] for r in data], ["111", "222", "111"])
        self.assertEqual([r["event_type"] for r in data], ["up", "vote", "bump"])
        self.assertEqual([r["elapsed_ms"] for r in data], [30000, 42000, 50000])
        embed, png = await board_embed(cog, scope="local")
        self.assertEqual(embed.title, title)
        self.assertTrue(png.startswith(b"\x89PNG"))

    async def test_local_slowest_pools_service_entries(self):
        db = FakeDb()
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 150000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "222", "event_type": "dcafe",
             "elapsed_ms": 120000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="local", slowest=True)
        self.assertEqual(title, "このサーバー 最遅ランキング")
        self.assertEqual([r["user_id"] for r in data], ["111", "222", "111"])
        self.assertEqual([r["event_type"] for r in data], ["up", "dcafe", "bump"])
        self.assertEqual([r["elapsed_ms"] for r in data], [150000, 120000, 90000])

    async def test_global_entries_group_attempts_per_user_and_type(self):
        db = FakeDb()
        db.tables["bump_rta_events"] = [
            {"guild_id": "1", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "2", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 80000, "completed_at": T0.isoformat()},
            {"guild_id": "2", "user_id": "111", "event_type": "up",
             "elapsed_ms": 200000, "completed_at": T0.isoformat()},
            {"guild_id": "1", "user_id": "222", "event_type": "vote",
             "elapsed_ms": 120000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        title, data = await board_rows(cog, scope="global")
        self.assertEqual(title, "全サーバー RTAランキング")
        self.assertEqual([r["user_id"] for r in data], ["111", "222", "111"])
        self.assertEqual([r["event_type"] for r in data], ["bump", "vote", "up"])
        self.assertEqual(data[0]["elapsed_ms"], 50000)  # (111, bump) の最小
        self.assertEqual(data[0]["attempts"], 2)        # (111, bump) の2回分
        self.assertEqual(data[2]["attempts"], 1)        # (111, up) は別集計
        title, data = await board_rows(cog, scope="global", slowest=True)
        self.assertEqual([r["user_id"] for r in data], ["111", "222", "111"])
        self.assertEqual([r["event_type"] for r in data], ["up", "vote", "bump"])
        self.assertEqual([r["elapsed_ms"] for r in data], [200000, 120000, 80000])
        self.assertEqual(data[2]["attempts"], 2)        # (111, bump) の最大側

    async def test_board_rows_carry_service_labels(self):
        from unittest.mock import patch
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "111", "event_type": "up",
             "elapsed_ms": 30000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "1", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 50000, "completed_at": T0.isoformat()},
            {"guild_id": "2", "user_id": "111", "event_type": "bump",
             "elapsed_ms": 80000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        with patch("core.game.rta.settings.render_leaderboard_png",
                   return_value=b"\x89PNG-fake") as render:
            embed, png = await board_embed(cog, scope="local")
        rows = render.call_args.kwargs["sections"][0][1]
        self.assertEqual(png, b"\x89PNG-fake")
        # 同じユーザーの2行とも名前は同じで、sub にサービス名が入る
        self.assertEqual([r.name for r in rows], ["user-111", "user-111"])
        self.assertEqual([r.sub for r in rows], ["up", "bump"])
        with patch("core.game.rta.settings.render_leaderboard_png",
                   return_value=b"\x89PNG-fake") as render:
            embed, png = await board_embed(cog, scope="global")
        rows = render.call_args.kwargs["sections"][0][1]
        # global はサービス名に試行回数を併記する
        self.assertEqual([r.sub for r in rows], ["bump ・ 2回"])

    async def test_me_lists_entries_per_service(self):
        db = FakeDb()
        db.tables["bump_rta_records"] = [
            {"guild_id": "456", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 40000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "321", "event_type": "up",
             "elapsed_ms": 25000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_worst_records"] = [
            {"guild_id": "456", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 90000, "completed_at": T0.isoformat()},
            {"guild_id": "456", "user_id": "321", "event_type": "vote",
             "elapsed_ms": 180000, "completed_at": T0.isoformat()},
        ]
        db.tables["bump_rta_events"] = [
            {"guild_id": "999", "user_id": "321", "event_type": "dicoall",
             "elapsed_ms": 8000, "completed_at": T0.isoformat()},
            {"guild_id": "999", "user_id": "321", "event_type": "bump",
             "elapsed_ms": 300000, "completed_at": T0.isoformat()},
        ]
        cog = make_cog(db)
        embed, png = await board_embed(cog, scope="me")
        self.assertIsNone(png)
        self.assertIn("自己ベスト", embed.description)
        # 種類ごとに行が出て、欠けた側は「記録なし」になる
        self.assertIn("bump: このサーバー **40.00秒** / 全サーバー **300.00秒**",
                      embed.description)
        self.assertIn("up: このサーバー **25.00秒** / 全サーバー 記録なし",
                      embed.description)
        self.assertIn("Dicoall: このサーバー 記録なし / 全サーバー **8.00秒**",
                      embed.description)
        embed, png = await board_embed(cog, scope="me", slowest=True)
        self.assertIsNone(png)
        self.assertIn("最遅記録", embed.description)
        self.assertIn("bump: このサーバー **90.00秒** / 全サーバー **300.00秒**",
                      embed.description)
        self.assertIn("鯖ちゃんねる: このサーバー **180.00秒** / 全サーバー 記録なし",
                      embed.description)

    async def test_empty_board_is_text_not_error(self):
        cog = make_cog(FakeDb())
        embed, png = await board_embed(cog, scope="local")
        self.assertIsNone(png)
        self.assertIn("まだ記録がありません", embed.description)
        embed, png = await board_embed(cog, scope="global", slowest=True)
        self.assertIsNone(png)
        self.assertIn("まだ記録がありません", embed.description)


if __name__ == "__main__":
    unittest.main()
