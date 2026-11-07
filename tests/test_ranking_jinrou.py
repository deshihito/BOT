"""人狼の勝った陣営がランキングに記録されるかのテスト。"""

import types
import unittest

from game_fakes import FakeChannel, FakeGuild
import core.game.jinrou.entry as jinrou
from core.game.game import party_ranking
def player(uid):
    return types.SimpleNamespace(id=uid)


class JinrouRankingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)
        guild = FakeGuild(8)
        roles = {1: "村人", 2: "占い師", 3: "人狼", 4: "狂人", 5: "ハゲ", 6: "コウモリむに", 7: "ワンころ"}
        self.game = types.SimpleNamespace(
            game_channel=FakeChannel(240, guild), roles=roles, wan_owner={7: 1},
            players=[player(i) for i in roles], alive_players=[player(i) for i in (1, 3, 6, 7)])
        self.cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def top(self):
        return dict(await party_ranking.shared().top(8, 'jinrou'))

    async def test_village_win_whole_team(self):
        await self.cog._record_team_win(self.game, winner_is_wolf=False)
        # 村人・占い師（死亡）・飼い主が生きているワンころ・生き残ったコウモリむに
        self.assertEqual(await self.top(), {1: 1, 2: 1, 7: 1, 6: 1})

    async def test_wolf_win_whole_team(self):
        self.game.alive_players = [player(3), player(7)]   # 飼い主が死んでワンころは野良（人狼側）
        await self.cog._record_team_win(self.game, winner_is_wolf=True)
        self.assertEqual(await self.top(), {3: 1, 4: 1, 7: 1})

    async def test_hage_win(self):
        await self.cog._record_wins(self.game, [5, 5])
        self.assertEqual(await self.top(), {5: 1})
        self.assertTrue(party_ranking.is_ranked('jinrou'))
