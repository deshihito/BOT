import asyncio
import unittest
from unittest.mock import AsyncMock, patch


from cogs import dangeon
from core import logfare


class DungeonClefDecisionTest(unittest.IsolatedAsyncioTestCase):
    def make_player(self):
        player = dangeon.ClefDungeonPlayer.__new__(dangeon.ClefDungeonPlayer)
        player._state_text = lambda uid, plan, logs: "dungeon state"
        return player

    async def test_sends_decision_to_clef_and_extracts_choice(self):
        player = self.make_player()
        question = {"move": {"type": "choice", "criteria": {"up": "north"}}}
        with patch.object(logfare, "decision", new=AsyncMock(return_value={
            "success": True,
            "result": {"answers": {"move": {"choice": "up"}}},
        })) as decision:
            self.assertEqual(await player._decide("42", [], "安全探索", question), "up")
        self.assertEqual(decision.await_args.args[:3], ("clef", "dungeon state", question))

    async def test_returns_empty_choice_after_clef_error_for_game_fallback(self):
        player = self.make_player()
        logs = []
        with patch.object(logfare, "decision", new=AsyncMock(
            side_effect=logfare.LogfareHTTPError(403)
        )), patch.object(dangeon, "CLEF_RETRIES", 1):
            self.assertEqual(await player._decide("42", logs, "安全探索", {"move": {}}), "")
        self.assertTrue(any("Clef APIエラー" in line for line in logs))

    async def test_retries_transient_timeout(self):
        player = self.make_player()
        question = {"stairs": {"type": "choice"}}
        with patch.object(logfare, "decision", new=AsyncMock(side_effect=[
            asyncio.TimeoutError(), {"answers": {"stairs": "up"}},
        ])) as decision, patch.object(dangeon, "CLEF_RETRY_DELAY", 0):
            self.assertEqual(await player._decide("42", [], "最短攻略", question), "up")
        self.assertEqual(decision.await_count, 2)


if __name__ == "__main__":
    unittest.main()
