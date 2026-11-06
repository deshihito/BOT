"""人狼の振り返り表（core/game/jinrou_review.py と cogs/jinrou.py の記録）のテスト。通信はしない。"""

import unittest
from unittest.mock import MagicMock, patch

from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeMember
from cogs import jinrou
from core.game import jinrou_review as review


class JinrouReviewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(310, self.guild)
        self.players = [FakeMember(i, self.guild) for i in range(1, 6)]
        self.cog = jinrou.JinrouCog(FakeBot(self.channel))
        sb = patch.object(jinrou, 'db_api', MagicMock())
        sb.start()
        self.addCleanup(sb.stop)

    def game(self, roles):
        game = self.cog.get_game(self.channel.id)
        game.is_running = game.started = True
        game.game_channel = self.channel
        game.players = list(self.players)
        game.alive_players = list(self.players)
        game.roles = dict(zip([p.id for p in self.players], roles))
        game.day_count = 1
        return game

    async def test_guarded_attack_and_divine(self):
        g = self.game(['人狼', '占い師', '騎士', '村人', '村人'])
        review.note_divine(g, 2, 1, '黒')
        g.night_actions = {1: 4, 2: 1, 3: 4}
        await self.cog.process_night_results(g)
        kind, n, lines = g.review[-1]
        text = '\n'.join(lines)
        self.assertEqual((kind, n), ('night', 1))
        self.assertIn('P2 が P1 を占い →【黒】', text)
        self.assertIn('P3 が P4 を護衛', text)
        self.assertIn('P1 が P4 を襲撃 → 護衛で失敗', text)
        self.assertIn('犠牲者なし', text)
        self.assertEqual(len(g.alive_players), 5)  # ルールは変わらない

    async def test_successful_attack(self):
        g = self.game(['人狼', '村人', '村人', '村人', '村人'])
        g.night_actions = {1: 5}
        await self.cog.process_night_results(g)
        text = '\n'.join(g.review[-1][2])
        self.assertIn('襲撃 → 成功', text)
        self.assertIn('犠牲: P5', text)

    async def test_trap(self):
        g = self.game(['人狼', '罠師', '村人', '村人', '村人'])
        g.night_actions = {1: 3, 2: 3}
        await self.cog.process_night_results(g)
        text = '\n'.join(g.review[-1][2])
        self.assertIn('罠で返り討ち', text)
        self.assertIn('犠牲: P1', text)

    def test_embed_and_reset(self):
        g = self.game(['人狼', '占い師', '騎士', '村人', '村人'])
        review.record_night(g, 1, {}, set(), {1: (4, 'success')}, [4])
        review.record_day(g, 1, [1])
        review.record_day(g, 2, [])
        embed = review.build_embed(g)
        self.assertEqual([f.name for f in embed.fields], ['第1夜', '第1日 投票', '第2日 投票', '役職'])
        self.assertIn('追放: P1', embed.fields[1].value)
        self.assertIn('追放なし', embed.fields[2].value)
        self.assertIn('P1: 人狼', embed.fields[-1].value)
        g.reset_for_new_game()
        self.assertEqual(g.review, [])

    def test_embed_limits(self):
        g = self.game(['人狼', '村人', '村人', '村人', '村人'])
        for i in range(40):
            review.record_day(g, i, [1, 2, 3])
        embed = review.build_embed(g)
        self.assertLessEqual(len(embed.fields), 25)
        self.assertLessEqual(len(embed), 6000)

    def test_names_from_players_not_guild(self):
        g = self.game(['人狼', '村人', '村人', '村人', '村人'])
        other = FakeMember(99, FakeGuild(2), name='よそのサーバー')  # 別サーバーの参加者
        g.players.append(other)
        g.roles[99] = '村人'
        self.assertEqual(review.name_of(g, 99), 'よそのサーバー')


if __name__ == '__main__':
    unittest.main()
