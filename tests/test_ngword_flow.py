"""NGワード（core/support/ngword/cog.py）の流れのテスト。偽の Discord 部品で動かし、通信はしない。"""

import asyncio
import random
import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, press, real_sleep
from core.support.ngword import cog as ngword
from core.game.game import party_ranking


def msg(author, channel, content):
    return types.SimpleNamespace(author=author, channel=channel, content=content)


class NGWordTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(500, self.guild)
        self.members = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = ngword.NGWord(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.members[0], self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        view = self.channel.sent[-1].view
        for m in joiners:
            await press(view, 'join', FakeInteraction(m, self.channel))
        return inter, task

    def test_contains_ng_case_insensitive(self):
        self.assertTrue(ngword.contains_ng('WWW笑', 'w'))
        self.assertFalse(ngword.contains_ng('こんにちは', 'なるほど'))
        self.assertFalse(ngword.contains_ng(None, 'うん'))

    def test_word_list_is_large_enough(self):
        self.assertGreaterEqual(len(set(ngword.NG_WORDS)), ngword.MAX_PLAYERS)

    async def test_not_enough_players_cleans_state(self):
        with fast_time():
            inter, task = await self.start([])
            self.assertIn('参加者募集', inter.response.sent[0].text())
            await task
        self.assertIn('人数不足', self.channel.texts()[-1])
        self.assertEqual(self.cog.games, {})

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            _, task = await self.start([])
            again = FakeInteraction(self.members[1], self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既にNGワードが進行中', again.response.sent[0].text())
            await task

    async def test_full_game_elimination_and_win(self):
        random.seed(1)
        with fast_time(scale=0.0005):
            _, task = await self.start(self.members[1:])
            while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].phase != 'playing':
                await real_sleep(0.005)
            g = self.cog.games[self.channel.id]
            self.assertEqual(len(set(g.words.values())), 3)
            # 自分の NG ワードは見えない
            play_view = self.channel.sent[-1].view
            peek = FakeInteraction(self.members[0], self.channel)
            await press(play_view, 'peek', peek)
            text = peek.response.sent[0].text()
            self.assertIn('？？？', text)
            self.assertIn(g.words[2], text)
            # 1 と 2 が脱落 → 3 の勝ち
            self.assertTrue(await self.cog.handle_message(msg(self.members[0], self.channel, f'x{g.words[1]}x')))
            self.assertFalse(await self.cog.handle_message(msg(self.members[0], self.channel, g.words[1])))  # 脱落済み
            self.assertTrue(await self.cog.handle_message(msg(self.members[1], self.channel, g.words[2])))
            await task
        last = self.channel.sent[-1].text()
        self.assertIn('NGワード 終了', last)
        self.assertIn('P3', last)
        self.assertEqual(await party_ranking.shared().top(self.guild.id, 'ngword'), [(3, 1)])
        self.assertEqual(self.cog.games, {})

    async def test_non_player_and_idle_channel_ignored(self):
        outsider = FakeMember(9, self.guild)
        self.assertFalse(await self.cog.handle_message(msg(outsider, self.channel, 'うん')))


if __name__ == '__main__':
    unittest.main()
