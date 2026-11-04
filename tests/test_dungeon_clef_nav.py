"""ダンジョン Phase 1-E（Clef行き先判断＋「階段へ」＋踏破計測）の単体テスト。

対象は cogs/dangeon.py の Phase 1-E で導入・改修した部分（設計書
dungeon-phase1-design.md §8 / §9 PR 1-E）:
  - (a) 部屋グラフ BFS の距離（階段までの部屋数）が手作りマップで厳密に、
        生成インスタンスでも構造どおり正しい
  - (b) フォールバック dungeon_best_direction が作戦に応じた目標部屋の
        方向を返す（作戦で目標が変わる）
  - (c) ナビゲーション計画 d_plan_navigation_direction で journey を
        繰り返すと、生成インスタンスのスタートから階段の間→階段タイルへ
        到達できる（戦闘発動は無効化。ボタンは1押下10 journey上限のため
        大きい配置では2押下に分かれる想定で、上限は実測+余裕で見る）
  - (d) floor_history が階段昇降の手順で正しく記録される

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

from cogs import dangeon  # noqa: E402


def _blank_grid():
    return [[dangeon.D_WALL] * dangeon.D2_MAP_W for _ in range(dangeon.D2_MAP_H)]


def _carve_room(grid, rooms, room_id, role, x, y, w, h, **extra):
    for gy in range(y, y + h):
        for gx in range(x, x + w):
            grid[gy][gx] = dangeon.D_FLOOR
    room = {
        "id": room_id, "role": role, "rect": (x, y, w, h),
        "center": (x + w // 2, y + h // 2), "sector": (0, 0), "route": "main",
    }
    room.update(extra)
    rooms.append(room)
    return room


def _carve_cells(grid, cells, tile=None):
    for gx, gy in cells:
        grid[gy][gx] = tile or dangeon.D_FLOOR


def _inject(uid, grid, rooms, start=(4, 4), floor=1):
    inst = {
        "seed": 0, "grid": grid, "rooms": rooms, "start": start,
        "consumed": set(), "visited": set(), "cleared": set(), "traversed": set(),
    }
    dangeon.dg_instances[(str(uid), floor)] = inst
    return inst


async def _no_save(uid, db_api):
    return None


def _journey(uid, direction):
    with patch.object(dangeon, "dg_save_player", _no_save):
        return asyncio.run(dangeon.d_execute_journey(uid, None, direction, source="manual"))


def _four_room_map(uid):
    """start(西) - combat(東) - stairs(さらに東) / chest(南) の手作りマップ。

    部屋グラフは 0:{1,2}, 1:{0,3}, 2:{0}, 3:{1} になる。
    """
    grid = _blank_grid()
    rooms = []
    _carve_room(grid, rooms, 0, "start", 2, 2, 5, 5)
    _carve_room(grid, rooms, 1, "combat", 10, 2, 5, 5)
    _carve_room(grid, rooms, 2, "chest", 2, 10, 5, 5)
    _carve_room(grid, rooms, 3, "stairs", 18, 2, 5, 5, guarded=True)
    _carve_cells(grid, [(7, 4), (8, 4), (9, 4)])
    _carve_cells(grid, [(4, 7), (4, 8), (4, 9)])
    _carve_cells(grid, [(15, 4), (16, 4), (17, 4)])
    grid[4][20] = dangeon.D_STAIRS
    grid[12][4] = dangeon.D_CHEST
    inst = _inject(uid, grid, rooms, start=(4, 4))
    p = dangeon.d_get_player(uid)
    p["floor"], p["x"], p["y"] = 1, 4, 4
    return grid, rooms, inst, p


class NavTestCase(unittest.TestCase):
    def setUp(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def tearDown(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()


class TestRoomGraph(NavTestCase):
    """(a) 部屋グラフ BFS の距離。"""

    def test_graph_and_distances_on_handmade_map(self):
        uid = "nav-a1"
        _, _, inst, _ = _four_room_map(uid)
        graph = dangeon.d_room_graph(inst)
        self.assertEqual(graph[0], {1, 2})
        self.assertEqual(graph[1], {0, 3})
        self.assertEqual(graph[2], {0})
        self.assertEqual(graph[3], {1})
        dist = dangeon.d_room_distances(inst, 0)
        self.assertEqual(dist, {0: 0, 1: 1, 2: 1, 3: 2})

    def test_rooms_to_stairs_counts(self):
        uid = "nav-a2"
        _four_room_map(uid)
        # 部屋の中: 階段の間自身は0、隣は1、スタートからは2。
        self.assertEqual(dangeon.d_rooms_to_stairs(uid, 1, 4, 4), 2)
        self.assertEqual(dangeon.d_rooms_to_stairs(uid, 1, 12, 4), 1)
        self.assertEqual(dangeon.d_rooms_to_stairs(uid, 1, 20, 4), 0)
        # 通路: 次に入る部屋を1つ数える（start-combat 間の通路からは2）。
        self.assertEqual(dangeon.d_rooms_to_stairs(uid, 1, 8, 4), 2)
        self.assertEqual(dangeon.d_rooms_to_stairs(uid, 1, 16, 4), 1)

    def test_generated_instances_graph_is_connected(self):
        # メインルートは5部屋の道なので距離は最大4。部屋同士の直接隣接で
        # 近道ができる場合はそれより小さくなる（幾何的に正しい短縮）。
        for n in range(4):
            for floor in (1, 2, 5):
                uid = f"nav-gen-{n}-{floor}"
                inst = dangeon.d_get_instance(uid, floor)
                start = next(r for r in inst["rooms"] if r["role"] == "start")
                stairs = next(r for r in inst["rooms"] if r["role"] == "stairs")
                dist = dangeon.d_room_distances(inst, start["id"])
                self.assertEqual(len(dist), len(inst["rooms"]))
                self.assertGreaterEqual(dist[stairs["id"]], 1)
                self.assertLessEqual(dist[stairs["id"]], 4)
                self.assertEqual(
                    dangeon.d_rooms_to_stairs(uid, floor, *inst["start"]),
                    dist[stairs["id"]],
                )


class TestFallbackDirection(NavTestCase):
    """(b) フォールバックが作戦に応じた目標部屋の方向を返す。"""

    def test_safe_and_battle_head_to_next_combat_room(self):
        uid = "nav-b1"
        _four_room_map(uid)
        self.assertEqual(dangeon.d_target_room(uid, "安全探索")["id"], 1)
        self.assertEqual(dangeon.dungeon_best_direction(uid, "安全探索"), "right")
        self.assertEqual(dangeon.dungeon_best_direction(uid, "戦闘優先"), "right")

    def test_treasure_heads_to_chest_room(self):
        uid = "nav-b2"
        _four_room_map(uid)
        self.assertEqual(dangeon.d_target_room(uid, "財宝優先")["id"], 2)
        self.assertEqual(dangeon.dungeon_best_direction(uid, "財宝優先"), "down")

    def test_safe_advances_after_combat_room_cleared(self):
        uid = "nav-b3"
        _, _, inst, _ = _four_room_map(uid)
        inst["cleared"].add(1)
        # メインルートの次の未制圧は宝箱の間（南）。
        self.assertEqual(dangeon.d_target_room(uid, "安全探索")["id"], 2)
        self.assertEqual(dangeon.dungeon_best_direction(uid, "安全探索"), "down")

    def test_explore_heads_to_undiscovered_room(self):
        uid = "nav-b4"
        _, rooms, inst, _ = _four_room_map(uid)
        # スタートと戦闘の間だけ発見済みにする。
        for room in rooms[:2]:
            rx, ry, rw, rh = room["rect"]
            for gy in range(ry, ry + rh):
                for gx in range(rx, rx + rw):
                    inst["visited"].add((gx, gy))
        self.assertEqual(dangeon.d_target_room(uid, "探索優先")["id"], 2)
        self.assertEqual(dangeon.dungeon_best_direction(uid, "探索優先"), "down")

    def test_move_criteria_describes_journey_destinations(self):
        uid = "nav-b5"
        _, rooms, inst, _ = _four_room_map(uid)
        rx, ry, rw, rh = rooms[0]["rect"]
        for gy in range(ry, ry + rh):
            for gx in range(rx, rx + rw):
                inst["visited"].add((gx, gy))
        criteria = dangeon.dungeon_move_criteria(uid, 1, 4, 4)
        # 東は未発見の戦闘の間へ、西/北/南は発見済みの自室や通路側。
        self.assertIn("未探索の部屋", criteria["right"])
        self.assertIn("移動可", criteria["right"])
        self.assertIn("スタートの間", criteria["up"])


class TestClefStateText(NavTestCase):
    def test_state_text_uses_room_summary(self):
        uid = "nav-s1"
        _, rooms, inst, _ = _four_room_map(uid)
        rx, ry, rw, rh = rooms[0]["rect"]
        for gy in range(ry, ry + rh):
            for gx in range(rx, rx + rw):
                inst["visited"].add((gx, gy))
        player = dangeon.ClefDungeonPlayer.__new__(dangeon.ClefDungeonPlayer)
        player._run_stats = {}
        text = player._state_text(uid, "安全探索", [])
        self.assertIn("現在地の部屋: スタートの間", text)
        self.assertIn("階段の間まで: あと2部屋", text)
        self.assertIn("階段の番人は未制圧", text)
        self.assertNotIn("周囲:", text)


class TestNavigation(NavTestCase):
    """(c) ナビゲーション計画で階段の間→階段タイルへ到達できる。"""

    def _prepare(self, uid, floor):
        inst = dangeon.d_get_instance(uid, floor)
        # 戦闘発動を無効化（全室制圧済み）し、罠は床に潰して決定的にする。
        inst["cleared"] = {r["id"] for r in inst["rooms"]}
        for y in range(dangeon.D2_MAP_H):
            for x in range(dangeon.D2_MAP_W):
                if inst["grid"][y][x] == dangeon.D_TRAP:
                    inst["grid"][y][x] = dangeon.D_FLOOR
        p = dangeon.d_get_player(uid)
        p["floor"], p["x"], p["y"] = floor, inst["start"][0], inst["start"][1]
        return inst, p

    def test_navigation_reaches_stairs_room_then_tile(self):
        for n in range(3):
            for floor in (1, 2, 5):
                uid = f"nav-c-{n}-{floor}"
                dangeon.dg_instances.clear()
                dangeon.dg_players.clear()
                inst, p = self._prepare(uid, floor)
                stairs = next(r for r in inst["rooms"] if r["role"] == "stairs")
                target = stairs["center"]
                room_journey = None
                tile_journey = None
                with patch.object(dangeon.random, "random", return_value=0.99):
                    for step in range(1, 31):
                        room = dangeon.d_room_at(inst, p["x"], p["y"])
                        if room is stairs and room_journey is None:
                            room_journey = step - 1
                        if (p["x"], p["y"]) == tuple(target):
                            tile_journey = step - 1
                            break
                        direction = dangeon.d_plan_navigation_direction(
                            uid, floor, p["x"], p["y"], target)
                        self.assertIsNotNone(direction, f"{uid} F{floor} step {step}")
                        result = _journey(uid, direction)
                        self.assertGreater(result["steps"], 0)
                        self.assertFalse(result["died"])
                self.assertIsNotNone(room_journey, f"{uid} F{floor}: 階段の間に未到達")
                # 実測（48インスタンス）: 階段の間まで平均約10・最大14 journey。
                # 「階段へ」ボタンは1押下10 journey上限なので、大きい配置では
                # 2押下目で到達する想定。計画自体は15以内に到達すること。
                self.assertLessEqual(room_journey, 15, f"{uid} F{floor}")
                self.assertIsNotNone(tile_journey, f"{uid} F{floor}: 階段タイルに未到達")
                self.assertEqual((p["x"], p["y"]), tuple(target))

    def test_stairs_tile_reachable_in_stop_graph(self):
        # Phase 1-E で塞いだ中心タイル到達不能（生成の約2割）の回帰テスト。
        # 停止セルのグラフで階段タイル（部屋中央）へ到達できること。
        for n in range(4):
            for floor in (1, 2, 3, 5):
                uid = f"nav-tile-{n}-{floor}"
                dangeon.dg_instances.clear()
                dangeon.dg_players.clear()
                inst = dangeon.d_get_instance(uid, floor)
                stairs = next(r for r in inst["rooms"] if r["role"] == "stairs")
                seen = {inst["start"]}
                stops = {inst["start"]}
                frontier = [inst["start"]]
                while frontier:
                    cur = frontier.pop()
                    for key in ("up", "down", "left", "right"):
                        if dangeon.d_direction_blocked(uid, floor, cur[0], cur[1], key):
                            continue
                        plan = dangeon.d_plan_walk(uid, floor, cur[0], cur[1], key)
                        seen.update(plan["path"])
                        if plan["path"] and plan["stop_cell"] not in stops:
                            stops.add(plan["stop_cell"])
                            frontier.append(plan["stop_cell"])
                self.assertIn(tuple(stairs["center"]), seen,
                              f"{uid} F{floor}: 階段タイルに到達できない")


class TestFloorHistory(NavTestCase):
    """(d) floor_history の記録。"""

    def test_record_clear_and_reset_counters(self):
        uid = "nav-h1"
        p = dangeon.d_get_player(uid)
        p["floor"] = 3
        p["turns"] = 100
        p["floor_start_turns"] = 88
        p["floor_journeys"] = 5
        entry = dangeon.d_record_floor_clear(uid)
        self.assertEqual(entry["floor"], 3)
        self.assertEqual(entry["turns_used"], 12)
        self.assertEqual(entry["journeys_used"], 5)
        self.assertIn("cleared_at", entry)
        self.assertEqual(p["floor_history"], [entry])
        # 階段を上った直後の遷移（StairsView / Clef / 部屋で行動と同じ手順）。
        p["floor"] = 4
        dangeon.d_reset_floor_counters(p)
        self.assertEqual(p["floor_start_turns"], 100)
        self.assertEqual(p["floor_journeys"], 0)

    def test_history_capped_at_50(self):
        uid = "nav-h2"
        p = dangeon.d_get_player(uid)
        for i in range(55):
            p["floor"] = i + 1
            dangeon.d_record_floor_clear(uid)
        self.assertEqual(len(p["floor_history"]), 50)
        self.assertEqual(p["floor_history"][-1]["floor"], 55)

    def test_journey_increments_floor_journeys(self):
        uid = "nav-h3"
        _, _, _, p = _four_room_map(uid)
        self.assertEqual(p.get("floor_journeys", 0), 0)
        with patch.object(dangeon.random, "random", return_value=0.99):
            _journey(uid, "right")
        self.assertEqual(p["floor_journeys"], 1)


if __name__ == "__main__":
    unittest.main()
