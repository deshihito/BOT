"""Wordle（cogs/wordle.py）のテスト。色の判定・単語の確認と、偽の Discord 部品での流れ。"""

import asyncio
import random
import types
import unittest
from unittest.mock import patch

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, press, real_sleep
from cogs import wordle as w
from core.game.wordle import cog as wordle_impl
from core import party_ranking

G, Y, X = w.GREEN, w.YELLOW, w.GRAY


class ScoreTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(w.score('crane', 'crane'), [G] * 5)
        self.assertEqual(w.score('react', 'crane'), [Y, Y, G, Y, X])

    def test_duplicate_letters(self):
        # 答えに L は 1 つ。緑が優先され、2 つ目は灰色
        self.assertEqual(w.score('llama', 'hello'), [Y, Y, X, X, X])
        self.assertEqual(w.score('hollo', 'hello'), [G, X, G, G, G])
        # 答えに E が 2 つ、推理に 3 つ
        self.assertEqual(w.score('eerie', 'there'), [Y, X, Y, X, G])  # 余った E は 1 つだけ、左から黄色
        self.assertEqual(w.score('speed', 'abide'), [X, X, Y, X, Y])

    def test_word_lists(self):
        self.assertGreater(len(w.ANSWERS), 2000)
        self.assertTrue(all(len(a) == 5 and a.isalpha() and a.islower() for a in w.ANSWERS))
        self.assertTrue(set(w.ANSWERS) <= w.VALID)
        self.assertGreater(len(w.VALID), 10000)

    def test_check_guess(self):
        self.assertEqual(w.check_guess(' CRANE '), ('crane', None))
        self.assertIsNotNone(w.check_guess('cran')[1])
        self.assertIsNotNone(w.check_guess('cr4ne')[1])
        self.assertIsNotNone(w.check_guess('ｃｒａｎｅ')[1])
        self.assertIn('単語リストにありません', w.check_guess('zzzzz')[1])

    def test_registered(self):
        self.assertTrue(party_ranking.is_ranked('wordle'))
        self.assertIn('wordle', party_ranking.KNOWN_GAMES)


class WordleFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(88)
        self.channel = FakeChannel(800, self.guild)
        self.m1, self.m2 = FakeMember(1, self.guild), FakeMember(2, self.guild)
        self.cog = w.Wordle(types.SimpleNamespace())

    async def start(self, mode='shared'):
        inter = FakeInteraction(self.m1, self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter, mode=mode, rng=random.Random(0)))
        while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].message is None:
            await real_sleep(0.002)
        g = self.cog.games[self.channel.id]
        g.answer = 'crane'
        return g, task

    async def guess(self, user, word, g):
        inter = FakeInteraction(user, self.channel)
        await self.cog.submit_guess(inter, g, word)
        return inter.response.sent[0].text()

    async def test_shared_win_records_ranking(self):
        before = party_ranking.shared().memory.get((88, 'wordle'), {}).get(2, 0)
        g, task = await self.start()
        self.assertIn('単語リストにありません', await self.guess(self.m1, 'zzzzz', g))
        self.assertEqual(g.guesses, [])
        await self.guess(self.m1, 'react', g)
        self.assertIn('REACT', g.message.embed.description)
        await self.guess(self.m2, 'crane', g)
        await asyncio.wait_for(task, 2)
        self.assertIn('<@2>', self.channel.texts()[-1])
        self.assertIn('2/6', self.channel.texts()[-1])
        self.assertIn('CRANE', self.channel.sent[0].embed.fields[-1].value)   # 盤面に答えを出す
        self.assertEqual(party_ranking.shared().memory[(88, 'wordle')][2], before + 1)
        self.assertEqual(self.cog.games, {})

    async def test_solo_only_host_and_six_misses(self):
        g, task = await self.start('solo')
        self.assertIn('始めた人だけ', await self.guess(self.m2, 'react', g))
        btn = FakeInteraction(self.m2, self.channel)
        await press(g.message.view, 'guess', btn)
        self.assertIn('始めた人だけ', btn.response.sent[0].text())
        for word in ('react', 'stone', 'pious', 'lumpy', 'width', 'fjord'):
            await self.guess(self.m1, word, g)
        await asyncio.wait_for(task, 2)
        self.assertIn('正解できませんでした', self.channel.texts()[-1])
        self.assertIsNone(g.winner)

    async def test_give_up_and_duplicate(self):
        g, task = await self.start()
        again = FakeInteraction(self.m2, self.channel)
        await self.cog.start_recruit(again)
        self.assertIn('既に Wordle が進行中', again.response.sent[0].text())
        not_host = FakeInteraction(self.m2, self.channel)
        await press(g.message.view, 'give_up', not_host)
        self.assertFalse(task.done())
        await press(g.message.view, 'give_up', FakeInteraction(self.m1, self.channel))
        await asyncio.wait_for(task, 2)
        self.assertIn('CRANE', self.channel.texts()[-1])

    async def test_timeout_ends(self):
        with patch.object(wordle_impl, 'GAME_SECONDS', 0.05):
            g, task = await self.start()
            await asyncio.wait_for(task, 5)
        self.assertIn('正解できませんでした', self.channel.texts()[-1])

    def test_letter_status(self):
        g = w.WordleGame(1, 1, self.m1, 'crane')
        g.guesses = [(self.m1, 'react', w.score('react', 'crane')), (self.m1, 'crane', w.score('crane', 'crane'))]
        st = g.letter_status()
        self.assertEqual(st['r'], G)
        self.assertEqual(st['t'], X)


if __name__ == '__main__':
    unittest.main()
