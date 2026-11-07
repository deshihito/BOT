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
from unittest.mock import patch

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

import core.game.dungeon.entry as dangeon


class DungeonLogicTestCase(unittest.TestCase):
    def setUp(self):
        dangeon.dg_players.clear()
        dangeon.dg_maps.clear()
        dangeon.dg_starts.clear()
        dangeon.dg_used.clear()
        dangeon.dg_bases.clear()

    # (a) マップ生成の連結性 ---------------------------------------------

    def _reachable(self, grid, start):
        seen = {start}
        queue = [start]
        while queue:
            x, y = queue.pop()
            for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nx, ny = x + dx, y + dy
                if (
                    0 <= nx < dangeon.D_MAP_W
                    and 0 <= ny < dangeon.D_MAP_H
                    and (nx, ny) not in seen
                    and grid[ny][nx] != dangeon.D_WALL
                ):
                    seen.add((nx, ny))
                    queue.append((nx, ny))
        return seen

    def test_gen_floor_start_reaches_stairs(self):
        for floor in (1, 15, 40):
            with self.subTest(floor=floor):
                grid = dangeon.d_gen_floor(floor)
                start = dangeon.dg_starts[floor]
                stairs = [
                    (x, y)
                    for y, row in enumerate(grid)
                    for x, cell in enumerate(row)
                    if cell == dangeon.D_STAIRS
                ]
                self.assertTrue(stairs, "階段が配置されていること")
                reachable = self._reachable(grid, start)
                self.assertTrue(
                    any(pos in reachable for pos in stairs),
                    "スタートから階段へ到達できること",
                )

    # (b) 報酬の二重受取防止 ----------------------------------------------

    def test_choose_reward_consumes_pending(self):
        uid = "test-choose"
        player = dangeon.d_get_player(uid)
        player["pending_rewards"] = [{"coins": 10}, {"xp": 5}]
        self.assertEqual(dangeon.d_choose_reward(uid, 0), {"coins": 10})
        self.assertEqual(player["pending_rewards"], [])
        self.assertIsNone(dangeon.d_choose_reward(uid, 0))
        self.assertIsNone(dangeon.d_choose_reward(uid, 5))

    # (c) 鍛冶強化の隔離 ----------------------------------------------------

    def test_upgrade_equipment_is_per_player(self):
        master_before = copy.deepcopy(dangeon.EQUIPMENT_MASTER)
        uid_a, uid_b = "test-forge-a", "test-forge-b"
        for uid in (uid_a, uid_b):
            player = dangeon.d_get_player(uid)
            player["equipment"] = {"weapon": "iron_sword"}
            player["inventory"] = {"iron_sword": 1}
        player_a = dangeon.d_get_player(uid_a)
        player_b = dangeon.d_get_player(uid_b)
        player_a["materials"] = {"iron_ore": 2}

        stats_a_before = dangeon.d_effective_stats(player_a)
        stats_b_before = dangeon.d_effective_stats(player_b)

        self.assertTrue(dangeon.d_upgrade_equipment(uid_a, "iron_sword"))
        self.assertTrue(dangeon.d_upgrade_equipment(uid_a, "iron_sword"))
        self.assertEqual(player_a["equipment_upgrades"], {"iron_sword": 2})
        self.assertEqual(player_a["materials"]["iron_ore"], 0)

        stats_a_after = dangeon.d_effective_stats(player_a)
        stats_b_after = dangeon.d_effective_stats(player_b)
        self.assertEqual(stats_a_after["atk"], stats_a_before["atk"] + 2)
        self.assertEqual(stats_a_after["def_"], stats_a_before["def_"] + 2)
        self.assertEqual(stats_b_after, stats_b_before)

        # 共有マスタは一切変わらず、強化レベルも混入しない。
        self.assertEqual(dangeon.EQUIPMENT_MASTER, master_before)
        self.assertNotIn("upgrade_level", dangeon.EQUIPMENT_MASTER["iron_sword"])

        # 素材が無いプレイヤーは強化できない。
        self.assertFalse(dangeon.d_upgrade_equipment(uid_b, "iron_sword"))

    # (d) 敵生成の基本スケーリング ------------------------------------------

    def test_make_enemy_scaling(self):
        for floor in (1, 10):
            enemy = dangeon.d_make_enemy(floor, forced_name="ゴブリン")
            self.assertEqual(enemy["name"], "ゴブリン")
            self.assertEqual(enemy["type"], "normal")
            self.assertEqual(enemy["hp"], enemy["max_hp"])
            self.assertGreater(enemy["hp"], 0)
            self.assertGreater(enemy["atk"], 0)
            self.assertGreaterEqual(enemy["reward_coins"], 0)
            self.assertGreaterEqual(enemy["reward_xp"], 0)
        low = dangeon.d_make_enemy(1, forced_name="ゴブリン")
        high = dangeon.d_make_enemy(10, forced_name="ゴブリン")
        # 基礎HPは 15 + floor*8（±3）なので、10F は 1F より明確に大きい。
        self.assertGreater(high["max_hp"], low["max_hp"] + 50)
        self.assertGreater(high["atk"], low["atk"])

    def test_elite_rank_multipliers_weakened(self):
        """精鋭の倍率が HP 3.0 / ATK 2.0 / DEF 1.25 であること（弱体化の回帰）。

        乱数を固定（randint は 0、choice は先頭）して正確値で検証する。
        ボスの倍率（15.0 / 4.0 / 2.0）が変わっていないことも併せて確認する。
        """
        floor = 5
        base_hp, base_atk, base_def = 15 + floor * 8, 4 + floor * 2, 1 + floor

        def master_of(enemy):
            clean_key = enemy["name"].split()[0].replace("👾", "").strip()
            return dangeon.ENEMY_STATS_MASTER.get(
                clean_key, dangeon.ENEMY_STATS_MASTER["default"])

        with patch.object(dangeon.random, "randint", lambda a, b: 0), \
                patch.object(dangeon.random, "choice", lambda seq: seq[0]):
            elite = dangeon.d_make_enemy(floor, forced_rank="elite")
            boss = dangeon.d_make_enemy(floor, forced_rank="boss")

        self.assertEqual(elite["type"], "elite")
        m = master_of(elite)
        self.assertEqual(elite["hp"], int(base_hp * m["hp_m"] * 3.0))
        self.assertEqual(elite["atk"], int(base_atk * m.get("atk_m", 1.0) * 2.0))
        self.assertEqual(elite["def_"], int(base_def * m.get("def_m", 1.0) * 1.25))
        # 精鋭の報酬枠（宝箱は最低1）は変更しない。
        self.assertGreaterEqual(elite["reward_box"], 1)

        self.assertEqual(boss["type"], "boss")
        mb = master_of(boss)
        self.assertEqual(boss["hp"], int(base_hp * mb["hp_m"] * 15.0))
        self.assertEqual(boss["atk"], int(base_atk * mb.get("atk_m", 1.0) * 4.0))
        self.assertEqual(boss["def_"], int(base_def * mb.get("def_m", 1.0) * 2.0))

    # 状態異常のライフサイクル ------------------------------------------------

    def test_status_lifecycle_tick_and_clear(self):
        uid = "test-status"
        player = dangeon.d_get_player(uid)
        hp_before = player["hp"]
        dangeon.d_apply_status(uid, "poison", turns=2)
        self.assertEqual(len(player["active_effects"]), 1)

        logs = dangeon.d_tick_status(uid)
        self.assertTrue(any("毒" in line for line in logs))
        self.assertLess(player["hp"], hp_before)
        self.assertEqual(player["active_effects"][0]["turns"], 1)

        dangeon.d_tick_status(uid)
        self.assertEqual(player["active_effects"], [])

        dangeon.d_apply_status(uid, "burn", turns=3)
        player["battle_flags"]["cursed"] = True
        dangeon.d_clear_status(uid)
        self.assertEqual(player["active_effects"], [])
        self.assertEqual(player["battle_flags"], {})

    # 報酬ラベルの量表示 -------------------------------------------------------

    def test_reward_choice_labels_include_amounts(self):
        uid = "test-labels"
        dangeon.d_get_player(uid)
        enemy = {"reward_coins": 250, "reward_xp": 120, "reward_box": 2}
        choices = dangeon.d_make_reward_choices(uid, enemy)
        labels = [choice["label"] for choice in choices]
        self.assertEqual(labels, ["コイン +250", "経験値 +120", "宝箱 ×2"])
        self.assertEqual(choices[0]["reward"], {"coins": 250})
        self.assertEqual(choices[1]["reward"], {"xp": 120})
        self.assertEqual(choices[2]["reward"], {"boxes": 2})

    # 報酬Viewのコールバック束縛（表示バグ回帰防止） ------------------------------

    def test_reward_view_callbacks_bind_their_own_label(self):
        uid = "test-view"
        dangeon.d_get_player(uid)
        enemy = {"reward_coins": 250, "reward_xp": 120, "reward_box": 2}
        choices = dangeon.d_make_reward_choices(uid, enemy)
        view = dangeon.DungeonRewardChoiceView(uid, 1, 0, 0, None, choices)
        self.assertEqual(len(view.children), 3)
        for index, choice in enumerate(choices):
            callback = view.children[index].callback
            defaults = callback.__defaults__ or ()
            self.assertIn(index, defaults)
            self.assertIn(choice["label"], defaults)


if __name__ == "__main__":
    unittest.main()
