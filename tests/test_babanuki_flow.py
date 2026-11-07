"""ババ抜き（cogs/babanuki.py）のテスト。ペアの捨て方・引き方と、偽の Discord 部品での流れ。d1 には接続しない。"""

import asyncio
import random
import re
import types
import unittest
from unittest.mock import patch

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, real_sleep
import core.game.babanuki.cog as b
from core.support import guild_settings
from core.game.game import autoplay, party_ranking
EMOJI = re.compile('[\U0001F000-\U0001FFFF\u2600-\u27BF\u2B00-\u2BFF\u23E9-\u23FA]')


class LogicTest(unittest.TestCase):
    def test_deck(self):
        deck = b.make_deck()
        self.assertEqual(len(deck), 53)
        self.assertIn('S10', deck)
        self.assertIn('JOKER', deck)
        self.assertEqual(b.rank('H10'), '10')
        self.assertEqual(b.rank('JOKER'), 'JOKER')

    def test_discard_pairs(self):
        rest, pairs = b.discard_pairs(['S5', 'H5', 'D5', 'CK', 'JOKER', 'SK', 'H2'])
        self.assertEqual(sorted(rest), ['D5', 'H2', 'JOKER'])
        self.assertEqual(pairs, [('S5', 'H5'), ('CK', 'SK')])
        rest, pairs = b.discard_pairs(['S5', 'H5', 'D5', 'C5'])
        self.assertEqual((rest, len(pairs)), ([], 2))

    def test_deal_and_max_hand(self):
        for seed in range(20):
            g = b.BabanukiGame(1, 1, 1)
            g.players = {1: 1, 2: 2}
            g.start(random.Random(seed))
            self.assertEqual(sum(len(h) for h in g.hands.values()) % 2, 1)   # ジョーカーの分だけ奇数
            for h in g.hands.values():
                self.assertLessEqual(len(h), 14)          # ボタンに収まる
                self.assertEqual(len({b.rank(c) for c in h}), len(h))

    def test_draw_and_finish(self):
        g = b.BabanukiGame(1, 1, 1)
        g.players = {1: 1, 2: 2, 3: 3}
        g.hands = {1: ['S5'], 2: ['H5', 'JOKER'], 3: ['D9']}
        g.phase = 'playing'
        self.assertEqual(g.current, 1)
        self.assertEqual(g.target_of(1), 2)
        card, pairs = g.draw(1, g.hands[2].index('H5'), random.Random(0))
        self.assertEqual((card, pairs), ('H5', [('S5', 'H5')]))
        self.assertEqual(g.finished, [1])
        self.assertEqual(g.current, 2)                 # 1 は上がり
        self.assertEqual(g.target_of(2), 3)
        g.draw(2, 0, random.Random(0))                  # 2 が D9 を引く → 3 が上がり
        self.assertEqual(g.finished, [1, 3])
        self.assertEqual((g.phase, g.loser), ('done', 2))

    def test_registered(self):
        self.assertTrue(party_ranking.is_ranked('babanuki'))
        self.assertIn('babanuki', party_ranking.KNOWN_GAMES)

    def test_guide_has_no_emoji(self):
        from core.game.game.game_guides import GAME_GUIDES
        self.assertIsNone(EMOJI.search(str(GAME_GUIDES['babanuki'])))


class BabanukiFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(55)
        self.channel = FakeChannel(550, self.guild)
        self.m1, self.m2 = FakeMember(1, self.guild), FakeMember(2, self.guild)
        self.cog = b.Babanuki(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.m1, self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        view = self.channel.sent[-1].view
        for m in joiners:
            await view.join.callback(FakeInteraction(m, self.channel))
        return task

    def assert_no_emoji(self):
        bad = [t for t in self.channel.texts() if EMOJI.search(t)]
        self.assertEqual(bad, [])

    async def test_two_players_by_buttons(self):
        before = party_ranking.shared().memory.get((55, 'babanuki'), {})
        before = dict(before)
        with fast_time(scale=0.002):
            task = await self.start([self.m2])
            while True:
                g = self.cog.games.get(self.channel.id)
                if g is None or g.phase != 'playing':
                    if task.done():
                        break
                    await real_sleep(0.002)
                    continue
                msg = self.channel.sent[-1]
                if msg.view is None or not isinstance(msg.view, b.TurnView) or g.drawn is not None:
                    await real_sleep(0.002)
                    continue
                user = self.m1 if g.current == 1 else self.m2
                # 手札を見る（本人にだけ）
                hand = FakeInteraction(user, self.channel)
                await msg.view.hand_button.callback(hand)
                self.assertIn('あなたの手札', hand.response.sent[0].text())
                other = self.m2 if user is self.m1 else self.m1
                wrong = FakeInteraction(other, self.channel)
                await msg.view.picks[0].callback(wrong)
                self.assertIn('あなたの番ではありません', wrong.response.sent[0].text())
                pick = FakeInteraction(user, self.channel)
                await msg.view.picks[0].callback(pick)
                self.assertIn('を引きました', pick.response.sent[0].text())
            await task
        texts = self.channel.texts()
        self.assertIn('ババ抜き 終了', texts[-1])
        self.assertIn('ジョーカー', texts[-1])
        after = party_ranking.shared().memory.get((55, 'babanuki'), {})
        self.assertEqual(sum(after.values()), sum(before.values()) + 1)
        self.assert_no_emoji()
        self.assertEqual(self.cog.games, {})

    async def test_solo_vs_bot_with_autoplay(self):
        calls = []

        async def fake_idle(channel, **kw):
            calls.append(kw['legal_actions'])
            return autoplay.AutoplayResult(kw['legal_actions'][-1], autoplay.SOURCE_FALLBACK,
                                           '\u23f0 P1さんが放置したため、代わりに引きました')

        before = dict(party_ranking.shared().memory.get((55, 'babanuki'), {}))
        with fast_time(scale=0.0005), patch.object(autoplay, 'take_idle_turn', fake_idle):
            task = await self.start([])
            await asyncio.wait_for(task, 20)
        self.assertTrue(calls)
        texts = self.channel.texts()
        self.assertTrue(any('放置したため' in t for t in texts))
        self.assertIn('Bot', texts[-1])
        self.assert_no_emoji()
        self.assertEqual(dict(party_ranking.shared().memory.get((55, 'babanuki'), {})), before)

    async def test_autoplay_off_draws_randomly(self):
        with fast_time(scale=0.0005), patch.object(guild_settings, 'autoplay_enabled', lambda gid: False):
            task = await self.start([self.m2])
            await asyncio.wait_for(task, 20)
        texts = self.channel.texts()
        self.assertTrue(any('ランダムに' in t for t in texts))
        self.assertIn('ババ抜き 終了', texts[-1])
        self.assert_no_emoji()

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            task = await self.start([])
            again = FakeInteraction(self.m2, self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既にババ抜きが進行中', again.response.sent[0].text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.cog.games, {})


if __name__ == '__main__':
    unittest.main()
