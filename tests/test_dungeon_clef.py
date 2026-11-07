import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from tests.test_dungeon_logic import _install_dependency_stubs
except Exception:  # tests をパッケージとして解決できない実行形態向け
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_dungeon_logic import _install_dependency_stubs

_install_dependency_stubs()

import core.game.dungeon.entry as dangeon
from core.general.ai import logfare  # noqa: E402


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


class DungeonClefStopReasonTest(unittest.TestCase):
    """Clef の安全停止条件の回帰テスト。

    状態異常（毒・出血など）があるだけでは停止しないこと（Phase 1-E
    追加要望で停止条件から除外）。HP 条件などの安全停止は残ること。
    """

    def setUp(self):
        dangeon.dg_players.clear()
        dangeon.dg_instances.clear()

    def tearDown(self):
        dangeon.dg_players.clear()
        dangeon.dg_instances.clear()

    def _clef(self):
        player = dangeon.ClefDungeonPlayer.__new__(dangeon.ClefDungeonPlayer)
        player._run_stats = {}
        return player

    def test_status_effect_alone_does_not_stop(self):
        uid = "clef-status"
        p = dangeon.d_get_player(uid)
        stats = dangeon.d_effective_stats(p)
        p["hp"] = stats["max_hp"]
        for key in ("poison", "bleed", "burn"):
            p["active_effects"] = [{"key": key, "turns": 3}]
            self.assertEqual(self._clef()._stop_reason(uid, []), "")

    def test_status_effect_with_low_hp_still_stops_for_hp(self):
        uid = "clef-status-low"
        p = dangeon.d_get_player(uid)
        stats = dangeon.d_effective_stats(p)
        p["active_effects"] = [{"key": "poison", "turns": 3}]
        p["hp"] = max(1, int(stats["max_hp"] * 0.29))
        self.assertEqual(self._clef()._stop_reason(uid, []), "HPが30%未満")


if __name__ == "__main__":
    unittest.main()
