"""core/game/game/party_ranking.py と /game のランキング表示のテスト。偽の Supabase で動かし、通信はしない。"""

import types
import unittest

import game_fakes  # noqa: F401  (sys.path と環境変数の準備)
from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember
from core.game.game import party_ranking
import core.game.game.cog as game


class _Res:
    def __init__(self, data):
        self.data = data


class FakeRPCClient:
    """party_game_record_win とビュー party_game_ranking だけを持つ偽物。"""
    def __init__(self, missing=False):
        self.missing = missing
        self.wins = {}
        self.calls = []

    def rpc(self, name, params):
        client = self

        class Call:
            def execute(self_inner):
                client.calls.append((name, params))
                if client.missing:
                    raise Exception("PGRST202 Could not find the function public.party_game_record_win")
                assert name == "party_game_record_win"
                key = (params["p_guild_id"], params["p_user_id"], params["p_game"])
                client.wins[key] = client.wins.get(key, 0) + 1
                return _Res(client.wins[key])
        return Call()

    def table(self, name):
        client = self
        q = types.SimpleNamespace(filters={}, n=None)

        class Query:
            def select(self, cols):
                return self

            def eq(self, col, val):
                q.filters[col] = val
                return self

            def order(self, col, desc=False):
                return self

            def limit(self, n):
                q.n = n
                return self

            def execute(self):
                client.calls.append(("select", name))
                if client.missing:
                    raise Exception("PGRST205 Could not find the table 'public.party_game_ranking'")
                rows = [{"user_id": u, "wins": w} for (g, u, gm), w in client.wins.items()
                        if g == q.filters["guild_id"] and gm == q.filters["game"]]
                rows.sort(key=lambda r: -r["wins"])
                return _Res(rows[:q.n])
        return Query()


class PartyRankingTest(unittest.IsolatedAsyncioTestCase):
    async def test_records_remote_and_memory(self):
        client = FakeRPCClient()
        r = party_ranking.PartyRanking(client=client)
        await r.record_win(1, 10, "ngword")
        await r.record_win(1, 10, "ngword")
        await r.record_win(1, 20, "ngword")
        self.assertEqual(client.calls[0], ("party_game_record_win",
                                           {"p_guild_id": 1, "p_user_id": 10, "p_game": "ngword"}))
        self.assertEqual(await r.top(1, "ngword"), [(10, 2), (20, 1)])
        self.assertEqual(r.memory[(1, "ngword")], {10: 2, 20: 1})

    async def test_missing_function_falls_back_to_memory(self):
        client = FakeRPCClient(missing=True)
        r = party_ranking.PartyRanking(client=client)
        with self.assertLogs("core.game.game.party_ranking", level="WARNING"):
            await r.record_win(1, 10, "ngword")
        self.assertTrue(r.remote_disabled)
        await r.record_win(1, 10, "ngword")
        self.assertEqual(len(client.calls), 1)  # 2 回目からは送らない
        self.assertEqual(await r.top(1, "ngword"), [(10, 2)])

    async def test_unknown_game_and_bad_ids_ignored(self):
        client = FakeRPCClient()
        r = party_ranking.PartyRanking(client=client)
        await r.record_win(1, 10, "mahjong")
        await r.record_win(None, 10, "ngword")
        self.assertEqual(client.calls, [])
        self.assertEqual(r.memory, {})

    async def test_no_client(self):
        r = party_ranking.PartyRanking(client=None)
        await r.record_win(1, 10, "ngword")
        self.assertEqual(await r.top(1, "ngword"), [(10, 1)])
        self.assertEqual(await r.top(2, "ngword"), [])


class RankingButtonTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def test_ranking_embed(self):
        self.assertIn("まだ記録がありません", (await game.ranking_embed(1, "ngword")).description)
        await party_ranking.shared().record_win(1, 7, "ngword")
        await party_ranking.shared().record_win(1, 7, "ngword")
        await party_ranking.shared().record_win(1, 8, "ngword")
        embed, png = await game.ranking_board(1, "ngword")
        self.assertIn("NGワード", embed.title)
        # 記録があるときは順位表を画像で出し、embed は添付を指す
        self.assertIsNotNone(png)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(embed.image.url, "attachment://game_ranking.png")
        # 集計そのものは従来どおり（勝利数の多い順）
        rows = await party_ranking.shared().top(1, "ngword", limit=10)
        self.assertEqual(rows, [(7, 2), (8, 1)])
        # ranking_embed は embed だけを返す互換ラッパ
        embed_only = await game.ranking_embed(1, "ngword")
        self.assertEqual(embed_only.title, embed.title)
        self.assertNotIn("<@", embed_only.title)

    async def test_ranking_button_in_detail_view(self):
        guild = FakeGuild()
        channel = FakeChannel(700, guild)
        host = FakeMember(1, guild)
        view = game.GameDetailView(types.SimpleNamespace(), "ngword")
        inter = FakeInteraction(host, channel)
        await game_fakes.press(view, "ranking", inter)
        self.assertIn("サーバーランキング", inter.response.sent[0].text())


if __name__ == "__main__":
    unittest.main()
