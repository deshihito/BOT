"""UNO（cogs/uno.py）のゲーム進行テスト。偽の Discord 部品（tests/game_fakes.py）で動かし、通信はしない。"""

import asyncio
import unittest

import discord

from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember, choose, fast_time, press, real_sleep
from cogs import uno


class UnoFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(200, self.guild)
        self.players = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = uno.Uno(FakeBot(self.channel))

    def new_game(self, hands, top='赤の5'):
        """手札・場札を指定して、1 人目の手番から始まった状態にする"""
        game = uno.UnoGame(self.channel.id, self.players[0].id)
        game.players = [p.id for p in self.players]
        game.hands = {p.id: list(h) for p, h in zip(self.players, hands)}
        game.deck = ['黄の9'] * 30
        game.discard_pile = [top]
        game.current_color = top.split('の')[0]
        game.is_started = True
        self.cog.games[self.channel.id] = game
        return game

    async def select(self, game, member, value):
        view = game.active_view
        select = next(s for s in view.walk_children() if isinstance(s, discord.ui.Select)
                      and any(o.value == value for o in s.options))
        inter = FakeInteraction(member, self.channel)
        await choose(select, value, inter)
        return inter

    def current(self, game):
        return game.players[game.current_player_idx]

    async def test_wild_color_survives_draw_and_pass(self):
        game = self.new_game([['Wild', '赤の1', '赤の2'], ['赤の3', '緑の4'], ['青の1', '緑の7']])
        await self.cog.send_game_panel(self.channel, game)
        await self.select(game, self.players[0], 'Wild')
        await press(game.active_view, 'blue', FakeInteraction(self.players[0], self.channel))
        self.assertEqual(game.current_color, '青')
        self.assertEqual(self.current(game), 2)

        await self.select(game, self.players[1], 'DRAW_PASS')  # 青が無いので引いてパス
        self.assertEqual(game.current_color, '青')
        self.assertEqual(self.current(game), 3)
        self.assertIn('青の1', game.get_playable_cards(3))
        self.assertNotIn('緑の7', game.get_playable_cards(3))
        self.assertIn('Color: **[青]**', self.channel.sent[-1].text())

    async def test_wild_color_timeout_picks_a_color(self):
        game = self.new_game([['Wild', '緑の1', '緑の2', '赤の8'], ['赤の3'], ['青の1']])
        await self.cog.send_game_panel(self.channel, game)
        await self.select(game, self.players[0], 'Wild')
        wild_view = game.active_view
        self.assertIsInstance(wild_view, uno.WildColorView)
        self.assertEqual(wild_view.timeout, uno.COLOR_TIMEOUT)
        await wild_view.on_timeout()
        self.assertEqual(game.current_color, '緑')  # 手札に一番多い色
        self.assertEqual(self.current(game), 2)
        self.assertIsInstance(game.active_view, uno.GameControlView)
        self.assertIn('時間切れ', self.channel.sent[-1].text())
        # 時間切れの後に押しても二重に進まない
        inter = FakeInteraction(self.players[0], self.channel)
        await press(wild_view, 'red', inter)
        self.assertEqual(game.current_color, '緑')
        self.assertEqual(self.current(game), 2)

    async def test_turn_timeout_draws_and_passes_then_ends_idle_game(self):
        game = self.new_game([['赤の1'], ['赤の3'], ['青の1']])
        await self.cog.send_game_panel(self.channel, game)
        first = game.active_view
        self.assertEqual(first.timeout, uno.TURN_TIMEOUT)
        await first.on_timeout()
        self.assertEqual(len(game.hands[1]), 2)
        self.assertEqual(self.current(game), 2)
        await first.on_timeout()  # 古いパネルの時間切れは無視される
        self.assertEqual(self.current(game), 2)

        await game.active_view.on_timeout()
        self.assertIn(self.channel.id, self.cog.games)
        await game.active_view.on_timeout()  # 3 人連続で放置 → 終了
        self.assertNotIn(self.channel.id, self.cog.games)
        self.assertIn('操作のない状態', self.channel.sent[-1].text())

    async def test_turn_timeout_takes_pending_draws(self):
        game = self.new_game([['赤の1'], ['赤の3'], ['青の1']], top='赤の+2')
        game.pending_draw_count, game.active_plus_type = 4, '+2'
        await self.cog.send_game_panel(self.channel, game)
        await game.active_view.on_timeout()
        self.assertEqual(len(game.hands[1]), 5)
        self.assertEqual(game.pending_draw_count, 0)

    async def test_manual_move_resets_idle_counter(self):
        game = self.new_game([['赤の1', '赤の2'], ['赤の3', '赤の4'], ['赤の6', '赤の7']])
        await self.cog.send_game_panel(self.channel, game)
        await game.active_view.on_timeout()
        await game.active_view.on_timeout()
        self.assertEqual(game.timeout_streak, 2)
        await self.select(game, self.players[2], '赤の6')
        self.assertEqual(game.timeout_streak, 0)
        self.assertIn(self.channel.id, self.cog.games)

    async def test_uno_end_permissions(self):
        game = self.new_game([['赤の1'], ['赤の3'], ['青の1']])
        await self.cog.send_game_panel(self.channel, game)
        stranger = FakeMember(99, self.guild)
        inter = FakeInteraction(stranger, self.channel)
        await self.cog.force_end(inter)
        self.assertIn('参加者・ホスト・管理者', inter.texts()[0])
        self.assertIn(self.channel.id, self.cog.games)

        inter = FakeInteraction(self.players[2], self.channel)
        await self.cog.force_end(inter)
        self.assertNotIn(self.channel.id, self.cog.games)
        self.assertIsNone(game.active_view)
        self.assertIn('<@3> さんがUNOゲームを終了', self.channel.sent[-1].text())

        inter = FakeInteraction(self.players[0], self.channel)
        await self.cog.force_end(inter)
        self.assertIn('ありません', inter.texts()[0])

    async def test_uno_end_by_admin(self):
        self.new_game([['赤の1'], ['赤の3'], ['青の1']])
        admin = FakeMember(98, self.guild)
        admin.guild_permissions = discord.Permissions(administrator=True)
        await self.cog.force_end(FakeInteraction(admin, self.channel))
        self.assertNotIn(self.channel.id, self.cog.games)

    async def test_cancelled_recruit_does_not_start(self):
        host = self.players[0]
        with fast_time():
            old_task = asyncio.create_task(self.cog.start_recruit(FakeInteraction(host, self.channel)))
            await real_sleep(0.01)
            old_game = self.cog.games[self.channel.id]
            old_view = self.channel.sent[-1].view
            await press(old_view, 'join', FakeInteraction(self.players[1], self.channel, message=self.channel.sent[-1]))
            await press(old_view, 'cancel', FakeInteraction(host, self.channel, message=self.channel.sent[-1]))
            self.assertNotIn(self.channel.id, self.cog.games)

            new_task = asyncio.create_task(self.cog.start_recruit(FakeInteraction(host, self.channel)))
            await real_sleep(0.02)
            new_game = self.cog.games[self.channel.id]
            await press(self.channel.sent[-1].view, 'join',
                        FakeInteraction(self.players[2], self.channel, message=self.channel.sent[-1]))
            await old_task  # キャンセルした募集の 60 秒が先に終わる
            self.assertFalse(old_game.is_started)
            self.assertIs(self.cog.games[self.channel.id], new_game)
            self.assertFalse(new_game.is_started)
            await new_task
            self.assertTrue(new_game.is_started)
            self.assertFalse(old_game.is_started)

    async def test_many_playable_cards_fit_in_selects(self):
        many = [f'{c}の{v}' for c in uno.COLORS for v in [str(i) for i in range(10)] + ['Skip', 'Reverse', '+2']]
        many += ['Wild', 'Wild+4']
        game = self.new_game([many + many[:10], ['赤の3'], ['青の1']])
        view = uno.GameControlView(game, many + many[:10], self.cog)  # 重複込み 64 枚
        selects = [c for c in view.walk_children() if isinstance(c, discord.ui.Select)]
        self.assertGreater(len(selects), 1)
        self.assertTrue(all(1 <= len(s.options) <= 25 for s in selects))
        values = [o.value for s in selects for o in s.options]
        self.assertEqual(sorted(values), sorted(many + ['DRAW_PASS']))
        self.assertEqual(len(values), len(set(values)))
        # V2: 行はセレクト数＋手札確認ボタンの1行で、5行以内に収まる
        rows = [c for c in view.walk_children() if isinstance(c, discord.ui.ActionRow)]
        self.assertLessEqual(len(rows), 5)

    async def test_duplicate_cards_are_merged(self):
        game = self.new_game([['赤の1'] * 30, ['赤の3'], ['青の1']])
        await self.cog.send_game_panel(self.channel, game)
        selects = [c for c in game.active_view.walk_children() if isinstance(c, discord.ui.Select)]
        self.assertEqual([o.value for o in selects[0].options], ['赤の1', 'DRAW_PASS'])
        await self.select(game, self.players[0], '赤の1')
        self.assertEqual(len(game.hands[1]), 29)

    async def test_stale_card_selection_is_rejected(self):
        game = self.new_game([['赤の1', '青の2'], ['赤の3'], ['青の1']])
        view = uno.GameControlView(game, ['赤の1', '青の2'], self.cog)
        select = next(c for c in view.walk_children() if isinstance(c, discord.ui.Select))
        inter = FakeInteraction(self.players[0], self.channel)
        await choose(select, '青の2', inter)  # 場は赤の5なので出せない
        self.assertIn('出せません', inter.texts()[0])
        self.assertEqual(game.hands[1], ['赤の1', '青の2'])


if __name__ == '__main__':
    unittest.main()
