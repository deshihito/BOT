# -*- coding: utf-8 -*-
"""植物栽培（core/general/garden）のテスト。

- 成長計算（段階遷移・水やりブーストとクールダウン・木の実の周期・
  盆栽の樹形値と帯）が時刻注入で決定的に検証できること
- ストアの永続化（保存→再読込）と鉢数上限・記録の集計
- パネルの分岐（空き鉢／育成中／成熟でボタンが変わること）
- レジストリへの登録（general:garden）
"""
import random
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general.garden import garden as g  # noqa: E402
from core.general.garden.render import render_garden_png  # noqa: E402

T0 = 1_700_000_000
HOUR = 3600
DAY = 24 * HOUR


class GrowthStageTest(unittest.TestCase):
    def test_grass_stages(self):
        plant = g.new_plant("grass", T0)
        self.assertEqual(g.stage_of(plant, T0), g.STAGE_SEED)
        self.assertEqual(g.stage_of(plant, T0 + int(0.12 * 12 * HOUR)), g.STAGE_SPROUT)
        self.assertEqual(g.stage_of(plant, T0 + int(0.45 * 12 * HOUR)), g.STAGE_GROWING)
        self.assertEqual(g.stage_of(plant, T0 + 12 * HOUR - 1), g.STAGE_GROWING)
        self.assertEqual(g.stage_of(plant, T0 + 12 * HOUR), g.STAGE_MATURE)

    def test_seconds_to_next_stage(self):
        plant = g.new_plant("grass", T0)
        self.assertEqual(g.seconds_to_next_stage(plant, T0), int(0.12 * 12 * HOUR))
        self.assertIsNone(g.seconds_to_next_stage(plant, T0 + 12 * HOUR))

    def test_no_death_when_left_alone(self):
        # 放置しても枯れない（何年経っても成熟のまま）。
        plant = g.new_plant("grass", T0)
        self.assertEqual(g.stage_of(plant, T0 + 365 * DAY), g.STAGE_MATURE)


class WaterTest(unittest.TestCase):
    def test_boost_and_cooldown(self):
        plant = g.new_plant("grass", T0)
        self.assertTrue(g.apply_water(plant, T0))
        # +2時間ぶん成長している
        self.assertAlmostEqual(g.effective_growth(plant, T0), g.WATER_BOOST_SECONDS)
        # クールダウン中は不可
        self.assertFalse(g.can_water(plant, T0 + HOUR))
        self.assertFalse(g.apply_water(plant, T0 + HOUR))
        # 4時間後は可
        self.assertTrue(g.can_water(plant, T0 + g.WATER_COOLDOWN_SECONDS))

    def test_water_can_push_to_mature(self):
        plant = g.new_plant("grass", T0)
        now = T0 + 11 * HOUR
        self.assertTrue(g.apply_water(plant, now))
        self.assertEqual(g.stage_of(plant, now), g.STAGE_MATURE)
        # 成熟した草への水やりは不可
        self.assertFalse(g.can_water(plant, now + g.WATER_COOLDOWN_SECONDS))


class TreeFruitTest(unittest.TestCase):
    def test_fruit_cycle(self):
        plant = g.new_plant("tree", T0)
        self.assertFalse(g.fruit_ready(plant, T0 + 4 * DAY - 1))
        g.settle_plant(plant, T0 + 4 * DAY)
        self.assertEqual(plant["matured_at"], T0 + 4 * DAY)
        # 成熟と同時に最初の実がなる
        self.assertTrue(g.fruit_ready(plant, T0 + 4 * DAY))
        self.assertTrue(g.apply_pick_fruit(plant, T0 + 4 * DAY))
        # 次の実は24時間後
        self.assertFalse(g.fruit_ready(plant, T0 + 5 * DAY - 1))
        self.assertEqual(g.fruit_in_seconds(plant, T0 + 4 * DAY), DAY)
        self.assertTrue(g.fruit_ready(plant, T0 + 5 * DAY))

    def test_fruit_ready_without_settle(self):
        # settle（確定）前でも、成熟していれば実の判定ができる。
        plant = g.new_plant("tree", T0)
        self.assertIsNone(plant["fruit_ready_at"])
        self.assertTrue(g.fruit_ready(plant, T0 + 4 * DAY))
        self.assertFalse(g.fruit_ready(plant, T0 + 4 * DAY - 1))

    def test_matured_at_with_water_boost(self):
        # 水やりブーストで成熟を跨いだ場合、成熟時刻はブーストした時刻。
        plant = g.new_plant("tree", T0)
        water_at = T0 + 4 * DAY - HOUR  # 残り1時間のところで+2時間ブースト
        self.assertTrue(g.apply_water(plant, water_at))
        g.settle_plant(plant, water_at)
        self.assertEqual(plant["matured_at"], water_at)


class BonsaiTest(unittest.TestCase):
    def test_trait_assigned(self):
        plant = g.new_plant("bonsai", T0, random.Random(1))
        self.assertIn(plant["trait"], g.BONSAI_TRAITS)
        self.assertIsNone(g.new_plant("grass", T0)["trait"])

    def test_form_bands(self):
        self.assertEqual(g.form_band(0)[0], "若木")
        self.assertEqual(g.form_band(10)[0], "佳作")
        self.assertEqual(g.form_band(30)[0], "名品")
        self.assertEqual(g.form_band(60)[0], "逸品")
        self.assertEqual(g.form_band(100)[0], "国宝級")
        label, rest = g.form_band(25)
        self.assertEqual(label, "佳作")
        self.assertEqual(rest, 5)

    def test_prune_only_after_mature(self):
        plant = g.new_plant("bonsai", T0)
        self.assertFalse(g.can_prune(plant, T0 + DAY))
        mature_at = T0 + 7 * DAY
        self.assertTrue(g.can_prune(plant, mature_at))
        self.assertTrue(g.apply_prune(plant, mature_at))
        self.assertAlmostEqual(g.form_points(plant, mature_at), g.PRUNE_FORM_POINTS)
        # 剪定クールダウン24時間
        self.assertFalse(g.apply_prune(plant, mature_at + HOUR))
        self.assertTrue(g.can_prune(plant, mature_at + g.PRUNE_COOLDOWN_SECONDS))

    def test_water_after_mature_adds_form(self):
        plant = g.new_plant("bonsai", T0)
        mature_at = T0 + 7 * DAY
        self.assertTrue(g.apply_water(plant, mature_at))
        # +2 が本体。ブーストぶんの経過成長（2時間）も受動分として微増する。
        points = g.form_points(plant, mature_at)
        self.assertGreaterEqual(points, g.WATER_FORM_POINTS)
        self.assertLess(points, g.WATER_FORM_POINTS + 0.2)

    def test_passive_form_growth(self):
        plant = g.new_plant("bonsai", T0)
        # 成木から10日経過で +10（1日あたり+1）
        points = g.form_points(plant, T0 + 17 * DAY)
        self.assertAlmostEqual(points, 10.0, places=5)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "garden.json"
        self.store = g.GardenStore(self.path, rng=random.Random(7))

    def tearDown(self):
        self.tmp.cleanup()

    def test_plant_and_persist(self):
        self.assertTrue(self.store.plant(111, 0, "grass", T0))
        # 埋まった鉢には植えられない
        self.assertFalse(self.store.plant(111, 0, "tree", T0))
        self.store.flush()
        reloaded = g.GardenStore(self.path)
        snapshot = reloaded.snapshot(111)
        self.assertEqual(snapshot["pots"][0]["species"], "grass")
        self.assertEqual(snapshot["records"]["planted"], 1)
        # 他ユーザーは空
        self.assertEqual(reloaded.snapshot(222)["pots"], [None] * g.POT_COUNT)

    def test_harvest_records_and_clears(self):
        self.store.plant(111, 1, "grass", T0)
        self.assertFalse(self.store.harvest_grass(111, 1, T0 + HOUR))  # 未成熟
        self.assertTrue(self.store.harvest_grass(111, 1, T0 + 12 * HOUR))
        snapshot = self.store.snapshot(111)
        self.assertIsNone(snapshot["pots"][1])
        self.assertEqual(snapshot["records"]["grass_harvests"], 1)

    def test_water_and_fruit_records(self):
        self.store.plant(111, 0, "tree", T0)
        self.assertTrue(self.store.water(111, 0, T0))
        self.assertTrue(self.store.pick_fruit(111, 0, T0 + 4 * DAY))
        snapshot = self.store.snapshot(111)
        self.assertEqual(snapshot["records"]["waterings"], 1)
        self.assertEqual(snapshot["records"]["tree_fruits"], 1)

    def test_pot_count_enforced_on_load(self):
        import json
        payload = {"version": 1, "users": {"9": {
            "pots": [g.new_plant("grass", T0)] * 5,
            "records": {},
        }}}
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        store = g.GardenStore(self.path)
        self.assertEqual(len(store.snapshot(9)["pots"]), g.POT_COUNT)

    def test_corrupt_file_loads_empty(self):
        self.path.write_text("{not json", encoding="utf-8")
        store = g.GardenStore(self.path)
        self.assertEqual(store.snapshot(1)["pots"], [None] * g.POT_COUNT)


class _StubCog:
    def __init__(self, store):
        self.store = store


class PanelBranchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = g.GardenStore(Path(self.tmp.name) / "garden.json",
                                   rng=random.Random(3))
        from core.general.garden.cog import GardenView
        self.view = GardenView(_StubCog(self.store), 555)
        self.view.load()
        self.view.refresh()

    def tearDown(self):
        self.tmp.cleanup()

    def labels(self):
        return [getattr(child, "label", None) for child in self.view.children]

    def test_empty_pot_shows_plant_buttons(self):
        labels = self.labels()
        self.assertIn("草を植える", labels)
        self.assertIn("木を植える", labels)
        self.assertIn("盆栽を植える", labels)
        self.assertNotIn("水やり", labels)

    def test_growing_shows_water(self):
        self.store.plant(555, 0, "grass", _now_seconds())
        self.view.load()
        self.view.refresh()
        self.assertIn("水やり", self.labels())

    def test_mature_grass_shows_harvest(self):
        import time
        past = int(time.time()) - 13 * HOUR
        self.store.plant(555, 0, "grass", past)
        self.view.load()
        self.view.refresh()
        labels = self.labels()
        self.assertIn("収穫する", labels)
        self.assertNotIn("水やり", labels)


def _now_seconds() -> int:
    import time
    return int(time.time())


class RenderTest(unittest.TestCase):
    def test_render_mixed_garden(self):
        pots = [
            g.new_plant("grass", T0, random.Random(1)),
            g.new_plant("tree", T0, random.Random(2)),
            None,
        ]
        png = render_garden_png(pots, T0 + 5 * DAY)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)

    def test_render_bonsai_mature(self):
        pots = [g.new_plant("bonsai", T0, random.Random(5)), None, None]
        plant = pots[0]
        plant["form"] = 120.0
        png = render_garden_png(pots, T0 + 30 * DAY)
        self.assertTrue(png.startswith(b"\x89PNG"))


class RegistrationTest(unittest.TestCase):
    def test_genre_and_action(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES
        self.assertIn("garden", GENERAL_GENRES)
        self.assertIn(("植物栽培", "garden"), GENERAL_ACTIONS["garden"])

    def test_registry_spec(self):
        from core.general import action_registry
        registry = action_registry.default_registry()
        spec = registry.get("general:garden")
        self.assertIsNotNone(spec)
        # 個人の庭の表示なのでメッセージ経由ショートカットの候補には入れない
        self.assertNotIn("shortcut", spec.surfaces)
        self.assertIn("panel", spec.surfaces)


if __name__ == "__main__":
    unittest.main()
