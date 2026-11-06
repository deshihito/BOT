"""人狼フェーズ境界スナップショット（core/game/jinrou_snapshot.py）のテスト。"""
import types
import unittest

from core.game.jinrou.game import JinrouGame
from core.game import jinrou_snapshot


def member(uid, name=None):
    return types.SimpleNamespace(id=uid, display_name=name or f"user{uid}",
                                 name=name or f"user{uid}", mention=f"<@{uid}>", bot=False)


def make_game(n=5):
    game = JinrouGame()
    channel = types.SimpleNamespace(id=555, guild=types.SimpleNamespace(id=777))
    game.game_channel = channel
    game.players = [member(i) for i in range(1, n + 1)]
    game.alive_players = list(game.players)
    game.roles = {i: "一般通過あごむに" for i in range(1, n + 1)}
    game.roles[1] = "人狼"
    game.host_id = 1
    game.day_count = 2
    return game


class SnapshotTest(unittest.TestCase):
    def test_build_state_is_json_safe(self):
        import json
        game = make_game()
        state = jinrou_snapshot.build_state(game, "night_start")
        self.assertIsNotNone(state)
        json.dumps(state)  # JSON 化できること
        self.assertEqual(state["boundary"], "night_start")
        self.assertEqual(state["roles"]["1"], "人狼")
        self.assertEqual(state["alive_ids"], [1, 2, 3, 4, 5])
        self.assertEqual(state["day_count"], 2)

    def test_global_game_is_skipped(self):
        game = make_game()
        game.is_global = True
        self.assertIsNone(jinrou_snapshot.build_state(game, "night_start"))

    def test_unknown_boundary_is_skipped(self):
        game = make_game()
        self.assertIsNone(jinrou_snapshot.build_state(game, "mid_night"))

    def test_apply_state_roundtrip(self):
        game = make_game()
        game.silenced_players = {2, 3}
        game.chairman_ketsugu_used = True
        state = jinrou_snapshot.build_state(game, "day_start")

        restored = JinrouGame()
        ok = jinrou_snapshot.apply_state(restored, state, lambda ref: member(ref["id"], ref["name"]))
        self.assertTrue(ok)
        self.assertEqual([p.id for p in restored.players], [1, 2, 3, 4, 5])
        self.assertEqual(restored.roles[1], "人狼")
        self.assertEqual(restored.day_count, 2)
        self.assertEqual(restored.silenced_players, {2, 3})
        self.assertTrue(restored.chairman_ketsugu_used)
        self.assertTrue(restored.is_running)
        self.assertTrue(restored.started)

    def test_apply_state_requires_five_players(self):
        game = make_game(4)
        state = jinrou_snapshot.build_state(game, "roles_assigned")
        restored = JinrouGame()
        self.assertFalse(jinrou_snapshot.apply_state(restored, state, lambda ref: member(ref["id"])))


if __name__ == "__main__":
    unittest.main()
