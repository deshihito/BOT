"""お題しりとり（cogs/shiritori.py）のテスト。純粋な判定ロジックと、偽の Discord 部品での流れ。"""

import asyncio
import random
import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, press, real_sleep
from cogs import shiritori as s
from core.game.game import party_ranking
def msg(author, channel, content):
    return types.SimpleNamespace(author=author, channel=channel, content=content)


class KanaLogicTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(s.normalize('リンゴ'), 'りんご')
        self.assertEqual(s.normalize('きゃっと'), 'きやつと')
        self.assertEqual(s.normalize('ラーメン'), 'らあめん')
        self.assertEqual(s.normalize('すきー'), 'すきい')
        self.assertEqual(s.normalize('コーヒー'), 'こおひい')

    def test_first_last_loose_dakuten(self):
        self.assertEqual(s.last_kana('かば'), 'は')
        self.assertEqual(s.first_kana('パンダ'), 'は')
        self.assertEqual(s.last_kana('でんしゃ'), 'や')
        self.assertEqual(s.last_kana('サッカー'), 'あ')

    def test_is_kana_word(self):
        self.assertTrue(s.is_kana_word('ねこ'))
        self.assertTrue(s.is_kana_word('コーヒー'))
        self.assertFalse(s.is_kana_word('猫'))
        self.assertFalse(s.is_kana_word('ね'))
        self.assertFalse(s.is_kana_word('neko'))

    def test_check_answer(self):
        used = {s.normalize('りんご')}
        self.assertEqual(s.check_answer('りんご', 'ゴリラ', used)[0], 'ok')
        self.assertEqual(s.check_answer('りんご', 'こあら', used)[0], 'ok')  # 濁点ゆるく
        self.assertEqual(s.check_answer('りんご', 'らくだ', used)[0], 'retry')
        self.assertEqual(s.check_answer('りんご', '牛', used)[0], 'retry')
        self.assertEqual(s.check_answer('すいか', 'カボチャ', set())[0], 'ok')
        self.assertEqual(s.check_answer('あり', 'リンゴ', used), ('out', '同じ言葉がもう出ています'))
        self.assertEqual(s.check_answer('ごりら', 'らいおん', used)[0], 'out')
        self.assertEqual(s.check_answer('さっかー', 'あめ', set())[0], 'ok')

    def test_topic_verdict(self):
        self.assertTrue(s.topic_verdict(0, 0))
        self.assertTrue(s.topic_verdict(1, 1))
        self.assertFalse(s.topic_verdict(0, 1))

    def test_turn_order_and_elimination(self):
        g = s.ShiritoriGame(1, 1, 1)
        for uid in (1, 2, 3, 4):
            g.players[uid] = uid
        self.assertEqual(g.next_player(), 1)
        g.accept(1, 'ごりら')
        self.assertEqual(g.next_player(), 2)
        g.eliminate(2)
        self.assertEqual(g.next_player(), 3)
        g.accept(3, 'らっこ')
        self.assertEqual(g.next_player(), 4)
        g.eliminate(4)
        self.assertEqual(g.next_player(), 1)  # 一周して戻る
        self.assertEqual(g.alive, [1, 3])

    def test_topics_have_seed_words(self):
        for topic, words in s.TOPICS.items():
            for w in words:
                self.assertTrue(s.is_kana_word(w), w)
                self.assertFalse(s.normalize(w).endswith('ん'), w)


class ShiritoriFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(600, self.guild)
        self.members = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = s.OdaiShiritori(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.members[0], self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        view = self.channel.sent[-1].view
        for m in joiners:
            await press(view, 'join', FakeInteraction(m, self.channel))
        return inter, task

    async def test_not_enough_players_cleans_state(self):
        with fast_time():
            inter, task = await self.start([])
            self.assertIn('募集を開始', inter.response.sent[0].text())
            await task
        self.assertIn('人数不足', self.channel.texts()[-1])
        self.assertEqual(self.cog.games, {})

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            _, task = await self.start([])
            again = FakeInteraction(self.members[1], self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既にお題しりとりが進行中', again.response.sent[0].text())
            await task

    async def wait_turn(self, g, uid):
        while g.current != uid:
            await real_sleep(0.002)

    async def test_full_game(self):
        random.seed(3)
        with fast_time(scale=0.002):
            _, task = await self.start(self.members[1:])
            while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].phase != 'playing':
                await real_sleep(0.002)
            g = self.cog.games[self.channel.id]
            g.last_word, g.used = 'りんご', {'りんご'}
            m1, m2, m3 = self.members
            await self.wait_turn(g, 1)
            # 手番でない人の発言・頭の文字違いは数えない
            self.assertFalse(await self.cog.handle_message(msg(m2, self.channel, 'ごりら')))
            self.assertFalse(await self.cog.handle_message(msg(m1, self.channel, 'らくだ')))
            self.assertIn('言い直せます', self.channel.texts()[-1])
            self.assertTrue(await self.cog.handle_message(msg(m1, self.channel, 'ゴリラ')))
            # 投票: 2 と 3 が OK
            while not isinstance(getattr(self.channel.sent[-1], 'view', None), s.VoteView):
                await real_sleep(0.002)
            vote = self.channel.sent[-1].view
            bad = FakeInteraction(m1, self.channel)
            await press(vote, 'vote_ng', bad)
            self.assertIn('答えた人以外', bad.response.sent[0].text())
            await press(vote, 'vote_ok', FakeInteraction(m2, self.channel))
            await press(vote, 'vote_ok', FakeInteraction(m3, self.channel))
            # 2 は「ん」で脱落
            await self.wait_turn(g, 2)
            self.assertTrue(await self.cog.handle_message(msg(m2, self.channel, 'らいおん')))
            # 3 は時間切れで脱落 → 1 の勝ち
            await task
        texts = ' '.join(self.channel.texts())
        self.assertIn('「ん」で終わりました', texts)
        self.assertIn('時間切れ', texts)
        self.assertIn('<@1>', self.channel.sent[-1].text())
        self.assertIn('ゴリラ', self.channel.sent[-1].text())
        self.assertEqual(self.cog.wins[self.guild.id], {1: 1})
        self.assertEqual(await party_ranking.shared().top(self.guild.id, 'shiritori'), [(1, 1)])
        self.assertEqual(self.cog.games, {})

    async def test_topic_vote_ng_eliminates(self):
        with fast_time(scale=0.002):
            _, task = await self.start(self.members[1:])
            while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].phase != 'playing':
                await real_sleep(0.002)
            g = self.cog.games[self.channel.id]
            g.last_word, g.used = 'りんご', {'りんご'}
            await self.wait_turn(g, 1)
            await self.cog.handle_message(msg(self.members[0], self.channel, 'ごはた'))
            while not isinstance(getattr(self.channel.sent[-1], 'view', None), s.VoteView):
                await real_sleep(0.002)
            vote = self.channel.sent[-1].view
            await press(vote, 'vote_ng', FakeInteraction(self.members[1], self.channel))
            await press(vote, 'vote_ng', FakeInteraction(self.members[2], self.channel))
            while 1 not in g.out:
                await real_sleep(0.002)
            self.assertIn('合わないと判定', ' '.join(self.channel.texts()))
            g.phase = 'done'
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.cog.games, {})


if __name__ == '__main__':
    unittest.main()
