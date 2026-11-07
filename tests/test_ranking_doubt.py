"""ダウトの勝者がランキングに記録されるかのテスト。"""

import types
import unittest

from game_fakes import FakeChannel, FakeGuild
from cogs import doubt
from core.game.game import party_ranking
class DoubtRankingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def test_winner_recorded_once(self):
        guild = FakeGuild(6)
        channel = FakeChannel(220, guild)
        cog = doubt.Doubt(types.SimpleNamespace())
        game = object()
        cog.games[channel.id] = game
        await cog.declare_winner(channel, game, 3)
        await cog.declare_winner(channel, game, 3)  # 終わったゲームでは数えない
        self.assertEqual(await party_ranking.shared().top(6, 'doubt'), [(3, 1)])
        self.assertTrue(party_ranking.is_ranked('doubt'))
