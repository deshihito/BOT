"""ダンジョン Phase 1 の新フロアジェネレータ（v2）の単体テスト。

対象は cogs/dangeon.py の d_gen_floor_v2 / d_floor_seed（設計書
dungeon-phase1-design.md §3）。ゲーム本体には未接続の並行導入コードであり、
ここでは生成結果の性質だけを検証する:
  - 決定性（同一 seed → 同一 grid/rooms、異 seed では高確率で異なる）
  - 連結性（start から全ての部屋 center と stairs へ到達可能）
  - 構成保証（部屋数・役割内訳・特殊タイルの配置・29x29）
  - 5フロア毎に stairs 部屋へ boss フラグが立つこと

依存スタブの方式は tests/test_dungeon_logic.py と同一。
"""

"""ダンジョン純粋ロジックの単体テスト（Phase 0 で新設）。

対象は cogs/dangeon.py のうち Discord 対話を伴わないロジック:
  - マップ生成の連結性（スタートから階段へ到達可能）
  - 報酬の二重受取防止（d_choose_reward）
  - 鍛冶強化が他プレイヤーと共有マスタへ影響しないこと
  - 敵生成の基本スケーリング
  - 状態異常のライフサイクル（進行と全解除）
  - 報酬3択のラベル量表示

実行環境に discord / Pillow / aiohttp / requests が無い場合は、
import 前に最小スタブを sys.modules へ投入して読み込めるようにする
（実環境では実モジュールが使われ、スタブは一切効かない）。
"""

import copy
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _passthrough_decorator_factory(*d_args, **d_kwargs):
    def decorator(func):
        return func

    return decorator


class _LoopStub:
    """discord.ext.tasks.loop の最小スタブ。"""

    def __init__(self, func):
        self._func = func

    def __call__(self, *args, **kwargs):
        return self._func(*args, **kwargs)

    def before_loop(self, func):
        return func

    def after_loop(self, func):
        return func

    def start(self, *args, **kwargs):
        return None

    def cancel(self):
        return None

    def is_running(self):
        return False


def _install_dependency_stubs():
    """不足している外部モジュールだけ最小スタブを登録する。"""
    missing = []
    for name in ("discord", "PIL", "aiohttp", "requests"):
        try:
            __import__(name)
        except ImportError:
            missing.append(name)
    if not missing:
        return

    if "discord" in missing:
        discord = types.ModuleType("discord")

        class _Embed:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.fields = []

            def add_field(self, **kwargs):
                self.fields.append(kwargs)
                return self

            def set_image(self, **kwargs):
                return self

            def set_footer(self, **kwargs):
                return self

        class _File:
            def __init__(self, fp=None, filename=None, **kwargs):
                self.fp = fp
                self.filename = filename

        class _ButtonStyle:
            primary = "primary"
            secondary = "secondary"
            success = "success"
            danger = "danger"
            link = "link"
            grey = "grey"
            gray = "gray"
            green = "green"
            red = "red"
            blurple = "blurple"

        class _SelectOption:
            def __init__(self, label=None, value=None, **kwargs):
                self.label = label
                self.value = value

        class _Interaction:
            pass

        class _Color:
            @staticmethod
            def from_rgb(*args):
                return None

        class _AllowedMentions:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            @staticmethod
            def none():
                return None

            @staticmethod
            def all():
                return None

        class _TextStyle:
            short = "short"
            long = "long"
            paragraph = "paragraph"

        class _TextChannel:
            pass

        discord.Embed = _Embed
        discord.File = _File
        discord.ButtonStyle = _ButtonStyle
        discord.SelectOption = _SelectOption
        discord.Interaction = _Interaction
        discord.Color = _Color
        discord.AllowedMentions = _AllowedMentions
        discord.TextStyle = _TextStyle
        discord.TextChannel = _TextChannel

        # discord.ui
        ui = types.ModuleType("discord.ui")

        class _View:
            def __init__(self, *args, **kwargs):
                self.children = []
                self.timeout = kwargs.get("timeout")

            def add_item(self, item):
                self.children.append(item)
                return self

            def clear_items(self):
                self.children = []

            def stop(self):
                return None

        class _Button:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.label = kwargs.get("label")
                self.callback = None

        class _Select:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.callback = None

        class _Modal:
            def __init_subclass__(cls, **kwargs):
                super().__init_subclass__()

            def __init__(self, *args, **kwargs):
                self.kwargs = kwargs

            def add_item(self, item):
                return self

        class _TextInput:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        ui.View = _View
        ui.Button = _Button
        ui.Select = _Select
        ui.Modal = _Modal
        ui.TextInput = _TextInput
        ui.button = _passthrough_decorator_factory
        ui.select = _passthrough_decorator_factory
        discord.ui = ui

        # discord.app_commands
        app_commands = types.ModuleType("discord.app_commands")
        app_commands.command = _passthrough_decorator_factory
        app_commands.describe = _passthrough_decorator_factory
        app_commands.choices = _passthrough_decorator_factory

        class _Choice:
            def __init__(self, name=None, value=None):
                self.name = name
                self.value = value

        app_commands.Choice = _Choice
        discord.app_commands = app_commands

        # discord.ext / commands / tasks
        ext = types.ModuleType("discord.ext")
        commands = types.ModuleType("discord.ext.commands")

        class _Cog:
            def __init__(self, *args, **kwargs):
                pass

        class _Context:
            pass

        class _Bot:
            pass

        commands.Cog = _Cog
        commands.Context = _Context
        commands.Bot = _Bot
        commands.command = _passthrough_decorator_factory
        commands.group = _passthrough_decorator_factory
        commands.hybrid_command = _passthrough_decorator_factory

        tasks = types.ModuleType("discord.ext.tasks")

        def _loop(*d_args, **d_kwargs):
            def decorator(func):
                return _LoopStub(func)

            return decorator

        tasks.loop = _loop
        ext.commands = commands
        ext.tasks = tasks
        discord.ext = ext

        sys.modules["discord"] = discord
        sys.modules["discord.ui"] = ui
        sys.modules["discord.app_commands"] = app_commands
        sys.modules["discord.ext"] = ext
        sys.modules["discord.ext.commands"] = commands
        sys.modules["discord.ext.tasks"] = tasks

    if "PIL" in missing:
        pil = types.ModuleType("PIL")
        image = types.ModuleType("PIL.Image")

        class _Resampling:
            NEAREST = 0
            LANCZOS = 1

        image.Resampling = _Resampling
        image.open = lambda *a, **k: None
        image.new = lambda *a, **k: None
        imagedraw = types.ModuleType("PIL.ImageDraw")
        imagedraw.Draw = lambda img: None
        pil.Image = image
        pil.ImageDraw = imagedraw
        sys.modules["PIL"] = pil
        sys.modules["PIL.Image"] = image
        sys.modules["PIL.ImageDraw"] = imagedraw

    if "aiohttp" in missing:
        aiohttp = types.ModuleType("aiohttp")

        class _ClientError(Exception):
            pass

        class _ClientTimeout:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        aiohttp.ClientError = _ClientError
        aiohttp.ClientTimeout = _ClientTimeout
        aiohttp.ClientSession = object
        aiohttp.FormData = object
        sys.modules["aiohttp"] = aiohttp

    if "requests" in missing:
        requests = types.ModuleType("requests")

        class _RequestException(Exception):
            pass

        requests.exceptions = types.SimpleNamespace(RequestException=_RequestException)
        requests.post = lambda *a, **k: None
        requests.get = lambda *a, **k: None
        requests.request = lambda *a, **k: None
        sys.modules["requests"] = requests


_install_dependency_stubs()

from cogs import dangeon  # noqa: E402


FLOORS = (1, 3, 5, 10, 40)
SEEDS = range(200)


class DungeonFloorV2TestCase(unittest.TestCase):
    def _reachable(self, grid, start):
        seen = {start}
        queue = [start]
        while queue:
            x, y = queue.pop()
            for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nx, ny = x + dx, y + dy
                if (
                    0 <= nx < dangeon.D2_MAP_W
                    and 0 <= ny < dangeon.D2_MAP_H
                    and (nx, ny) not in seen
                    and grid[ny][nx] != dangeon.D_WALL
                ):
                    seen.add((nx, ny))
                    queue.append((nx, ny))
        return seen

    # (a) 決定性 -----------------------------------------------------------

    def test_same_seed_same_result(self):
        for seed in (0, 1, 42, 123456):
            grid1, rooms1 = dangeon.d_gen_floor_v2(seed, 3)
            grid2, rooms2 = dangeon.d_gen_floor_v2(seed, 3)
            self.assertEqual(grid1, grid2)
            self.assertEqual(rooms1, rooms2)

    def test_different_seeds_usually_differ(self):
        grids = set()
        for seed in range(20):
            grid, _ = dangeon.d_gen_floor_v2(seed, 1)
            grids.add(tuple(tuple(row) for row in grid))
        self.assertGreaterEqual(len(grids), 18)

    def test_global_random_state_is_not_used(self):
        import random

        random.seed(20261104)
        grid1, rooms1 = dangeon.d_gen_floor_v2(7, 2)
        random.seed(1)
        for _ in range(50):
            random.random()
        grid2, rooms2 = dangeon.d_gen_floor_v2(7, 2)
        self.assertEqual(grid1, grid2)
        self.assertEqual(rooms1, rooms2)

    def test_floor_seed_helper(self):
        seed = dangeon.d_floor_seed("season-2026-11", "12345", 3)
        self.assertIsInstance(seed, int)
        self.assertEqual(seed, dangeon.d_floor_seed("season-2026-11", "12345", 3))
        self.assertNotEqual(seed, dangeon.d_floor_seed("season-2026-11", "12345", 4))
        self.assertNotEqual(seed, dangeon.d_floor_seed("season-2026-11", "99999", 3))
        grid1, _ = dangeon.d_gen_floor_v2(seed, 3)
        grid2, _ = dangeon.d_gen_floor_v2(
            dangeon.d_floor_seed("season-2026-11", "12345", 3), 3
        )
        self.assertEqual(grid1, grid2)

    # (b) 連結性 -----------------------------------------------------------

    def test_start_reaches_all_room_centers_and_stairs(self):
        for seed in SEEDS:
            for floor in FLOORS:
                with self.subTest(seed=seed, floor=floor):
                    grid, rooms = dangeon.d_gen_floor_v2(seed, floor)
                    start = next(r for r in rooms if r["role"] == "start")
                    reachable = self._reachable(grid, start["center"])
                    for room in rooms:
                        self.assertIn(
                            room["center"], reachable,
                            f"部屋 {room['id']} ({room['role']}) へ到達できること",
                        )
                    stairs_cells = [
                        (x, y)
                        for y, row in enumerate(grid)
                        for x, cell in enumerate(row)
                        if cell == dangeon.D_STAIRS
                    ]
                    self.assertEqual(len(stairs_cells), 1)
                    self.assertIn(stairs_cells[0], reachable)

    # (c) 構成保証 -----------------------------------------------------------

    def test_grid_size_and_room_composition(self):
        main_expected = ["start", "combat", "event", None, "stairs"]  # 4番目は combat/chest
        for seed in SEEDS:
            for floor in (1, 7):
                with self.subTest(seed=seed, floor=floor):
                    grid, rooms = dangeon.d_gen_floor_v2(seed, floor)
                    self.assertEqual(len(grid), dangeon.D2_MAP_H)
                    self.assertTrue(all(len(row) == dangeon.D2_MAP_W for row in grid))
                    self.assertEqual((dangeon.D2_MAP_W, dangeon.D2_MAP_H), (29, 29))

                    self.assertTrue(6 <= len(rooms) <= 7)
                    main = [r for r in rooms if r["route"] == "main"]
                    sub = [r for r in rooms if r["route"] == "sub"]
                    self.assertEqual(len(main), 5)
                    self.assertTrue(1 <= len(sub) <= 2)

                    for room, expected in zip(main, main_expected):
                        if expected is not None:
                            self.assertEqual(room["role"], expected)
                    self.assertIn(main[3]["role"], ("combat", "chest"))
                    sub_roles = [r["role"] for r in sub]
                    self.assertEqual(len(sub_roles), len(set(sub_roles)))
                    for role in sub_roles:
                        self.assertIn(role, dangeon.D2_SUB_ROLES)

                    # セクターは全て相異なり、部屋はセクター内に収まる。
                    sectors = [r["sector"] for r in rooms]
                    self.assertEqual(len(sectors), len(set(sectors)))
                    for room in rooms:
                        x, y, w, h = room["rect"]
                        self.assertTrue(5 <= w <= 7 and 5 <= h <= 7)
                        self.assertEqual(room["center"], (x + w // 2, y + h // 2))
                        sx, sy = room["sector"]
                        self.assertTrue(1 + sx * 9 <= x and x + w <= 1 + sx * 9 + 9)
                        self.assertTrue(1 + sy * 9 <= y and y + h <= 1 + sy * 9 + 9)

    def test_special_tiles_placement(self):
        role_tiles = {
            "start": dangeon.D_START,
            "stairs": dangeon.D_STAIRS,
            "chest": dangeon.D_CHEST,
            "shop": dangeon.D_SHOP,
            "mine": dangeon.D_MINE,
            "rest": dangeon.D_REST,
            "event": dangeon.D_EVENT,
        }
        for seed in SEEDS:
            for floor in (1, 7):
                with self.subTest(seed=seed, floor=floor):
                    grid, rooms = dangeon.d_gen_floor_v2(seed, floor)
                    for room in rooms:
                        cx, cy = room["center"]
                        self.assertNotEqual(grid[cy][cx], dangeon.D_WALL)
                        expected = role_tiles.get(room["role"])
                        if expected is not None:
                            self.assertEqual(grid[cy][cx], expected)
                    # 特殊タイルは必ず部屋の中（＝壁でない場所）にだけ存在する。
                    room_cells = set()
                    for room in rooms:
                        x, y, w, h = room["rect"]
                        for gy in range(y, y + h):
                            for gx in range(x, x + w):
                                room_cells.add((gx, gy))
                    specials = set(role_tiles.values())
                    for y, row in enumerate(grid):
                        for x, cell in enumerate(row):
                            if cell in specials:
                                self.assertIn((x, y), room_cells)
                            if cell == dangeon.D_TRAP:
                                self.assertNotIn((x, y), room_cells)
                    trap_count = sum(
                        cell == dangeon.D_TRAP for row in grid for cell in row
                    )
                    self.assertTrue(0 <= trap_count <= 2)

    # (d) 5フロア毎のボス -----------------------------------------------------

    def test_stairs_room_guarded_and_boss_every_5_floors(self):
        for seed in (0, 3, 17, 99):
            for floor in range(1, 21):
                with self.subTest(seed=seed, floor=floor):
                    _, rooms = dangeon.d_gen_floor_v2(seed, floor)
                    stairs = next(r for r in rooms if r["role"] == "stairs")
                    self.assertTrue(stairs["guarded"])
                    self.assertEqual(stairs["boss"], floor % 5 == 0)


if __name__ == "__main__":
    unittest.main()
