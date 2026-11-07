"""UNO の勝者がランキングに記録されるかのテスト。"""

import unittest

from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeMember
import core.game.uno.cog as uno
from core.game.game import party_ranking
class UnoRankingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)
        self.guild = FakeGuild(5)
        self.channel = FakeChannel(210, self.guild)
        self.players = [FakeMember(i, self.guild) for i in (1, 2)]
        self.cog = uno.Uno(FakeBot(self.channel))

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def test_winner_recorded_once(self):
        game = uno.UnoGame(self.channel.id, 1)
        game.players = [1, 2]
        game.hands = {1: [], 2: ['赤の1']}
        self.cog.games[self.channel.id] = game
        await self.cog.finish_game(self.channel.id, 1)
        await self.cog.finish_game(self.channel.id, 1)  # 二重に呼ばれても 1 回だけ
        self.assertEqual(await party_ranking.shared().top(5, 'uno'), [(1, 1)])
        self.assertTrue(party_ranking.is_ranked('uno'))
