"""ダウトのボタンUI（ダウト/パス）と !doubt の利用統計のテスト。"""

import asyncio
import types
import unittest
from unittest.mock import patch

from game_fakes import (FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember,
                        fast_time, press, choose, real_sleep)
import core.game.doubt.cog as doubt


class DoubtButtonTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(100, self.guild)
        self.players = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = doubt.Doubt(FakeBot(self.channel))

    def ctx(self, author):
        return types.SimpleNamespace(author=author, channel=self.channel, send=self.channel.send,
                                     guild=self.guild)

    def new_game(self, hands):
        game = doubt.DoubtEngine([p.id for p in self.players])
        game.hands = {p.id: doubt.sort_hand(list(h)) for p, h in zip(self.players, hands)}
        self.cog.games[self.channel.id] = game
        return game

    async def play(self, game, member, card):
        panel = doubt.GameControlView(game, self.cog)
        inter = FakeInteraction(member, self.channel)
        await press(panel, 'play', inter)
        view = inter.response.sent[-1].view
        select = next(s for s in view.children if any(o.value == card for o in s.options))
        return await choose(select, card, FakeInteraction(member, self.channel))

    async def test_doubt_button_catches_lie(self):
        game = self.new_game([['[S-9]'], ['[H-2]', '[H-3]'], ['[D-4]']])
        with fast_time():
            task = asyncio.create_task(self.play(game, self.players[0], '[S-9]'))
            await real_sleep(0.001)
            panel = doubt.GameControlView(game, self.cog)
            inter = FakeInteraction(self.players[1], self.channel)
            await press(panel, 'doubt', inter)
            await task
        self.assertIn('ダウト成功', ' '.join(self.channel.texts()))
        self.assertEqual(game.hands[1], ['[S-9]'])

    async def test_doubt_button_outside_window_is_refused(self):
        game = self.new_game([['[S-9]'], ['[H-2]'], ['[D-4]']])
        panel = doubt.GameControlView(game, self.cog)
        inter = FakeInteraction(self.players[1], self.channel)
        await press(panel, 'doubt', inter)
        self.assertIn('タイミングではありません', inter.texts()[0])

    async def test_pass_button_advances_turn(self):
        game = self.new_game([['[S-9]'], ['[H-2]'], ['[D-4]']])
        panel = doubt.GameControlView(game, self.cog)
        inter = FakeInteraction(self.players[0], self.channel)
        await press(panel, 'pass_turn', inter)
        self.assertEqual(game.current_player_id, 2)
        self.assertEqual(game.pass_count, 1)

    async def test_pass_button_by_wrong_player_is_refused(self):
        game = self.new_game([['[S-9]'], ['[H-2]'], ['[D-4]']])
        panel = doubt.GameControlView(game, self.cog)
        inter = FakeInteraction(self.players[1], self.channel)
        await press(panel, 'pass_turn', inter)
        self.assertIn('番ではありません', inter.texts()[0])
        self.assertEqual(game.current_player_id, 1)

    async def test_prefix_start_records_usage(self):
        with patch.object(doubt.usage_stats, "record_action_safely") as rec, \
                patch.object(doubt.action_usage, "record_safely", new=self._fake_record) as arec:
            with fast_time():
                await self.cog.start_game.callback(self.cog, self.ctx(self.players[0]))
            rec.assert_called_once_with("game:game:doubt")
            self.assertEqual(self._recorded, [(self.guild.id, 1, "game:game:doubt")])

    async def _fake_record(self, guild_id, user_id, action_id):
        self._recorded = getattr(self, "_recorded", [])
        self._recorded.append((guild_id, user_id, action_id))


if __name__ == "__main__":
    unittest.main()
