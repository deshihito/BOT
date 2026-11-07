"""ダンジョン Phase 1-C（fast-forward ウォーカー）の単体テスト。

対象は cogs/dangeon.py の Phase 1-C で導入した部分（設計書
dungeon-phase1-design.md §4）:
  - (a) 直線通路を1回の plan で部屋まで進む
  - (b) 分岐点で止まる
  - (c) 行き止まりで止まる
  - (d) 特殊タイル上で止まる
  - (e) 18歩で止まる
  - (f) 部屋内からは部屋の出口方向にだけ進める
  - (g) 斜めキーが合法手に含まれない（CLEF_MOVE_KEYS / plan / fallback）
  - (h) d_execute_journey が経路を適用し、turns と action_log を残す

グリッド/インスタンスは最小の手作り物を dg_instances へ差し込む。
依存スタブの方式は tests/test_dungeon_logic.py と同一（その installer を再利用する）。
"""

import asyncio
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from tests.test_dungeon_logic import _install_dependency_stubs
except Exception:  # tests をパッケージとして解決できない実行形態向け
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_dungeon_logic import _install_dependency_stubs

_install_dependency_stubs()

import core.game.dungeon.entry as dangeon


def _blank_grid():
    return [[dangeon.D_WALL] * dangeon.D2_MAP_W for _ in range(dangeon.D2_MAP_H)]


def _carve_room(grid, rooms, room_id, role, x, y, w, h):
    for gy in range(y, y + h):
        for gx in range(x, x + w):
            grid[gy][gx] = dangeon.D_FLOOR
    room = {
        "id": room_id, "role": role, "rect": (x, y, w, h),
        "center": (x + w // 2, y + h // 2), "sector": (0, 0), "route": "main",
    }
    rooms.append(room)
    return room


def _carve_cells(grid, cells, tile=None):
    for gx, gy in cells:
        grid[gy][gx] = tile or dangeon.D_FLOOR


def _inject(uid, grid, rooms, start=(1, 1)):
    dangeon.dg_instances[(str(uid), 1)] = {
        "seed": 0, "grid": grid, "rooms": rooms, "start": start, "consumed": set(),
    }


class TestPlanWalk(unittest.TestCase):
    def setUp(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def tearDown(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def _two_room_map(self, uid):
        """部屋A(2,2,5,5) -通路y=4- 部屋B(10,2,5,5) の最小マップ。"""
        grid = _blank_grid()
        rooms = []
        _carve_room(grid, rooms, 0, "start", 2, 2, 5, 5)
        _carve_room(grid, rooms, 1, "combat", 10, 2, 5, 5)
        _carve_cells(grid, [(7, 4), (8, 4), (9, 4)])
        _inject(uid, grid, rooms, start=(4, 4))
        return grid, rooms

    def test_a_straight_corridor_reaches_room_in_one_plan(self):
        self._two_room_map("w-a")
        plan = dangeon.d_plan_walk("w-a", 1, 4, 4, "right")
        self.assertEqual(plan["stop_reason"], "room")
        self.assertEqual(plan["entered_room_id"], 1)
        self.assertEqual(plan["stop_cell"], (10, 4))
        # 部屋A内2歩 + 通路3歩 + 部屋Bの入口1歩
        self.assertEqual(plan["path"], [(5, 4), (6, 4), (7, 4), (8, 4), (9, 4), (10, 4)])

    def test_b_stops_at_junction(self):
        grid = _blank_grid()
        _carve_cells(grid, [(x, 10) for x in range(2, 13)])       # 横通路
        _carve_cells(grid, [(7, y) for y in range(5, 10)])        # 上方向の分岐
        _inject("w-b", grid, [], start=(2, 10))
        plan = dangeon.d_plan_walk("w-b", 1, 2, 10, "right")
        self.assertEqual(plan["stop_reason"], "junction")
        self.assertEqual(plan["stop_cell"], (7, 10))
        self.assertEqual(len(plan["path"]), 5)

    def test_c_stops_at_dead_end(self):
        grid = _blank_grid()
        _carve_cells(grid, [(x, 20) for x in range(2, 7)])
        _inject("w-c", grid, [], start=(2, 20))
        plan = dangeon.d_plan_walk("w-c", 1, 2, 20, "right")
        self.assertEqual(plan["stop_reason"], "dead_end")
        self.assertEqual(plan["stop_cell"], (6, 20))
        self.assertEqual(len(plan["path"]), 4)

    def test_d_stops_on_special_tile(self):
        grid = _blank_grid()
        _carve_cells(grid, [(x, 24) for x in range(2, 11)])
        grid[24][5] = dangeon.D_CHEST
        _inject("w-d", grid, [], start=(2, 24))
        plan = dangeon.d_plan_walk("w-d", 1, 2, 24, "right")
        self.assertEqual(plan["stop_reason"], "special")
        self.assertEqual(plan["stop_cell"], (5, 24))
        self.assertEqual(plan["path"], [(3, 24), (4, 24), (5, 24)])

    def test_e_stops_at_max_steps(self):
        grid = _blank_grid()
        _carve_cells(grid, [(x, 14) for x in range(1, 28)])
        _inject("w-e", grid, [], start=(1, 14))
        plan = dangeon.d_plan_walk("w-e", 1, 1, 14, "right")
        self.assertEqual(plan["stop_reason"], "max_steps")
        self.assertEqual(len(plan["path"]), dangeon.D_WALK_MAX_STEPS)
        self.assertEqual(plan["stop_cell"], (1 + dangeon.D_WALK_MAX_STEPS, 14))

    def test_f_room_only_exits_toward_its_opening(self):
        grid = _blank_grid()
        rooms = []
        _carve_room(grid, rooms, 0, "start", 2, 12, 5, 5)
        _carve_room(grid, rooms, 1, "combat", 10, 12, 5, 5)
        _carve_cells(grid, [(7, 14), (8, 14), (9, 14)])
        _inject("w-f", grid, rooms, start=(4, 14))

        # 出口（東）方向: 通路を抜けて隣の部屋へ入る。
        plan = dangeon.d_plan_walk("w-f", 1, 4, 14, "right")
        self.assertEqual(plan["stop_reason"], "room")
        self.assertEqual(plan["entered_room_id"], 1)

        # 出口のない方向（北）: 部屋の壁際で止まり、部屋の外へは出ない。
        plan = dangeon.d_plan_walk("w-f", 1, 4, 14, "up")
        self.assertEqual(plan["stop_reason"], "room_edge")
        self.assertEqual(plan["stop_cell"], (4, 12))
        rx, ry, rw, rh = rooms[0]["rect"]
        for cx, cy in plan["path"]:
            self.assertTrue(rx <= cx < rx + rw and ry <= cy < ry + rh)

    def test_g_diagonals_are_not_legal_moves(self):
        self.assertEqual(set(dangeon.CLEF_MOVE_KEYS), {"up", "down", "left", "right"})
        for diag in ("leftup", "rightup", "leftdown", "rightdown"):
            self.assertNotIn(diag, dangeon.CLEF_MOVE_KEYS)
            self.assertIsNone(
                dangeon.d_normalize_choice(diag, set(dangeon.CLEF_MOVE_KEYS), None))
        # plan に斜めを渡しても1歩も進まない。
        self._two_room_map("w-g")
        plan = dangeon.d_plan_walk("w-g", 1, 4, 4, "leftup")
        self.assertEqual(plan["stop_reason"], "blocked")
        self.assertEqual(plan["path"], [])
        # フォールバックも4方向のいずれかしか返さない。
        p = dangeon.d_get_player("w-g")
        p["floor"], p["x"], p["y"] = 1, 4, 4
        self.assertIn(dangeon.dungeon_best_direction("w-g"), dangeon.CLEF_MOVE_KEYS)


class TestExecuteJourney(unittest.TestCase):
    def setUp(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def tearDown(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def test_h_journey_applies_path_and_records_action(self):
        grid = _blank_grid()
        rooms = []
        _carve_room(grid, rooms, 0, "start", 2, 2, 5, 5)
        _carve_room(grid, rooms, 1, "combat", 10, 2, 5, 5)
        _carve_cells(grid, [(7, 4), (8, 4), (9, 4)])
        _inject("w-h", grid, rooms, start=(4, 4))
        p = dangeon.d_get_player("w-h")
        p["floor"], p["x"], p["y"] = 1, 4, 4
        turns_before = p["turns"]

        async def _no_save(uid, db_api):
            return None

        with patch.object(dangeon, "dg_save_player", _no_save), \
                patch.object(dangeon.random, "random", return_value=0.99):
            result = asyncio.run(
                dangeon.d_execute_journey("w-h", None, "right", source="manual"))

        self.assertEqual(result["stop_reason"], "room")
        self.assertEqual(result["steps"], 6)
        self.assertEqual((p["x"], p["y"]), (10, 4))
        self.assertEqual(p["turns"], turns_before + 6)
        self.assertTrue(result["messages"][0].startswith("東へ6歩進んだ。"))
        journeys = [a for a in p["action_log"] if a["action"] == "journey"]
        self.assertEqual(len(journeys), 1)
        self.assertIn("6歩", journeys[0]["result"])


if __name__ == "__main__":
    unittest.main()
