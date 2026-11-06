"""ワードウルフの勝った側がランキングに記録されるかのテスト。"""

import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeMember
from cogs import wordwolf
from core.game import party_ranking


class WordWolfRankingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)
        self.guild = FakeGuild(7)
        self.channel = FakeChannel(230, self.guild)
        self.members = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = wordwolf.CustomWordWolf(types.SimpleNamespace())
        self.cog.players = list(self.members)
        self.cog.wolf = self.members[2]

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def test_villagers_all_win(self):
        await self.cog.end_game(self.channel, "villager_win")
        self.assertEqual(await party_ranking.shared().top(7, 'wordwolf'), [(1, 1), (2, 1)])

    async def test_wolf_wins_alone(self):
        await self.cog.end_game(self.channel, "wolf_win")
        self.assertEqual(await party_ranking.shared().top(7, 'wordwolf'), [(3, 1)])
        self.assertTrue(party_ranking.is_ranked('wordwolf'))
