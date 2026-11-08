"""Wordle（cogs/wordle.py）のテスト。色の判定・単語の確認と、偽の Discord 部品での流れ。"""

import asyncio
import contextlib
import random
import types
import unittest
from unittest.mock import patch

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, _view_texts, press, real_sleep
import core.game.wordle.cog as w
from core.game.wordle import cog as wordle_impl
from core.game.game import party_ranking
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
        # 答えの両端の L が緑。間の L は答えに残っていないので全部灰色
        self.assertEqual(w.score('lllll', 'level'), [G, X, X, X, G])
        self.assertEqual(w.score('lever', 'level'), [G, G, G, G, X])
        # 緑を先に確定し、残り枠（A×1, B×2）でだけ黄色を付ける
        self.assertEqual(w.score('ababa', 'aabbb'), [G, Y, Y, G, X])

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
        self.assertIn('REACT', g.message.text())
        await self.guess(self.m2, 'crane', g)
        await asyncio.wait_for(task, 2)
        self.assertIn('<@2>', self.channel.texts()[-1])
        self.assertIn('2/6', self.channel.texts()[-1])
        self.assertIn('CRANE', self.channel.sent[0].text())   # 盤面に答えを出す
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


class RealMessage:
    """実物の discord.Message に倣った盤面メッセージ。

    discord.py 2.7.1 の Message には ``view`` 属性が無い（フェイクの
    FakeMessage との差異）。edit() で渡された view を表示として保持する。
    """

    def __init__(self, channel, message_id, view=None):
        self.channel = channel
        self.id = message_id
        self.rendered = view
        self.edits = []
        self.deleted = False

    async def edit(self, **kwargs):
        self.edits.append(kwargs)
        if 'view' in kwargs:
            self.rendered = kwargs['view']
        return self

    async def delete(self, *args, **kwargs):
        self.deleted = True

    def text(self):
        return ' '.join(_view_texts(self.rendered))


class FetchChannel(FakeChannel):
    """fetch_message で既存の盤面メッセージを引き直せるチャンネル。"""

    def __init__(self, *args, panel=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._panel = panel

    async def fetch_message(self, message_id):
        if self._panel is None or message_id != self._panel.id:
            raise LookupError(message_id)
        return self._panel


class WordleRealMessageTest(unittest.IsolatedAsyncioTestCase):
    """盤面メッセージが実物どおり view 属性を持たない条件での流れ。

    回帰: submit_guess が g.message.view を読んで AttributeError になり、
    盤面が編集されず、正解してもゲームが終わらなかった。
    """

    async def asyncSetUp(self):
        self.guild = FakeGuild(88)
        self.channel = FakeChannel(800, self.guild)
        self.m1, self.m2 = FakeMember(1, self.guild), FakeMember(2, self.guild)
        self.cog = w.Wordle(types.SimpleNamespace())

    async def start_real(self):
        inter = FakeInteraction(self.m1, self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter, mode='shared', rng=random.Random(0)))
        while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].message is None:
            await real_sleep(0.002)
        g = self.cog.games[self.channel.id]
        g.answer = 'crane'
        real = RealMessage(self.channel, g.message.id, g.message.view)
        g.message = real
        return g, task, real

    async def guess(self, cog, user, word, g):
        inter = FakeInteraction(user, self.channel)
        await cog.submit_guess(inter, g, word)
        return inter

    async def test_board_is_edited_in_place(self):
        g, task, real = await self.start_real()
        await self.guess(self.cog, self.m1, 'react', g)
        self.assertEqual(len(real.edits), 1)                # 同じメッセージを編集した
        self.assertIn('REACT', real.text())                 # 盤面に推理が反映される
        self.assertEqual(len(self.channel.sent), 1)         # 盤面は新規投稿されない
        await self.guess(self.cog, self.m2, 'crane', g)
        await asyncio.wait_for(task, 2)                     # 正解でゲームが終わる
        self.assertIn('CRANE', real.text())                 # 終了時に答え開示へ編集される
        self.assertIn('<@2>', self.channel.texts()[-1])
        self.assertIn('2/6', self.channel.texts()[-1])
        self.assertEqual(self.cog.games, {})

    async def test_win_on_sixth_guess_ends_game(self):
        g, task, real = await self.start_real()
        for word in ('react', 'stone', 'pious', 'lumpy', 'width'):
            await self.guess(self.cog, self.m1, word, g)
        self.assertFalse(g.over)
        await self.guess(self.cog, self.m1, 'crane', g)
        await asyncio.wait_for(task, 2)
        self.assertIs(g.winner, self.m1)
        self.assertIn('6/6', self.channel.texts()[-1])

    async def test_guess_after_over_is_rejected(self):
        g, task, real = await self.start_real()
        await self.guess(self.cog, self.m1, 'crane', g)
        await asyncio.wait_for(task, 2)
        edits = len(real.edits)
        inter = await self.guess(self.cog, self.m1, 'react', g)
        self.assertIn('終わりました', inter.response.sent[0].text())
        self.assertEqual(len(g.guesses), 1)
        self.assertEqual(len(real.edits), edits)

    async def test_restored_panel_keeps_editing(self):
        g, task, real = await self.start_real()
        await self.guess(self.cog, self.m1, 'react', g)
        captured = {}
        with patch.object(w.game_restore, 'save_session',
                          lambda *args: captured.update(state=args[3])):
            self.cog._save_snapshot(g)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        guild2 = FakeGuild(88)
        member1 = FakeMember(1, guild2)
        panel = RealMessage(None, captured['state']['message_id'])
        channel2 = FetchChannel(800, guild2, panel=panel)
        panel.channel = channel2
        cog2 = w.Wordle(types.SimpleNamespace(get_channel=lambda cid: channel2))
        ok = await cog2._restore_session(800, {'state': captured['state'], 'guild_id': 88})
        self.assertTrue(ok)
        g2 = cog2.games[800]
        self.assertIs(g2.message, panel)                    # 既存の盤面を引き継ぐ
        self.assertIn('REACT', panel.text())                # 復旧時点の盤面が出ている
        edits = len(panel.edits)
        inter = FakeInteraction(member1, channel2)
        await cog2.submit_guess(inter, g2, 'crane')
        self.assertGreater(len(panel.edits), edits)         # 復旧後も同じ盤面を編集する
        self.assertEqual(len(channel2.sent), 0)             # 推理では新規投稿しない
        for _ in range(100):
            if not cog2.games:
                break
            await real_sleep(0.02)
        self.assertEqual(cog2.games, {})
        self.assertIn('<@1>', channel2.texts()[-1])
        self.assertIn('2/6', channel2.texts()[-1])


if __name__ == '__main__':
    unittest.main()
