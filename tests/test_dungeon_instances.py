"""ダンジョン Phase 1-B（個人インスタンス基盤）の単体テスト。

対象は cogs/dangeon.py の Phase 1-B で導入した部分（設計書
dungeon-phase1-design.md §7）:
  - (a) インスタンスの独立性: 2人のユーザーのマップは seed により異なり、
        片方の d_consume が他方へ影響しない
  - (b) 復元: 保存した差分（consumed）から、生成→再適用で同じ状態に戻る。
        dg_save_player → dg_load_all の往復でも保たれる
  - (c) 移行: フラグ無しプレイヤーへ一度だけリセットが掛かり、
        保持対象（レベル/XP・装備・遺物・実績・クエスト・強化）は残る

依存スタブの方式は tests/test_dungeon_logic.py と同一（その installer を再利用する）。
"""

import asyncio
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from tests.test_dungeon_logic import _install_dependency_stubs
except Exception:  # tests をパッケージとして解決できない実行形態向け
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_dungeon_logic import _install_dependency_stubs

_install_dependency_stubs()

from cogs import dangeon  # noqa: E402


class _FakeQuery:
    """dg_save_player / dg_load_all が使う最小限のクエリスタブ。"""

    def __init__(self, store, table):
        self._store = store
        self._table = table

    def select(self, *args, **kwargs):
        return self

    def upsert(self, payload, on_conflict=None):
        self._store[self._table] = [payload]
        return self

    def execute(self):
        return types.SimpleNamespace(data=list(self._store.get(self._table, [])))


class _FakeDB:
    def __init__(self, store):
        self._store = store

    def table(self, name):
        return _FakeQuery(self._store, name)


def _find_cell(grid, *cells):
    for y, row in enumerate(grid):
        for x, cell in enumerate(row):
            if cell in cells:
                return (x, y)
    return None


class DungeonInstanceTestCase(unittest.TestCase):
    def setUp(self):
        dangeon.dg_players.clear()
        dangeon.dg_instances.clear()
        dangeon._PLAYER_SAVE_DIGESTS.clear()

    def _make_player(self, uid, **overrides):
        p = dangeon.d_default_player()
        p.update(overrides)
        dangeon.dg_players[str(uid)] = p
        return p

    # (a) インスタンスの独立性 -------------------------------------------

    def test_instances_are_independent_per_user(self):
        self._make_player("1001", phase1b_v2=True)
        self._make_player("1002", phase1b_v2=True)
        inst_a = dangeon.d_get_instance("1001", 1)
        inst_b = dangeon.d_get_instance("1002", 1)

        # seed はユーザー毎に異なり、生成されるマップも異なる
        self.assertNotEqual(inst_a["seed"], inst_b["seed"])
        self.assertNotEqual(inst_a["grid"], inst_b["grid"])
        self.assertEqual(len(inst_a["grid"]), dangeon.D2_MAP_H)
        self.assertTrue(all(len(row) == dangeon.D2_MAP_W for row in inst_a["grid"]))

        # 片方の消費が他方へ影響しない
        target = _find_cell(inst_a["grid"], dangeon.D_CHEST)
        self.assertIsNotNone(target, "宝箱タイルが配置されていること")
        before_b = dangeon.d_get_cell("1002", 1, *target)
        dangeon.d_consume("1001", 1, *target)
        self.assertEqual(dangeon.d_get_cell("1001", 1, *target), dangeon.D_FLOOR)
        self.assertEqual(dangeon.d_get_cell("1002", 1, *target), before_b)
        self.assertEqual(inst_b["consumed"], set())

    # (b) 差分からの復元 ---------------------------------------------------

    def test_instance_restores_from_saved_diff(self):
        uid = "2001"
        p = self._make_player(uid, phase1b_v2=True)
        inst = dangeon.d_get_instance(uid, 3)
        specials = [
            (x, y)
            for y, row in enumerate(inst["grid"])
            for x, cell in enumerate(row)
            if cell in (dangeon.D_CHEST, dangeon.D_TRAP, dangeon.D_EVENT)
        ]
        self.assertTrue(specials)
        for pos in specials[:2]:
            dangeon.d_consume(uid, 3, *pos)
        expected_grid = [row[:] for row in inst["grid"]]
        expected_consumed = set(inst["consumed"])

        # 保存形式へ変換し、キャッシュを捨てて再構築する（再起動相当）
        p["instances"] = dangeon.d_instances_snapshot(uid)
        self.assertIn("3", p["instances"])
        dangeon.dg_instances.clear()
        restored = dangeon.d_get_instance(uid, 3)
        self.assertEqual(restored["grid"], expected_grid)
        self.assertEqual(restored["consumed"], expected_consumed)
        self.assertEqual(restored["start"], inst["start"])
        self.assertEqual(restored["seed"], inst["seed"])

    def test_save_load_roundtrip_restores_instance(self):
        uid = "4001"
        store = {}
        db = _FakeDB(store)
        self._make_player(uid, phase1b_v2=True)
        inst = dangeon.d_get_instance(uid, 1)
        chest = _find_cell(inst["grid"], dangeon.D_CHEST)
        self.assertIsNotNone(chest)
        dangeon.d_consume(uid, 1, *chest)

        asyncio.run(dangeon.dg_save_player(uid, db))
        saved_row = store["dungeon_players"][0]
        meta = saved_row["inventory"]["_dungeon_meta"]
        self.assertIn("1", meta["instances"])
        self.assertIn(list(chest), meta["instances"]["1"]["consumed"])
        self.assertTrue(meta["phase1b_v2"])

        # 再起動相当: 状態を捨てて DB から読み直す
        dangeon.dg_players.clear()
        dangeon.dg_instances.clear()
        asyncio.run(dangeon.dg_load_all(db))
        self.assertIn(uid, dangeon.dg_players)
        self.assertEqual(dangeon.d_get_cell(uid, 1, *chest), dangeon.D_FLOOR)

    # (c) 移行処理 ---------------------------------------------------------

    def test_migration_applies_once_and_preserves_progress(self):
        uid = "3001"
        p = self._make_player(
            uid, floor=7, x=50, y=60, hp=3, turns=123, season_score=999,
            xp=450, level=4,
            relics=["lucky_coin"], achievements=["first_step"],
            equipment={"weapon": "iron_sword"},
            equipment_upgrades={"iron_sword": 2},
        )
        p["quests"]["monster_hunter"]["progress"] = 3
        self.assertFalse(p["phase1b_v2"])

        self.assertTrue(dangeon.d_migrate_player_v2(uid))
        self.assertTrue(p["phase1b_v2"])
        self.assertEqual(p["floor"], 1)
        self.assertEqual((p["x"], p["y"]), dangeon.d_instance_start(uid, 1))
        self.assertEqual(p["hp"], dangeon.d_effective_stats(p)["max_hp"])
        self.assertEqual(p["turns"], 0)
        self.assertEqual(p["season_score"], 0)

        # 保持対象はそのまま残る
        self.assertEqual(p["xp"], 450)
        self.assertEqual(p["level"], 4)
        self.assertEqual(p["relics"], ["lucky_coin"])
        self.assertEqual(p["achievements"], ["first_step"])
        self.assertEqual(p["equipment"], {"weapon": "iron_sword"})
        self.assertEqual(p["equipment_upgrades"], {"iron_sword": 2})
        self.assertEqual(p["quests"]["monster_hunter"]["progress"], 3)

        # 二度目は掛からない
        p["floor"] = 5
        p["turns"] = 42
        self.assertFalse(dangeon.d_migrate_player_v2(uid))
        self.assertEqual(p["floor"], 5)
        self.assertEqual(p["turns"], 42)

    def test_load_all_migrates_legacy_player(self):
        uid = "5001"
        legacy_meta = {
            "relics": ["lucky_coin"],
            "quests": {key: {"progress": 0, "completed": False} for key in dangeon.QUEST_MASTER},
        }
        row = {
            "user_id": uid, "floor": 9, "x": 80, "y": 90, "hp": 5,
            "max_hp": 100, "atk": 10, "def_": 3, "spd": 10, "crit": 0.05,
            "xp": 120, "level": 2, "boxes": 1, "bread": 2, "chips": 0,
            "job": "warrior", "equipment": {}, "achievements": [],
            "season_id": dangeon.SEASON_ID, "season_score": 777, "turns": 55,
            "cooldowns": {},
            "inventory": {"_dungeon_meta": legacy_meta},
        }
        db = _FakeDB({"dungeon_players": [row]})
        asyncio.run(dangeon.dg_load_all(db))

        p = dangeon.dg_players[uid]
        self.assertTrue(p["phase1b_v2"])
        self.assertEqual(p["floor"], 1)
        self.assertEqual((p["x"], p["y"]), dangeon.d_instance_start(uid, 1))
        self.assertEqual(p["turns"], 0)
        self.assertEqual(p["season_score"], 0)
        self.assertEqual(p["xp"], 120)
        self.assertEqual(p["level"], 2)
        self.assertEqual(p["relics"], ["lucky_coin"])


if __name__ == "__main__":
    unittest.main()
