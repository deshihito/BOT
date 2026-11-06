"""じゃんけん（cogs/janken.py）のテスト。勝敗の判定と、偽の Discord 部品での流れ。"""

import asyncio
import random
import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, press, real_sleep
from cogs import janken as j
from core.game import party_ranking


class JudgeTest(unittest.TestCase):
    def test_two_players(self):
        self.assertEqual(j.judge({1: 'rock', 2: 'scissors'}), [1])
        self.assertEqual(j.judge({1: 'rock', 2: 'paper'}), [2])
        self.assertEqual(j.judge({1: 'paper', 2: 'scissors'}), [2])

    def test_draws(self):
        self.assertEqual(j.judge({1: 'rock', 2: 'rock'}), [])
        self.assertEqual(j.judge({1: 'rock', 2: 'paper', 3: 'scissors'}), [])

    def test_multi_winners(self):
        self.assertEqual(sorted(j.judge({1: 'paper', 2: 'rock', 3: 'paper'})), [1, 3])

    def test_auto_hand(self):
        self.assertIn(j.auto_hand(random.Random(1)), j.HANDS)

    def test_registered(self):
        self.assertTrue(party_ranking.is_ranked('janken'))
        self.assertIn('janken', party_ranking.KNOWN_GAMES)


class JankenFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(77)
        self.channel = FakeChannel(700, self.guild)
        self.members = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = j.Janken(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.members[0], self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        view = self.channel.sent[-1].view
        for m in joiners:
            await press(view, 'join', FakeInteraction(m, self.channel))
        return inter, task

    async def hand_view(self, round_no):
        while True:
            g = self.cog.games.get(self.channel.id)
            if g and g.phase == 'choosing' and g.round == round_no:
                return g, self.channel.sent[-1].view
            await real_sleep(0.002)

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            _, task = await self.start([])
            again = FakeInteraction(self.members[1], self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既にじゃんけんが進行中', again.response.sent[0].text())
            await task
        self.assertEqual(self.cog.games, {})

    async def test_multiplayer_draw_then_win(self):
        m1, m2, m3 = self.members
        before = dict(party_ranking.shared().memory.get((77, 'janken'), {}))
        with fast_time(scale=0.01):
            _, task = await self.start([m2, m3])
            g, view = await self.hand_view(1)
            # 参加していない人は出せない・手は本人にだけ返事
            outsider = FakeInteraction(FakeMember(9, self.guild), self.channel)
            await press(view, 'rock', outsider)
            self.assertIn('いまは手を出せません', outsider.response.sent[0].text())
            i1 = FakeInteraction(m1, self.channel)
            await press(view, 'rock', i1)
            self.assertIn('グー', i1.response.sent[0].text())
            await press(view, 'paper', FakeInteraction(m2, self.channel))
            await press(view, 'scissors', FakeInteraction(m3, self.channel))   # 3 種類 → あいこ
            g, view = await self.hand_view(2)
            self.assertEqual(sorted(g.alive), [1, 2, 3])
            await press(view, 'rock', FakeInteraction(m1, self.channel))
            await press(view, 'rock', FakeInteraction(m2, self.channel))
            await press(view, 'scissors', FakeInteraction(m3, self.channel))
            g, view = await self.hand_view(3)
            self.assertEqual(sorted(g.alive), [1, 2])
            await press(view, 'scissors', FakeInteraction(m1, self.channel))
            await press(view, 'paper', FakeInteraction(m1, self.channel))   # 変更できる
            await press(view, 'rock', FakeInteraction(m2, self.channel))
            await task
        texts = self.channel.texts()
        self.assertTrue(any('あいこ' in t for t in texts))
        self.assertIn('勝者: <@1>', texts[-1])
        after = party_ranking.shared().memory[(77, 'janken')]
        self.assertEqual(after.get(1, 0), before.get(1, 0) + 1)
        self.assertEqual(self.cog.games, {})

    async def test_timeout_loses(self):
        m1, m2, _ = self.members
        with fast_time(scale=0.002):
            _, task = await self.start([m2])
            g, view = await self.hand_view(1)
            await press(view, 'rock', FakeInteraction(m2, self.channel))
            await task
        self.assertTrue(any('時間切れ' in t for t in self.channel.texts()))
        self.assertIn('勝者: <@2>', self.channel.texts()[-1])

    async def test_vs_bot_not_ranked(self):
        before = dict(party_ranking.shared().memory.get((77, 'janken'), {}))
        with fast_time(scale=0.01):
            _, task = await self.start([])
            g, view = await self.hand_view(1)
            self.assertTrue(g.vs_bot)
            self.assertIn(j.BOT_ID, g.choices)
            # Bot の手に必ず勝つ手を出す（あいこが続いても毎回）
            async def play():
                while not task.done():
                    cur = self.cog.games.get(self.channel.id)
                    if cur and cur.phase == 'choosing' and 1 not in cur.choices:
                        bot = cur.choices[j.BOT_ID]
                        win = next(h for h in j.HANDS if j.BEATS[h] == bot)
                        await press(self.channel.sent[-1].view, win, FakeInteraction(self.members[0], self.channel))
                    await real_sleep(0.002)
            await asyncio.gather(task, play())
        self.assertIn('勝者: <@1>', self.channel.texts()[-1])
        self.assertIn('Bot 戦', self.channel.texts()[-1])
        self.assertEqual(party_ranking.shared().memory.get((77, 'janken'), {}), before)


if __name__ == '__main__':
    unittest.main()
