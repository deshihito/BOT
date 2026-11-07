"""月次シーズンランキング（core/game/game/party_ranking.py の monthly）のテスト。"""

import unittest

from core.game.game import party_ranking
class MonthlyRankingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ranking = party_ranking.PartyRanking(client=None)

    async def test_record_win_counts_monthly_total_across_games(self):
        await self.ranking.record_win(100, 1, "uno")
        await self.ranking.record_win(100, 1, "janken")
        await self.ranking.record_win(100, 2, "uno")
        rows = await self.ranking.monthly_top(100)
        self.assertEqual(rows, [(1, 2), (2, 1)])

    async def test_monthly_is_per_guild(self):
        await self.ranking.record_win(100, 1, "uno")
        await self.ranking.record_win(200, 1, "uno")
        await self.ranking.record_win(200, 1, "uno")
        self.assertEqual(await self.ranking.monthly_top(100), [(1, 1)])
        self.assertEqual(await self.ranking.monthly_top(200), [(1, 2)])

    async def test_other_month_is_empty(self):
        await self.ranking.record_win(100, 1, "uno")
        self.assertEqual(await self.ranking.monthly_top(100, month="1999-01"), [])

    async def test_unknown_game_not_counted(self):
        await self.ranking.record_win(100, 1, "not_a_game")
        self.assertEqual(await self.ranking.monthly_top(100), [])

    async def test_limit(self):
        for uid in range(1, 15):
            await self.ranking.record_win(100, uid, "uno")
        rows = await self.ranking.monthly_top(100, limit=10)
        self.assertEqual(len(rows), 10)


if __name__ == "__main__":
    unittest.main()
