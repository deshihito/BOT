"""人狼（cogs/jinrou.py）のゲーム進行テスト。偽の Discord 部品（tests/game_fakes.py）で動かし、通信はしない。

ゲームを終了ボタン・DB API（レーティング）・グローバルモードはこのテストの対象外。
"""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from game_fakes import (FakeBot, FakeChannel, FakeChatMessage, FakeGuild, FakeInteraction, FakeMember,
                        fast_time, press, real_sleep)
from cogs import jinrou


class JinrouFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.players = [FakeMember(i, self.guild) for i in range(1, 6)]
        self.cog = jinrou.JinrouCog(FakeBot(self.channel))
        # レーティングAPIには接続しない
        self.db_api = patch.object(jinrou, 'db_api', MagicMock())
        self.db_api.start()
        self.addCleanup(self.db_api.stop)

    def started_game(self, dead=()):
        """5 人全員が一般通過あごむにのゲームが進行中で、dead の人が死亡済みの状態"""
        game = self.cog.get_game(self.channel.id)
        game.is_running = True
        game.started = True
        game.game_channel = self.channel
        game.players = list(self.players)
        game.alive_players = [p for p in self.players if p.id not in dead]
        game.roles = {p.id: '一般通過あごむに' for p in self.players}
        game.host_id = self.players[0].id
        return game

    async def say(self, member, text='こんにちは'):
        message = FakeChatMessage(member, self.channel, text)
        await self.cog.on_message(message)
        return message.deleted

    async def test_dead_player_cannot_speak_during_day(self):
        game = self.started_game(dead={1})
        game.silenced_players = {1}
        with fast_time():
            task = asyncio.create_task(self.cog.run_discussion(game, 150, '昼のディスカッション'))
            await real_sleep(0.01)
            self.assertTrue(game.in_discussion)
            self.assertTrue(await self.say(self.players[0]))   # 追放済み
            self.assertFalse(await self.say(self.players[1]))  # 生存者
            game.is_running = False
            await task

    async def test_dead_player_cannot_speak_at_night(self):
        game = self.started_game(dead={2})
        game.roles[4] = '占い師'  # 行動待ちが発生して夜が続くようにする
        with fast_time():
            task = asyncio.create_task(self.cog.run_night_phase(game))
            await real_sleep(0.01)
            self.assertTrue(await self.say(self.players[1]))  # 死亡済み
            self.assertTrue(await self.say(self.players[2]))  # 生存者も夜は発言できない（従来どおり）
            game.is_running = False
            await task

    async def test_dead_netmin_is_silenced(self):
        game = self.started_game(dead={3})
        game.roles[3] = 'ネット民'
        self.assertTrue(await self.say(self.players[2]))

    async def test_spectators_and_recruitment_are_not_affected(self):
        game = self.started_game(dead={1})
        outsider = FakeMember(99, self.guild)
        self.assertFalse(await self.say(outsider))
        game.started = False  # 募集中
        game.alive_players = []
        self.assertFalse(await self.say(self.players[0]))

    async def test_game_end_lifts_all_silence(self):
        game = self.cog.get_game(self.channel.id)
        game.is_running = True
        game.game_channel = self.channel
        game.game_mode = 'ベーシック'
        game.players = list(self.players)
        with fast_time():
            task = asyncio.create_task(self.cog._start_game_loop(game, self.channel))
            await real_sleep(0.05)
            self.assertTrue(game.started)
            victim = self.players[4]
            game.alive_players = [p for p in game.alive_players if p != victim]
            self.assertTrue(await self.say(victim))
            game.is_running = False
            await task
        self.assertFalse(game.started)
        self.assertEqual(game.silenced_players, set())
        self.assertFalse(await self.say(victim))
        self.assertTrue(any('最終役職開示' in t for t in self.channel.texts()))

    async def test_new_game_resets_previous_state(self):
        game = self.started_game(dead={1})
        game.yandere_targets = {2: 3}
        game.mokumoku_turns = 3
        game.game_mode = 'ベーシック'
        game.night_actions = {4: ('占い', 5)}
        game.voted_count = {5: 2}
        game.chairman_skip_event = asyncio.Event()
        game.is_running = False
        game.started = False

        host = self.players[1]
        inter = FakeInteraction(host, self.channel)
        await self.cog.start_recruit(inter, 'local')
        new = self.cog.games[self.channel.id]
        self.assertIs(new, game)
        fresh = jinrou.JinrouGame()
        for name, value in vars(fresh).items():
            if name in jinrou.JinrouGame._KEEP_ON_RESET or name in ('is_running', 'host_id'):
                continue
            with self.subTest(field=name):
                self.assertEqual(getattr(game, name), value)
        self.assertTrue(game.is_running)
        self.assertEqual(game.host_id, host.id)
        self.assertIs(game.game_channel, self.channel)
        self.assertEqual(game.players, [])

    async def test_replay_keeps_game_mode(self):
        game = self.started_game()
        game.game_mode = 'ベーシック'
        game.required_roles = ['占い師']
        game.excluded_roles = ['騎士']
        game.is_running = False
        game.started = False
        view = jinrou.ReplayView(game, self.cog)

        inter = FakeInteraction(self.players[1], self.channel)
        await press(view, 'replay', inter)
        self.assertIs(self.cog.games[self.channel.id], game)  # ホスト以外は再戦できない

        inter = FakeInteraction(self.players[0], self.channel)
        await press(view, 'replay', inter)
        new = self.cog.games[self.channel.id]
        self.assertIsNot(new, game)
        self.assertEqual(new.game_mode, 'ベーシック')
        self.assertEqual(new.required_roles, ['占い師'])
        self.assertEqual(new.excluded_roles, ['騎士'])
        self.assertEqual(new.yandere_targets, {})
        self.assertEqual(new.mokumoku_turns, 0)
        self.assertIn('ベーシック', inter.texts()[0])

    async def test_replay_does_not_overwrite_running_game(self):
        old = self.started_game()
        old.is_running = False
        other = jinrou.JinrouGame()
        other.is_running = True
        self.cog.games[self.channel.id] = other
        inter = FakeInteraction(self.players[0], self.channel)
        await press(jinrou.ReplayView(old, self.cog), 'replay', inter)
        self.assertIs(self.cog.games[self.channel.id], other)
        self.assertIn('別のゲーム', inter.texts()[0])


if __name__ == '__main__':
    unittest.main()
