"""ダウト（cogs/doubt.py）のゲーム進行テスト。偽の Discord 部品（tests/game_fakes.py）で動かし、通信はしない。"""

import asyncio
import types
import unittest

from game_fakes import (FakeBot, FakeChannel, FakeChatMessage, FakeGuild, FakeInteraction, FakeMember,
                        fast_time, press, choose, real_sleep)
import core.game.doubt.cog as doubt


class DoubtFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(100, self.guild)
        self.players = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = doubt.Doubt(FakeBot(self.channel))

    def ctx(self, author):
        return types.SimpleNamespace(author=author, channel=self.channel, send=self.channel.send)

    def new_game(self, hands):
        """手札を指定してゲームを始めた状態にする（1 人目の手番）"""
        game = doubt.DoubtEngine([p.id for p in self.players])
        game.hands = {p.id: doubt.sort_hand(list(h)) for p, h in zip(self.players, hands)}
        self.cog.games[self.channel.id] = game
        return game

    async def play(self, game, member, card):
        """「カードを置く」→ セレクトでカードを選ぶ"""
        panel = doubt.GameControlView(game, self.cog)
        inter = FakeInteraction(member, self.channel)
        await press(panel, 'play', inter)
        view = inter.response.sent[-1].view
        select = next(s for s in view.children if any(o.value == card for o in s.options))
        return await choose(select, card, FakeInteraction(member, self.channel))

    async def test_join_after_start_is_rejected(self):
        with fast_time():
            task = asyncio.create_task(self.cog.start_game.callback(self.cog, self.ctx(self.players[0])))
            await real_sleep(0.01)
            join_view = self.channel.sent[0].view
            for member in self.players[1:]:
                await press(join_view, 'join', FakeInteraction(member, self.channel))
            await task
            game = self.cog.games[self.channel.id]
            self.assertEqual(game.players, [1, 2, 3])

            late = FakeMember(44, self.guild)
            inter = FakeInteraction(late, self.channel)
            await press(join_view, 'join', inter)
            self.assertIn('締め切', inter.texts()[0])
            self.assertEqual(game.players, [1, 2, 3])
            self.assertNotIn(44, game.hands)
            # V2 化で締切時はボタン行そのものが取り除かれる（無効化より強い）
            import discord as _discord
            self.assertFalse([c for c in join_view.walk_children()
                              if isinstance(c, _discord.ui.Button)])
            # 開始時の参加リストと共有していない
            join_view.players.append(45)
            self.assertEqual(game.players, [1, 2, 3])

    async def test_too_few_players_closes_recruitment(self):
        with fast_time():
            await self.cog.start_game.callback(self.cog, self.ctx(self.players[0]))
        self.assertNotIn(self.channel.id, self.cog.games)
        self.assertIn('人数不足', self.channel.texts()[-1])
        self.assertTrue(self.channel.sent[0].view.closed)

    async def test_second_doubt_in_running_channel_is_refused(self):
        game = self.new_game([['[S-1]'], ['[S-2]'], ['[S-3]']])
        await self.cog.start_game.callback(self.cog, self.ctx(self.players[1]))
        self.assertIs(self.cog.games[self.channel.id], game)
        self.assertIn('既にダウトが進行中', self.channel.texts()[-1])

    async def test_last_card_without_doubt_wins(self):
        game = self.new_game([['[S-5]'], ['[H-2]', '[H-3]'], ['[D-4]']])
        with fast_time():
            await self.play(game, self.players[0], '[S-5]')
        self.assertIn('勝者: P1', self.channel.texts()[-1])
        self.assertNotIn(self.channel.id, self.cog.games)

    async def test_last_card_truthfully_doubted_still_wins(self):
        game = self.new_game([['[S-1]'], ['[H-2]', '[H-3]'], ['[D-4]']])
        with fast_time():
            task = asyncio.create_task(self.play(game, self.players[0], '[S-1]'))
            await real_sleep(0.001)
            await self.cog.on_message(FakeChatMessage(self.players[1], self.channel, 'ダウト'))
            await task
        self.assertIn('ダウト失敗', self.channel.texts()[-2])
        self.assertIn('勝者: P1', self.channel.texts()[-1])
        self.assertEqual(sorted(game.hands[2]), ['[H-2]', '[H-3]', '[S-1]'])
        self.assertEqual(sum('勝者' in t for t in self.channel.texts()), 1)

    async def test_last_card_lie_doubted_takes_back(self):
        game = self.new_game([['[S-9]'], ['[H-2]', '[H-3]'], ['[D-4]']])
        with fast_time():
            task = asyncio.create_task(self.play(game, self.players[0], '[S-9]'))
            await real_sleep(0.001)
            await self.cog.on_message(FakeChatMessage(self.players[2], self.channel, 'ダウト'))
            await task
        self.assertIn('ダウト成功', ' '.join(self.channel.texts()))
        self.assertEqual(game.hands[1], ['[S-9]'])
        self.assertIn(self.channel.id, self.cog.games)
        self.assertFalse(any('勝者' in t for t in self.channel.texts()))

    async def test_cannot_play_during_doubt_window(self):
        game = self.new_game([['[S-1]', '[S-4]'], ['[H-2]', '[H-3]'], ['[D-4]']])
        with fast_time():
            task = asyncio.create_task(self.play(game, self.players[0], '[S-1]'))
            await real_sleep(0.001)
            inter = FakeInteraction(self.players[1], self.channel)
            await press(doubt.GameControlView(game, self.cog), 'play', inter)
            self.assertIn('ダウト受付中', inter.texts()[0])
            await task
        self.assertEqual(game.hands[2], ['[H-2]', '[H-3]'])

    async def test_empty_hand_play_button_is_graceful(self):
        game = self.new_game([[], ['[H-2]'], ['[D-4]']])
        inter = FakeInteraction(self.players[0], self.channel)
        await press(doubt.GameControlView(game, self.cog), 'play', inter)
        self.assertIn('手札がありません', inter.texts()[0])
        self.assertIsNone(inter.response.sent[0].view)

    async def test_every_card_is_selectable_with_big_hand(self):
        big = [f'[{s}-{r}]' for s in 'SH' for r in range(1, 14)] + ['[JK-1]']  # 27 枚
        game = self.new_game([big, ['[D-1]'], ['[D-2]']])
        inter = FakeInteraction(self.players[0], self.channel)
        await press(doubt.GameControlView(game, self.cog), 'play', inter)
        view = inter.response.sent[0].view
        values = [o.value for s in view.children for o in s.options]
        self.assertEqual(sorted(values), sorted(big))
        self.assertTrue(all(1 <= len(s.options) <= 25 for s in view.children))
        self.assertEqual(len(view.children), 2)
        with fast_time():
            await choose(view.children[1], '[JK-1]', FakeInteraction(self.players[0], self.channel))
        self.assertNotIn('[JK-1]', game.hands[1])

    def test_cards_sorted_by_rank(self):
        hand = ['[C-10]', '[JK-1]', '[S-2]', '[H-1]', '[C-2]', '[D-13]']
        self.assertEqual(doubt.sort_hand(hand), ['[H-1]', '[S-2]', '[C-2]', '[C-10]', '[D-13]', '[JK-1]'])
        engine = doubt.DoubtEngine([1, 2, 3])
        for hand in engine.hands.values():
            self.assertEqual(hand, sorted(hand, key=doubt.card_sort_key))
        self.assertEqual(sum(len(h) for h in engine.hands.values()), 54)


if __name__ == '__main__':
    unittest.main()
