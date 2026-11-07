"""人狼の振り返り表（core/game/jinrou/jinrou_review.py と cogs/jinrou.py の記録）のテスト。通信はしない。"""

import unittest
from unittest.mock import MagicMock, patch

import discord

from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeMember
from cogs import jinrou
from core.game.jinrou import jinrou_review as review
def view_text(view):
    return "\n".join(
        item.content or "" for item in view.walk_children()
        if isinstance(item, discord.ui.TextDisplay))


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

    def test_view_and_reset(self):
        g = self.game(['人狼', '占い師', '騎士', '村人', '村人'])
        review.record_night(g, 1, {}, set(), {1: (4, 'success')}, [4])
        review.record_day(g, 1, [1])
        review.record_day(g, 2, [])
        view = review.build_view(g)
        self.assertIsInstance(view, discord.ui.LayoutView)
        text = view_text(view)
        for heading in ('振り返り表', '**第1夜**', '**第1日 投票**', '**第2日 投票**', '**役職**'):
            self.assertIn(heading, text)
        self.assertLess(text.index('**第1夜**'), text.index('**第1日 投票**'))
        self.assertLess(text.index('**第2日 投票**'), text.index('**役職**'))
        self.assertIn('追放: P1', text)
        self.assertIn('追放なし', text)
        self.assertIn('P1: 人狼', text)
        g.reset_for_new_game()
        self.assertEqual(g.review, [])

    def test_view_limits(self):
        g = self.game(['人狼', '村人', '村人', '村人', '村人'])
        for i in range(40):
            review.record_day(g, i, [1, 2, 3])
        text = view_text(review.build_view(g))
        # V2 TextDisplay の上限（4000字）に収まること。節は最大24件＋役職節。
        self.assertLessEqual(len(text), 4000)
        self.assertIn('**役職**', text)

    def test_names_from_players_not_guild(self):
        g = self.game(['人狼', '村人', '村人', '村人', '村人'])
        other = FakeMember(99, FakeGuild(2), name='よそのサーバー')  # 別サーバーの参加者
        g.players.append(other)
        g.roles[99] = '村人'
        self.assertEqual(review.name_of(g, 99), 'よそのサーバー')


if __name__ == '__main__':
    unittest.main()
