"""人狼のレート（jinrou_ratings）の更新とランキング表示のテスト。Supabase は偽物。"""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import game_fakes  # noqa: E402,F401
from cogs import jinrou  # noqa: E402


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.values, self.filters, self.order_desc, self.lim = db, table, "select", None, {}, None, None

    def select(self, *_):
        self.op = "select"; return self

    def insert(self, values):
        self.op, self.values = "insert", values; return self

    def update(self, values):
        self.op, self.values = "update", values; return self

    def eq(self, col, val):
        self.filters[col] = val; return self

    def order(self, col, desc=False):
        self.order_desc = (col, desc); return self

    def limit(self, n):
        self.lim = n; return self

    def execute(self):
        rows = self.db.rows
        match = [r for r in rows if all(r.get(k) == v for k, v in self.filters.items())]
        if self.op == "insert":
            row = {"id": len(rows) + 1, "rating": 1500.0, "wins": 0, "losses": 0, "games_played": 0, **self.values}
            rows.append(row)
            return types.SimpleNamespace(data=[row])
        if self.op == "update":
            for r in match:
                r.update(self.values)
            return types.SimpleNamespace(data=match)
        if self.order_desc:
            col, desc = self.order_desc
            match = sorted(match, key=lambda r: r[col], reverse=desc)
        return types.SimpleNamespace(data=[dict(r) for r in match[: self.lim or None]])


class FakeDB:
    def __init__(self, rows=()):
        self.rows = [dict(r) for r in rows]

    def table(self, name):
        assert name == jinrou.RATINGS_TABLE
        return FakeQuery(self, name)


def game_with(roles):
    game = jinrou.JinrouGame()
    game.players = [types.SimpleNamespace(id=i) for i in roles]
    game.alive_players = list(game.players)
    game.roles = dict(roles)
    return game


class RatingTest(unittest.IsolatedAsyncioTestCase):
    def use(self, db):
        p = patch.object(jinrou, "db_api", db)
        p.start()
        self.addCleanup(p.stop)

    def cog(self):
        return jinrou.JinrouCog.__new__(jinrou.JinrouCog)

    def by_id(self, db):
        return {r["player_id"]: r for r in db.rows}

    async def test_village_win_saves_everyone(self):
        db = FakeDB()
        self.use(db)
        game = game_with({1: "人狼", 2: "占い師", 3: "騎士", 4: "一般通過あごむに", 5: "狂人"})
        await self.cog()._process_elo_ratings(game, winner_is_wolf=False)
        rows = self.by_id(db)
        self.assertEqual(set(rows), {1, 2, 3, 4, 5})
        for pid in (2, 3, 4):
            self.assertGreater(rows[pid]["rating"], 1500)
            self.assertEqual((rows[pid]["wins"], rows[pid]["losses"], rows[pid]["games_played"]), (1, 0, 1))
        for pid in (1, 5):
            self.assertLess(rows[pid]["rating"], 1500)
            self.assertEqual((rows[pid]["wins"], rows[pid]["losses"]), (0, 1))

    async def test_result_does_not_depend_on_order(self):
        rows = [{"id": i, "player_id": i, "rating": r, "wins": 0, "losses": 0, "games_played": 0}
                for i, r in ((1, 1600.0), (2, 1400.0), (3, 1500.0), (4, 1550.0))]
        roles = {1: "人狼", 2: "占い師", 3: "騎士", 4: "一般通過あごむに"}
        a, b = FakeDB(rows), FakeDB(rows)
        self.use(a)
        await self.cog()._process_elo_ratings(game_with(roles), winner_is_wolf=True)
        self.use(b)
        g = game_with(roles)
        g.players.reverse()
        await self.cog()._process_elo_ratings(g, winner_is_wolf=True)
        for pid in roles:
            self.assertAlmostEqual(self.by_id(a)[pid]["rating"], self.by_id(b)[pid]["rating"])

    async def test_second_game_updates_existing_rows(self):
        db = FakeDB()
        self.use(db)
        roles = {1: "人狼", 2: "占い師", 3: "騎士"}
        await self.cog()._process_elo_ratings(game_with(roles), winner_is_wolf=True)
        await self.cog()._process_elo_ratings(game_with(roles), winner_is_wolf=False)
        self.assertEqual(len(db.rows), 3)
        self.assertEqual(self.by_id(db)[1]["games_played"], 2)
        self.assertEqual(self.by_id(db)[2]["wins"], 1)

    async def test_db_error_does_not_break_game_end(self):
        class Broken:
            def table(self, _):
                raise RuntimeError("down")
        self.use(Broken())
        await self.cog()._process_elo_ratings(game_with({1: "人狼", 2: "占い師"}), winner_is_wolf=True)

    async def test_ranking_shows_saved_ratings(self):
        db = FakeDB()
        self.use(db)
        await self.cog()._process_elo_ratings(game_with({1: "人狼", 2: "占い師", 3: "騎士"}), winner_is_wolf=True)
        top = await jinrou.get_top_ratings(10)
        self.assertEqual(top[0]["player_id"], 1)
        cog = self.cog()
        cog.bot = types.SimpleNamespace(fetch_user=AsyncMock(side_effect=lambda i: types.SimpleNamespace(display_name=f"u{i}")))
        embed = await cog.rating_embed(types.SimpleNamespace(id=1, display_name="me"))
        self.assertIn("u1", embed.description)
        self.assertIn("me", embed.description)
        self.assertEqual(embed.description.count("pts"), 4)  # 自分のレート + 上位3人


if __name__ == "__main__":
    unittest.main()
