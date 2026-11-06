"""ハイ＆ローの同点フロー（2026-11-07）: 同点→選択パネル→続ける/やめる/時間切れ。"""

import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, FakeMessage
from core.game.highlow import HighLowGame
from core.game.highlow_cog.cog import HighLow, HighLowPanel


def make_game():
    game = HighLowGame.__new__(HighLowGame)
    game.deck = [(9, "♥"), (7, "♥")]  # pop は末尾から: 最初に 7（同点）、次に 9
    game.current = (7, "♠")
    game.streak = 0
    game.finished = False
    game.cleared = False
    game.last_drawn = None
    game.last_outcome = None
    return game


class HighLowTieFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild(77)
        self.channel = FakeChannel(770, self.guild)
        self.owner = FakeMember(1, self.guild)
        self.cog = HighLow(types.SimpleNamespace())

    async def _tie_panel(self):
        game = make_game()
        panel = HighLowPanel(self.cog, self.owner, game)
        message = FakeMessage(self.channel)
        panel.message = message
        inter = FakeInteraction(self.owner, self.channel, message=message)
        await panel.high.callback(inter)
        tie_panel = message.view
        self.assertIsNotNone(tie_panel)
        self.assertEqual(tie_panel.mode, "tie")
        return game, message, tie_panel

    async def test_tie_shows_choice_buttons_and_streak_kept(self):
        game, message, tie_panel = await self._tie_panel()
        self.assertTrue(hasattr(tie_panel, "keep_going"))
        self.assertTrue(hasattr(tie_panel, "stop_here"))
        self.assertEqual(game.streak, 0)
        self.assertFalse(game.finished)
        self.assertIn("同点", message.text())

    async def test_tie_continue_resumes_play(self):
        game, message, tie_panel = await self._tie_panel()
        inter = FakeInteraction(self.owner, self.channel, message=message)
        await tie_panel.keep_going.callback(inter)
        self.assertEqual(message.view.mode, "play")
        # 続けた先で 9 を当てればストリークが伸びる
        inter2 = FakeInteraction(self.owner, self.channel, message=message)
        await message.view.high.callback(inter2)
        self.assertEqual(game.streak, 1)

    async def test_tie_stop_here_finishes(self):
        game, message, tie_panel = await self._tie_panel()
        inter = FakeInteraction(self.owner, self.channel, message=message)
        await tie_panel.stop_here.callback(inter)
        self.assertEqual(message.view.mode, "done")
        self.assertTrue(game.finished)
        self.assertIn("ここでやめました", message.text())

    async def test_tie_timeout_finishes_as_stop(self):
        game, message, tie_panel = await self._tie_panel()
        await tie_panel.on_timeout()
        self.assertTrue(game.finished)
        self.assertEqual(message.view.mode, "done")
        self.assertIn("時間切れ", message.text())


if __name__ == "__main__":
    unittest.main()
