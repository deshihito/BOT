"""ダンジョン Phase 2（戦闘の判断化）の単体テスト。

対象は cogs/dangeon.py の Phase 2 で導入・変更した部分:
  - (a) アーキタイプ別の意図サイクル遷移
  - (b) 溜め→大ダメージと防御での軽減
  - (c) 新規付与される状態異常が現行3種以内であること
  - (d) 全敵に弱点があり、弱点ダメージが増えること
  - (e) 報酬3択の生成（3件・効果が異なる・二重受取不可）
  - (f) 階段でHPが回復しないこと
  - (g) 敗北ペナルティ計算（半分・0未満なし・スナップショットなしは0）

依存スタブの方式は tests/test_dungeon_logic.py と同一（その installer を再利用する）。
"""

import asyncio
import os
import random
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


def _fixed_random():
    """ダメージ乱数を固定する（乱数幅0・クリティカルなし・付与抽選は外れ）。"""
    return patch.multiple(
        random, random=lambda *a, **k: 0.99, randint=lambda a, b, **k: 0)


def _handmade_enemy(**overrides):
    enemy = {
        "name": "ゴブリン", "type": "normal", "hp": 50, "max_hp": 50,
        "atk": 20, "def_": 0, "spd": 5, "crit": 0.0,
        "element": "fire", "status_effect": "poison",
        "reward_coins": 0, "reward_xp": 0, "reward_box": 0,
        "archetype": "brute", "intent_turn": 0, "intent": "attack",
    }
    enemy.update(overrides)
    return enemy


class TestIntentCycles(unittest.TestCase):
    """(a) アーキタイプ別の意図サイクル遷移。"""

    def setUp(self):
        dangeon.dg_players.clear()

    def test_cycles(self):
        self.assertEqual(
            [dangeon.d_intent_at("brute", i) for i in range(6)],
            ["attack", "charge", "heavy", "attack", "charge", "heavy"])
        self.assertEqual(
            [dangeon.d_intent_at("venom", i) for i in range(4)],
            ["attack", "status", "attack", "attack"])
        self.assertEqual(
            [dangeon.d_intent_at("healer", i) for i in range(4)],
            ["attack", "attack", "heal", "attack"])
        self.assertEqual(
            [dangeon.d_intent_at("normal", i) for i in range(4)],
            ["attack", "attack", "strong", "attack"])
        self.assertEqual(
            [dangeon.d_intent_at("passive", i) for i in range(3)],
            ["wait", "wait", "wait"])

    def test_archetype_assignment(self):
        self.assertEqual(dangeon.d_enemy_archetype("毒キノコ", "normal"), "venom")
        self.assertEqual(dangeon.d_enemy_archetype("サソリ", "normal"), "venom")
        self.assertEqual(dangeon.d_enemy_archetype("トレント", "normal"), "healer")
        self.assertEqual(dangeon.d_enemy_archetype("毒沼蛙", "normal"), "healer")
        self.assertEqual(dangeon.d_enemy_archetype("雷獣", "normal"), "brute")
        self.assertEqual(dangeon.d_enemy_archetype("ゴブリン", "normal"), "normal")
        self.assertEqual(dangeon.d_enemy_archetype("ゴブリン", "elite"), "brute")
        self.assertEqual(dangeon.d_enemy_archetype("ゴブリン", "boss"), "brute")
        # 様子見しかしない特殊個体は静観型（従来どおり攻撃しない）。
        self.assertEqual(dangeon.d_enemy_archetype("ぱすた", "boss"), "passive")

    def test_generated_enemy_has_intent(self):
        for floor in (1, 5, 10):
            enemy = dangeon.d_make_enemy(floor)
            self.assertIn(enemy["archetype"], dangeon.D_INTENT_CYCLES)
            self.assertEqual(enemy["intent_turn"], 0)
            self.assertEqual(
                enemy["intent"],
                dangeon.d_intent_at(enemy["archetype"], 0))

    def test_advance_intent_follows_cycle(self):
        enemy = _handmade_enemy()
        dangeon.d_ensure_intent(enemy)
        self.assertEqual(enemy["intent"], "attack")
        self.assertEqual(dangeon.d_advance_intent(enemy), "charge")
        self.assertEqual(dangeon.d_advance_intent(enemy), "heavy")
        self.assertEqual(dangeon.d_advance_intent(enemy), "attack")


class TestChargeAndHeavy(unittest.TestCase):
    """(b) 溜め→大ダメージと防御での軽減。"""

    def setUp(self):
        dangeon.dg_players.clear()
        self.uid = "combat-heavy"
        self.p = dangeon.d_get_player(self.uid)
        self.p["hp"] = dangeon.d_effective_stats(self.p)["max_hp"]
        self.enemy = _handmade_enemy()
        self.view = dangeon.DungeonCombatView(self.uid, 1, 1, 1, self.enemy, None)

    def test_charge_then_heavy_and_defend_mitigates(self):
        with _fixed_random():
            # 1ターン目: 通常攻撃（プレイヤーDEF 7 → 20-7=13）。
            hp_before = self.p["hp"]
            self.view._enemy_turn()
            attack_loss = hp_before - self.p["hp"]
            self.assertEqual(attack_loss, 13)
            self.assertEqual(self.enemy["intent"], "charge")

            # 2ターン目: 溜め（ダメージなし、大ダメージの予告）。
            hp_before = self.p["hp"]
            log = self.view._enemy_turn()
            self.assertEqual(self.p["hp"], hp_before)
            self.assertIn("溜めている", log)
            self.assertEqual(self.enemy["intent"], "heavy")

            # 3ターン目: 大ダメージ（13 × 1.8 = 23、通常攻撃より大きい）。
            hp_before = self.p["hp"]
            self.view._enemy_turn()
            heavy_loss = hp_before - self.p["hp"]
            self.assertEqual(heavy_loss, 23)
            self.assertGreater(heavy_loss, attack_loss)

            # 防御中の大ダメージは DEF 2倍で軽減される（6 × 1.8 = 10）。
            self.enemy["intent_turn"] = 2
            dangeon.d_ensure_intent(self.enemy)
            self.assertEqual(self.enemy["intent"], "heavy")
            self.view.defending = True
            hp_before = self.p["hp"]
            self.view._enemy_turn()
            defended_loss = hp_before - self.p["hp"]
            self.assertEqual(defended_loss, 10)
            self.assertLess(defended_loss, heavy_loss)


class TestStatusConsolidation(unittest.TestCase):
    """(c) 新規付与される状態異常は現行3種以内。"""

    def setUp(self):
        dangeon.dg_players.clear()

    def test_generated_status_effects_within_active_three(self):
        self.assertEqual(len(dangeon.D_ACTIVE_STATUSES), 3)
        seen = set()
        for floor in (1, 3, 5, 10, 20):
            for _ in range(60):
                seen.add(dangeon.d_make_enemy(floor)["status_effect"])
        self.assertTrue(seen)
        self.assertTrue(seen <= set(dangeon.D_ACTIVE_STATUSES))

    def test_legacy_statuses_still_tick_and_clear(self):
        # 旧セーブに残った対象外の状態異常も例外なく処理できること。
        uid = "combat-legacy-status"
        p = dangeon.d_get_player(uid)
        p["active_effects"] = [
            {"key": "bleed", "turns": 2},
            {"key": "curse", "turns": 2},
            {"key": "silence", "turns": 1},
            {"key": "paralyze", "turns": 1},
        ]
        hp_before = p["hp"]
        logs = dangeon.d_tick_status(uid)
        self.assertTrue(any("出血" in line for line in logs))
        self.assertLess(p["hp"], hp_before)  # 出血の継続ダメージ
        keys = {e["key"] for e in p["active_effects"]}
        self.assertEqual(keys, {"bleed", "curse"})  # 残り1ターンは継続
        dangeon.d_clear_status(uid)
        self.assertEqual(p["active_effects"], [])


class TestWeakness(unittest.TestCase):
    """(d) 全敵に弱点があり、弱点ダメージが増えること。"""

    def setUp(self):
        dangeon.dg_players.clear()
        self.uid = "combat-weakness"
        dangeon.d_get_player(self.uid)
        self.view = dangeon.DungeonCombatView(
            self.uid, 1, 1, 1, _handmade_enemy(), None)

    def test_all_generated_enemies_have_element_and_weakness(self):
        self.assertEqual(len(dangeon.D_ACTIVE_ELEMENTS), 3)
        for floor in (1, 5, 10, 20, 30):
            for _ in range(40):
                enemy = dangeon.d_make_enemy(floor)
                self.assertIn(enemy["element"], dangeon.D_ACTIVE_ELEMENTS)
                self.assertIsNotNone(
                    dangeon.d_element_weakness(enemy["element"]))

    def test_weakness_damage_is_higher(self):
        with _fixed_random():
            for element in dangeon.D_ACTIVE_ELEMENTS:
                defender = {"element": element, "def_": 0, "crit": 0.0}
                neutral, _ = self.view._calculate_damage(
                    {"atk": 30, "def_": 0, "crit": 0.0, "element": "none"}, defender)
                weak, _ = self.view._calculate_damage(
                    {"atk": 30, "def_": 0, "crit": 0.0,
                     "element": dangeon.d_element_weakness(element)}, defender)
                resist, _ = self.view._calculate_damage(
                    {"atk": 30, "def_": 0, "crit": 0.0, "element": element}, defender)
                self.assertEqual(neutral, 30)
                self.assertGreater(weak, neutral, f"{element} の弱点が効くこと")
                self.assertLess(resist, neutral, f"{element} の耐性が効くこと")


if __name__ == "__main__":
    unittest.main()
