"""神経衰弱（cogs/shinkei.py）のテスト。盤面のロジックと、偽の Discord 部品での流れ。d1 には接続しない。"""

import asyncio
import random
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, real_sleep
from cogs import shinkei as s
from core.support import guild_settings
from core.game import autoplay, party_ranking

# 0,1 / 2,3 / ... が同じ絵になる並び
ORDERED = [sym for sym in s.SYMBOLS for _ in range(2)]


class LogicTest(unittest.TestCase):
    def test_deal_and_layout(self):
        cards = s.deal(random.Random(1))
        self.assertEqual(len(cards), 24)
        self.assertEqual(sum(s.ROW_SIZES), 24)
        self.assertLessEqual(len(cards), 25)
        for sym in s.SYMBOLS:
            self.assertEqual(cards.count(sym), 2)
        self.assertEqual([s.row_of(i) for i in (0, 4, 5, 19, 20, 23)], [0, 0, 1, 3, 4, 4])

    def game(self, n=2):
        g = s.ShinkeiGame(1, 1, 1, cards=list(ORDERED))
        for uid in range(1, n + 1):
            g.players[uid] = uid
        g.phase = 'playing'
        return g

    def test_flip_match_keeps_turn(self):
        g = self.game()
        self.assertEqual(g.flip(2, 0), 'invalid')      # 手番でない
        self.assertEqual(g.flip(1, 0), 'first')
        self.assertEqual(g.flip(1, 0), 'invalid')      # 同じカード
        self.assertEqual(g.flip(1, 1), 'match')
        self.assertEqual(g.scores, {1: 1})
        self.assertEqual(g.current, 1)
        self.assertEqual(g.flip(1, 0), 'invalid')      # そろったカード

    def test_flip_miss_then_next(self):
        g = self.game()
        g.flip(1, 0)
        self.assertEqual(g.flip(1, 2), 'miss')
        self.assertEqual(g.flip(1, 4), 'invalid')      # 2 枚めくったあと
        g.next_turn()
        self.assertEqual((g.current, g.face_up), (2, []))
        self.assertEqual(len(g.hidden()), 24)

    def test_winners_tie(self):
        g = self.game(3)
        g.scores = {1: 5, 2: 5, 3: 2}
        self.assertEqual(g.winners(), [1, 2])

    def test_board_view_has_24_buttons(self):
        g = self.game()
        view = s.BoardView(None, g)
        buttons = [c for c in view.walk_children() if isinstance(c, discord.ui.Button)]
        self.assertEqual(len(buttons), 24)

    def test_registered(self):
        self.assertTrue(party_ranking.is_ranked('shinkei'))
        self.assertIn('shinkei', party_ranking.KNOWN_GAMES)


class ShinkeiFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(99)
        self.channel = FakeChannel(900, self.guild)
        self.m1, self.m2 = FakeMember(1, self.guild), FakeMember(2, self.guild)
        self.cog = s.Shinkei(types.SimpleNamespace())

    async def start(self, joiners):
        inter = FakeInteraction(self.m1, self.channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.01)
        join_view = self.channel.sent[-1].view
        for m in joiners:
            await join_view.join.callback(FakeInteraction(m, self.channel))
        while self.channel.id not in self.cog.games or self.cog.games[self.channel.id].phase != 'playing':
            await real_sleep(0.002)
        g = self.cog.games[self.channel.id]
        g.cards = list(ORDERED)
        return g, task

    async def flip(self, user, g, index):
        inter = FakeInteraction(user, self.channel, message=g.message)
        await self.cog.on_flip(inter, g, index)
        return inter

    async def wait_current(self, g, uid):
        while g.current != uid or g.face_up:
            await real_sleep(0.002)

    async def test_two_player_game_records_winner(self):
        before = party_ranking.shared().memory.get((99, 'shinkei'), {}).get(1, 0)
        with fast_time(scale=0.002):
            g, task = await self.start([self.m2])
            bad = await self.flip(self.m2, g, 0)
            self.assertIn('あなたの番ではありません', bad.response.sent[0].text())
            await self.flip(self.m1, g, 0)
            await self.flip(self.m1, g, 2)                  # 外れ
            self.assertIn('そろいませんでした', g.message.text())
            await self.wait_current(g, 2)
            await self.flip(self.m2, g, 0)
            await self.flip(self.m2, g, 1)                  # そろう → もう一度
            self.assertEqual(g.current, 2)
            await self.flip(self.m2, g, 4)
            await self.flip(self.m2, g, 2)                  # 外れ
            await self.wait_current(g, 1)
            for i in range(2, 24, 2):
                if i not in g.matched:
                    await self.flip(self.m1, g, i)
                    await self.flip(self.m1, g, i + 1)
            await asyncio.wait_for(task, 5)
        self.assertEqual(g.scores, {2: 1, 1: 11})
        self.assertIn('勝者: <@1>', self.channel.texts()[-1])
        self.assertEqual(party_ranking.shared().memory[(99, 'shinkei')][1], before + 1)
        self.assertEqual(self.cog.games, {})

    async def test_timeout_uses_autoplay(self):
        calls = []

        async def fake_idle(channel, **kw):
            calls.append(kw['legal_actions'])
            # 一覧の先頭（いちばん若い番号）をめくる → 0,1 / 2,3 ... と必ずそろう
            return autoplay.AutoplayResult(kw['legal_actions'][0], autoplay.SOURCE_FALLBACK, 'notice')

        with fast_time(scale=0.0005), patch.object(autoplay, 'take_idle_turn', fake_idle):
            g, task = await self.start([])
            await asyncio.wait_for(task, 10)
        self.assertTrue(calls)
        self.assertEqual(calls[0], [str(i) for i in range(1, 25)])
        self.assertTrue(g.finished)
        self.assertIn('ひとり遊び', self.channel.texts()[-1])

    async def test_timeout_autoplay_off_skips_turn(self):
        with fast_time(scale=0.0005), patch.object(guild_settings, 'autoplay_enabled', lambda gid: False):
            g, task = await self.start([self.m2])
            await asyncio.wait_for(task, 10)
        texts = self.channel.texts()
        self.assertTrue(any('手番を飛ばします' in t for t in texts))
        self.assertTrue(any('だれもめくらない' in t for t in texts))
        self.assertEqual(g.matched, {})

    async def test_autoplay_real_fallback_when_d1_down(self):
        with patch.object(autoplay, '_ask_d1', AsyncMock(side_effect=OSError('down'))), \
                patch.object(guild_settings, 'autoplay_enabled', lambda gid: True):
            g = s.ShinkeiGame(self.channel.id, 99, 1, cards=list(ORDERED))
            g.players[1] = self.m1
            g.phase = 'playing'
            g.matched = {i: 1 for i in range(2, 24)}
            with fast_time():
                await self.cog.idle_turn(self.channel, g, 1)
        self.assertTrue(g.finished)
        self.assertTrue(any('放置したため' in t for t in self.channel.texts()))

    async def test_no_emoji_anywhere(self):
        import re
        emoji = re.compile('[\U0001F000-\U0001FFFF\u2600-\u27BF\u2B00-\u2BFF\u23E9-\u23FA]')
        g = s.ShinkeiGame(1, 99, 1, cards=list(ORDERED))
        g.players[1] = self.m1
        g.phase = 'playing'
        g.matched = {0: 1, 1: 1}
        g.face_up = [2]
        texts = [self.cog.board_text(g, 'x')] + [b.label for b in s.BoardView(self.cog, g).walk_children()
                                                 if isinstance(b, discord.ui.Button)]
        from core.game.game_guides import GAME_GUIDES
        texts.append(str(GAME_GUIDES['shinkei']))
        self.assertFalse([t for t in texts if emoji.search(t)])

    async def test_duplicate_recruit_refused(self):
        with fast_time():
            inter = FakeInteraction(self.m1, self.channel)
            task = asyncio.create_task(self.cog.start_recruit(inter))
            await real_sleep(0.005)
            again = FakeInteraction(self.m2, self.channel)
            await self.cog.start_recruit(again)
            self.assertIn('既に神経衰弱が進行中', again.response.sent[0].text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.cog.games, {})


if __name__ == '__main__':
    unittest.main()
