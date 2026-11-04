"""ダンジョン Phase 1-D（部屋役割の発動＋フォグ＋表示）の単体テスト。

対象は cogs/dangeon.py の Phase 1-D で導入した部分（設計書
dungeon-phase1-design.md §5 / §6-1、確定事項 D4 / D5）:
  - (a) combat 部屋は初入室でのみ戦闘が発動し、制圧後は再発動しない
        （未制圧なら再入室で再発動する。勝利時の制圧は CombatView._win 経由）
  - (b) stairs 部屋は制圧前に階段が使えず（入室・階段タイル・部屋で行動の
        いずれも番人戦/ガードになる）、制圧後に階段が使える
  - (c) chest 部屋の発動は1回だけ
  - (d) アンブッシュはそのインスタンスで初めて踏む通路マスでのみ抽選され、
        踏破済みマスでは抽選されない
  - (e) visited の encode/decode 往復と、部屋入室時の公開範囲

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


def _two_room_map(uid, role_b, **room_b_extra):
    """部屋A(start, 2,2,5,5) -通路y=4- 部屋B(10,2,5,5) の最小マップ。"""
    grid = _blank_grid()
    rooms = []
    _carve_room(grid, rooms, 0, "start", 2, 2, 5, 5)
    room_b = _carve_room(grid, rooms, 1, role_b, 10, 2, 5, 5, **room_b_extra)
    _carve_cells(grid, [(7, 4), (8, 4), (9, 4)])
    inst = _inject(uid, grid, rooms, start=(4, 4))
    p = dangeon.d_get_player(uid)
    p["floor"], p["x"], p["y"] = 1, 4, 4
    return grid, rooms, room_b, inst, p


class DungeonRoomTestCase(unittest.TestCase):
    def setUp(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()

    def tearDown(self):
        dangeon.dg_instances.clear()
        dangeon.dg_players.clear()


class TestCombatRoom(DungeonRoomTestCase):
    def test_a_combat_room_triggers_once_until_cleared(self):
        uid = "r-a"
        _, _, room_b, inst, p = _two_room_map(uid, "combat")

        # 初入室: 通常戦闘が発動する
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertEqual(result["view"], "combat")
        self.assertIsNotNone(result["enemy"])
        self.assertEqual(result["enemy"]["type"], "normal")
        self.assertEqual(result["room_id"], room_b["id"])
        self.assertFalse(dangeon.d_room_cleared(inst, room_b["id"]))

        # 未制圧のまま再入室すると再発動する（逃走した想定）
        p["x"], p["y"] = 4, 4
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertEqual(result["view"], "combat")
        self.assertIsNotNone(result["enemy"])

        # 戦闘 View の勝利処理で制圧される
        view = dangeon.DungeonCombatView(
            uid, 1, p["x"], p["y"], result["enemy"], None, room_id=room_b["id"])
        with patch.object(dangeon, "dg_save_player", _no_save):
            asyncio.run(view._win(dangeon._NoopInteraction()))
        self.assertTrue(dangeon.d_room_cleared(inst, room_b["id"]))

        # 制圧後の再入室では発動しない
        p["x"], p["y"] = 4, 4
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertIsNone(result["enemy"])
        self.assertNotEqual(result["view"], "combat")


class TestStairsRoom(DungeonRoomTestCase):
    def _stairs_map(self, uid):
        grid, rooms, room_b, inst, p = _two_room_map(
            uid, "stairs", guarded=True, boss=False)
        cx, cy = room_b["center"]
        grid[cy][cx] = dangeon.D_STAIRS
        return grid, rooms, room_b, inst, p

    def test_b_stairs_guarded_until_cleared(self):
        uid = "r-b"
        _, _, room_b, inst, p = self._stairs_map(uid)

        # 入室: 階段 View ではなく番人（精鋭）戦になる
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertEqual(result["view"], "combat")
        self.assertEqual(result["enemy"]["type"], "elite")
        self.assertEqual(result["room_id"], room_b["id"])

        # 階段タイルへ踏み込んでも番人戦になる（階段は開かない）
        p["x"], p["y"] = room_b["center"][0] - 1, room_b["center"][1]
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertEqual(result["view"], "combat")
        self.assertEqual(result["stop_reason"], "guard")
        self.assertEqual(result["enemy"]["type"], "elite")

        # 「部屋で行動」でも階段は使えない
        p["x"], p["y"] = room_b["center"]
        with patch.object(dangeon, "dg_save_player", _no_save):
            msg = asyncio.run(dangeon.d_current_cell_action(uid, None))
        self.assertIn("番人", msg)
        self.assertEqual(p["floor"], 1)

        # 番人を倒すと制圧され、階段タイルから階段 View が開く
        view = dangeon.DungeonCombatView(
            uid, 1, p["x"], p["y"], result["enemy"], None, room_id=room_b["id"])
        with patch.object(dangeon, "dg_save_player", _no_save):
            asyncio.run(view._win(dangeon._NoopInteraction()))
        self.assertTrue(dangeon.d_room_cleared(inst, room_b["id"]))

        p["x"], p["y"] = room_b["center"][0] - 1, room_b["center"][1]
        with patch.object(dangeon.random, "random", return_value=0.99):
            result = _journey(uid, "right")
        self.assertEqual(result["view"], "stairs")
        self.assertIsNone(result["enemy"])

    def test_b2_stairs_guardian_is_boss_on_boss_floors(self):
        # 5フロア毎はボス（確定事項 D5）: room の boss フラグで強制される
        enemy = dangeon.d_make_enemy(5, forced_rank="boss")
        self.assertEqual(enemy["type"], "boss")
        enemy = dangeon.d_make_enemy(5, forced_rank="elite")
        self.assertEqual(enemy["type"], "elite")
        enemy = dangeon.d_make_enemy(5, forced_rank="normal")
        self.assertEqual(enemy["type"], "normal")


class TestChestRoom(DungeonRoomTestCase):
    def test_c_chest_room_activates_only_once(self):
        uid = "r-c"
        grid, _, room_b, inst, p = _two_room_map(uid, "chest")
        cx, cy = room_b["center"]
        grid[cy][cx] = dangeon.D_CHEST

        with patch.object(dangeon.random, "random", return_value=0.4), \
                patch.object(dangeon.random, "randint", return_value=100):
            result = _journey(uid, "right")
        self.assertTrue(any("宝箱" in m for m in result["messages"]))
        self.assertTrue(dangeon.d_room_cleared(inst, room_b["id"]))
        # 中央タイルは消費済み（床）になっている
        self.assertEqual(dangeon.d_get_cell(uid, 1, cx, cy), dangeon.D_FLOOR)
        self.assertIn((cx, cy), inst["consumed"])

        # 再入室では発動しない
        p["x"], p["y"] = 4, 4
        with patch.object(dangeon.random, "random", return_value=0.4), \
                patch.object(dangeon.random, "randint", return_value=100):
            result = _journey(uid, "right")
        self.assertFalse(any("宝箱" in m for m in result["messages"]))


class TestAmbush(DungeonRoomTestCase):
    def _corridor_map(self, uid):
        grid = _blank_grid()
        _carve_cells(grid, [(x, 10) for x in range(2, 21)])
        inst = _inject(uid, grid, [], start=(2, 10))
        p = dangeon.d_get_player(uid)
        p["floor"], p["x"], p["y"] = 1, 2, 10
        return inst, p

    def test_d_ambush_triggers_on_first_step_cell(self):
        uid = "r-d1"
        self._corridor_map(uid)
        with patch.object(dangeon.random, "random", return_value=0.05):
            result = _journey(uid, "right")
        self.assertEqual(result["stop_reason"], "ambush")
        self.assertEqual(result["view"], "combat")
        self.assertEqual(result["enemy"]["type"], "normal")
        self.assertEqual(result["steps"], 1)

    def test_d_ambush_rolls_only_on_first_time_cells(self):
        uid = "r-d2"
        inst, p = self._corridor_map(uid)
        rolls = []

        def _counting_roll():
            rolls.append(1)
            return 0.99  # アンブッシュしない

        # 1回目: 初めて踏む通路マスでは1歩ごとに抽選される
        with patch.object(dangeon.random, "random", side_effect=_counting_roll):
            result = _journey(uid, "right")
        self.assertEqual(result["steps"], len(rolls))
        self.assertGreater(len(rolls), 0)
        self.assertIsNone(result["enemy"])
        # traversed は踏んだマス＋journey開始マス（立っているマス）を含む
        traversed_count = len(inst["traversed"])
        self.assertEqual(traversed_count, result["steps"] + 1)

        # 2回目: 踏破済みマスだけを戻る journey では抽選されず、
        # 抽選値がアンブッシュ圏（0.0）でも戦闘は起きない
        rolls.clear()
        with patch.object(dangeon.random, "random", side_effect=lambda: rolls.append(1) or 0.0):
            result = _journey(uid, "left")
        self.assertEqual(rolls, [])
        self.assertIsNone(result["enemy"])
        self.assertNotEqual(result["stop_reason"], "ambush")


class TestVisitedFog(DungeonRoomTestCase):
    def test_e_encode_decode_roundtrip(self):
        cells = {(0, 0), (28, 28), (0, 28), (28, 0), (14, 14), (3, 25)}
        encoded = dangeon.d_encode_visited(cells)
        self.assertIsInstance(encoded, str)
        self.assertEqual(dangeon.d_decode_visited(encoded), cells)
        self.assertEqual(dangeon.d_decode_visited(dangeon.d_encode_visited(set())), set())
        self.assertEqual(dangeon.d_decode_visited(None), set())
        self.assertEqual(dangeon.d_decode_visited("!!not-base64!!"), set())

    def test_e_start_room_revealed_and_room_reveal_on_entry(self):
        uid = "r-e"
        # 実生成インスタンス: 開始時点でスタート部屋が公開済み
        inst = dangeon.d_get_instance(uid, 1)
        start_room = next(r for r in inst["rooms"] if r["role"] == "start")
        rx, ry, rw, rh = start_room["rect"]
        for gy in range(ry, ry + rh):
            for gx in range(rx, rx + rw):
                self.assertIn((gx, gy), inst["visited"])

        # 手作りマップで入室時の公開範囲を確認する
        _, _, room_b, inst2, _ = _two_room_map("r-e2", "combat")
        with patch.object(dangeon.random, "random", return_value=0.99):
            _journey("r-e2", "right")
        rx, ry, rw, rh = room_b["rect"]
        for gy in range(ry, ry + rh):
            for gx in range(rx, rx + rw):
                self.assertIn((gx, gy), inst2["visited"])
        # 部屋に接続する通路の次マス（部屋の入口の外側）も公開される
        self.assertIn((9, 4), inst2["visited"])
        # 遠く離れた未探索セルは公開されない
        self.assertNotIn((25, 25), inst2["visited"])

    def test_e_instance_diff_roundtrip_restores_visited_and_cleared(self):
        uid = "r-e3"
        p = dangeon.d_get_player(uid)
        p["phase1b_v2"] = True
        inst = dangeon.d_get_instance(uid, 2)
        room = inst["rooms"][1]
        dangeon.d_mark_room_cleared(inst, room["id"])
        dangeon.d_reveal_room(inst, room)
        expected_visited = set(inst["visited"])
        expected_cleared = set(inst["cleared"])

        p["instances"] = dangeon.d_instances_snapshot(uid)
        self.assertIn("visited", p["instances"]["2"])
        self.assertIn("cleared", p["instances"]["2"])
        dangeon.dg_instances.clear()
        restored = dangeon.d_get_instance(uid, 2)
        self.assertEqual(restored["visited"], expected_visited)
        self.assertEqual(restored["cleared"], expected_cleared)

    def test_e_progress_text_and_destination_label(self):
        uid = "r-e4"
        _, _, room_b, inst, _ = _two_room_map(uid, "stairs", guarded=True, boss=False)
        text = dangeon.d_floor_progress_text(uid)
        # 手作り注入のインスタンスは visited が空なので発見 0/2 から始まる
        self.assertIn("部屋 0/2", text)
        self.assertIn("階段: 未発見", text)
        self.assertIn("番人: 未制圧", text)
        # 発見済みにすると進捗が変わる
        dangeon.d_reveal_room(inst, room_b)
        text = dangeon.d_floor_progress_text(uid)
        self.assertIn("階段: 発見済み", text)
        dangeon.d_mark_room_cleared(inst, room_b["id"])
        text = dangeon.d_floor_progress_text(uid)
        self.assertIn("番人: 制圧済み", text)
        self.assertIn("上の階へ進む", text)


class TestDoorStop(DungeonRoomTestCase):
    def test_plan_walk_stops_at_offset_door(self):
        # 部屋の東壁の、中心線からずれた位置に出口がある手作りマップ。
        # 修正前はドアマスを素通りして room_edge まで行ってしまっていた。
        grid = _blank_grid()
        rooms = []
        _carve_room(grid, rooms, 0, "start", 2, 2, 5, 5)
        _carve_cells(grid, [(7, 3), (8, 3), (9, 3)])  # (6,3) の東が出口
        _inject("r-door", grid, rooms, start=(4, 4))

        plan = dangeon.d_plan_walk("r-door", 1, 6, 4, "up")  # (6,4) から北上
        self.assertEqual(plan["stop_reason"], "door")
        self.assertEqual(plan["stop_cell"], (6, 3))

        # ドアで止まったあとは、東へ進めば部屋の外（通路）へ出られる
        plan = dangeon.d_plan_walk("r-door", 1, 6, 3, "right")
        self.assertEqual(plan["path"][0], (7, 3))


class TestWalkerReachability(DungeonRoomTestCase):
    """回帰防止の要: 生成インスタンスの全部屋にウォーカーで到達できること。

    停止点グラフ（各停止点から4方向へ d_plan_walk した到達先の集合）を
    スタートマスから辿り、全ての部屋の rect 内の停止点が存在することを
    検証する。中心同士を結ぶ通路ではドアが中心線からずれるため、ドア
    停止が無いと多数の部屋（実測 41.4%）が到達不能になっていた。
    """

    def _reached_room_ids(self, uid, floor):
        inst = dangeon.d_get_instance(uid, floor)
        seen = {inst["start"]}
        frontier = [inst["start"]]
        while frontier:
            nxt = []
            for x, y in frontier:
                for direction in ("up", "down", "left", "right"):
                    plan = dangeon.d_plan_walk(uid, floor, x, y, direction)
                    if plan["path"] and plan["stop_cell"] not in seen:
                        seen.add(plan["stop_cell"])
                        nxt.append(plan["stop_cell"])
            frontier = nxt
        reached = set()
        for x, y in seen:
            room = dangeon.d_room_at(inst, x, y)
            if room is not None:
                reached.add(room["id"])
        return inst, reached

    def test_all_rooms_reachable_by_walker(self):
        checked_rooms = 0
        for i in range(6):
            uid = f"reach-{i}"
            for floor in range(1, 6):
                inst, reached = self._reached_room_ids(uid, floor)
                all_ids = {r["id"] for r in inst["rooms"]}
                checked_rooms += len(all_ids)
                self.assertEqual(
                    reached, all_ids,
                    f"{uid} floor={floor}: 到達不能な部屋 {sorted(all_ids - reached)}")
        self.assertGreater(checked_rooms, 100)


if __name__ == "__main__":
    unittest.main()
