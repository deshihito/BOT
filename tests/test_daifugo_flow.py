"""大富豪（cogs/daifugo.py）のテスト。出せる手・革命・場の流れと、偽の Discord 部品での流れ。d1 には接続しない。"""

import asyncio
import random
import re
import types
import unittest
from unittest.mock import patch

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, real_sleep
from cogs import daifugo as d
from core.support import guild_settings
from core.game.game import autoplay, party_ranking
EMOJI = re.compile('[\U0001F000-\U0001FFFF\u2600-\u27BF\u2B00-\u2BFF\u23E9-\u23FA]')


def game(hands, turn=1):
    g = d.DaifugoGame(1, 1, 1)
    for uid in hands:
        g.players[uid] = uid
    g.hands = {u: list(h) for u, h in hands.items()}
    g.phase, g.turn = 'playing', turn
    return g


class LogicTest(unittest.TestCase):
    def test_strength(self):
        self.assertLess(d.strength('3'), d.strength('K'))
        self.assertLess(d.strength('A'), d.strength('2'))
        self.assertLess(d.strength('2'), d.strength('JOKER'))
        self.assertGreater(d.strength('3', True), d.strength('2', True))
        self.assertEqual(d.strength('JOKER', True), 100)

    def test_legal_plays(self):
        hand = ['S3', 'H3', 'D5', 'S5', 'C5', 'H2', 'JOKER']
        plays = d.legal_plays(hand, None, False)
        ranks = [(len(p), d.rank(p[0])) for p in plays]
        self.assertIn((1, '3'), ranks)
        self.assertIn((3, '5'), ranks)
        self.assertIn(('JOKER',), plays)
        self.assertNotIn(('JOKER', 'H2'), plays)
        on_pair = d.legal_plays(hand, ('S4', 'H4'), False)
        self.assertEqual([p[0][1:] for p in on_pair], ['5'])
        self.assertTrue(all(len(p) == 2 for p in on_pair))
        on_two = d.legal_plays(hand, ('S2',), False)
        self.assertEqual(on_two, [('JOKER',)])
        on_k_rev = d.legal_plays(hand, ('SK',), True)   # 革命中は弱い数字が強い
        self.assertIn('3', [d.rank(p[0]) for p in on_k_rev])
        self.assertNotIn(('H2',), on_k_rev)
        g = game({1: ['S3', 'H3', 'D9']})
        self.assertTrue(g.can_play(1, ('S3',)))
        self.assertTrue(g.can_play(1, ('S3', 'H3')))
        self.assertFalse(g.can_play(1, ('S3', 'D9')))
        self.assertFalse(g.can_play(1, ('C3',)))

    def test_titles(self):
        self.assertEqual(d.titles(3), ['大富豪', '平民', '大貧民'])
        self.assertEqual(d.titles(4), ['大富豪', '富豪', '貧民', '大貧民'])
        self.assertEqual(d.titles(6), ['大富豪', '富豪', '平民', '平民', '貧民', '大貧民'])

    def test_clear_after_all_pass(self):
        g = game({1: ['S9', 'S4'], 2: ['S5'], 3: ['S6']})
        self.assertEqual(g.play(1, ('S9',)), 'ok')
        self.assertEqual(g.turn, 2)
        self.assertEqual(g.play(2, ('S5',)), 'invalid')
        self.assertTrue(g.pass_turn(2))
        self.assertTrue(g.pass_turn(3))
        self.assertIsNone(g.table)
        self.assertTrue(g.cleared)
        self.assertEqual(g.turn, 1)
        self.assertFalse(g.pass_turn(1))           # 場が空ならパスできない

    def test_finish_and_lead_passes_on(self):
        g = game({1: ['S9'], 2: ['S5', 'H7'], 3: ['S6', 'D4']})
        g.play(1, ('S9',))
        self.assertEqual(g.finished, [1])
        g.pass_turn(2)
        g.pass_turn(3)
        self.assertEqual(g.turn, 2)                # 上がった人の次から
        g.play(2, ('S5',))
        g.play(3, ('S6',))
        self.assertEqual(g.turn, 2)
        g.play(2, ('H7',))
        self.assertEqual(g.phase, 'done')
        self.assertEqual(g.results(), [(1, '大富豪'), (2, '平民'), (3, '大貧民')])

    def test_revolution(self):
        g = game({1: ['S8', 'H8', 'D8', 'C8', 'S3'], 2: ['S4', 'H4', 'D4', 'C4', 'SK'], 3: ['H2']})
        self.assertEqual(g.play(1, ('S8', 'H8', 'D8', 'C8')), 'revolution')
        self.assertTrue(g.revolution)
        # 8切りも同時に発動する: 場は流れ、出した本人が続けてリードする
        # （2026-11-07 の 8切り仕様修正に合わせて手順を追随）。
        self.assertIsNone(g.table)
        self.assertEqual(g.turn, 1)
        self.assertEqual(g.play(1, ('S3',)), 'ok')          # 革命中は 3 が強い。1 はこれで上がり
        self.assertTrue(g.pass_turn(2))
        self.assertTrue(g.pass_turn(3))                     # 全員パスで場が流れ、2 から
        self.assertEqual(g.turn, 2)
        self.assertEqual(g.play(2, ('S4', 'H4', 'D4', 'C4')), 'revolution')   # 革命返し
        self.assertFalse(g.revolution)

    def test_registered(self):
        self.assertTrue(party_ranking.is_ranked('daifugo'))
        self.assertIn('daifugo', party_ranking.KNOWN_GAMES)
        from core.game.game.game_guides import GAME_GUIDES
        self.assertIsNone(EMOJI.search(str(GAME_GUIDES['daifugo'])))


class DaifugoFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(66)
        self.channel = FakeChannel(660, self.guild)
        self.members = {i: FakeMember(i, self.guild) for i in (1, 2, 3)}
        self.cog = d.Daifugo(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.members[1], self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        view = self.channel.sent[-1].view
        for m in joiners:
            await view.join.callback(FakeInteraction(m, self.channel))
        return task

    def assert_no_emoji(self):
        self.assertEqual([t for t in self.channel.texts() if EMOJI.search(t)], [])

    async def test_three_humans_play_by_menu(self):
        before = sum(party_ranking.shared().memory.get((66, 'daifugo'), {}).values())
        with fast_time(scale=0.002):
            task = await self.start([self.members[2], self.members[3]])
            checked = False
            while not task.done():
                g = self.cog.games.get(self.channel.id)
                msg = self.channel.sent[-1] if self.channel.sent else None
                if g is None or g.phase != 'playing' or g.acted or not isinstance(getattr(msg, 'view', None), d.TurnView):
                    await real_sleep(0.002)
                    continue
                user = self.members[g.turn]
                if not checked:
                    other = self.members[g.next_active(g.turn)]
                    wrong = FakeInteraction(other, self.channel)
                    await msg.view.open_hand.callback(wrong)
                    self.assertIn('あなたの番ではありません', wrong.response.sent[0].text())
                    checked = True
                inter = FakeInteraction(user, self.channel)
                await msg.view.open_hand.callback(inter)
                sent = inter.response.sent[0]
                if sent.view is None:      # 出せない → パス
                    await msg.view.pass_button.callback(FakeInteraction(user, self.channel))
                    continue
                select = sent.view.children[0]
                select._values = ['0']
                if hasattr(select, '_selected_values'):
                    select._selected_values = ['0']
                await select.callback(FakeInteraction(user, self.channel))
            await task
        texts = self.channel.texts()
        self.assertIn('大富豪 終了', texts[-1])
        for t in ('大富豪:', '平民:', '大貧民:'):
            self.assertIn(t, texts[-1])
        self.assertEqual(sum(party_ranking.shared().memory.get((66, 'daifugo'), {}).values()), before + 1)
        self.assert_no_emoji()
        self.assertEqual(self.cog.games, {})

    async def test_solo_with_bots_and_timeout_pass(self):
        before = dict(party_ranking.shared().memory.get((66, 'daifugo'), {}))
        with fast_time(scale=0.0005), patch.object(autoplay, 'take_idle_turn') as take_idle_turn:
            task = await self.start([])
            await asyncio.wait_for(task, 20)
        take_idle_turn.assert_not_called()
        texts = self.channel.texts()
        self.assertTrue(any('時間切れのため' in t for t in texts))
        self.assertIn('Bot1', texts[-1])
        self.assertIn('ランキングに数えません', texts[-1])
        self.assert_no_emoji()
        self.assertEqual(dict(party_ranking.shared().memory.get((66, 'daifugo'), {})), before)

    async def test_autoplay_off_passes(self):
        with fast_time(scale=0.0005), patch.object(guild_settings, 'autoplay_enabled', lambda gid: False):
            task = await self.start([self.members[2]])
            await asyncio.wait_for(task, 30)
        texts = self.channel.texts()
        self.assertTrue(any('時間切れのため' in t for t in texts))
        self.assertIn('大富豪 終了', texts[-1])
        self.assert_no_emoji()

    async def test_finish_auto_ended_message_and_cleanup(self):
        # 終了ガードで終わった対局: 結果に自動終了の旨が出て、行動ログが消える。
        g = game({1: ['S3'], -1: ['H2'], -2: ['D4']})
        g.players[1] = self.members[1]
        g.auto_ended = True
        g.finished = [-1, 1, -2]
        g.phase = 'done'
        log_msg = await self.channel.send('行動ログ')
        self.cog._logs[self.channel.id] = log_msg
        await self.cog.finish(self.channel, g)
        self.assertTrue(log_msg.deleted)
        last = self.channel.texts()[-1]
        self.assertIn('大富豪 終了', last)
        self.assertIn('自動終了', last)
        self.assertIn('残り手札の少ない順', last)

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            task = await self.start([])
            again = FakeInteraction(self.members[2], self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既に大富豪が進行中', again.response.sent[0].text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.cog.games, {})


if __name__ == '__main__':
    unittest.main()
