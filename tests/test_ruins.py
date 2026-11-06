# -*- coding: utf-8 -*-
import random
import unittest

from core.game.ruins import ARTIFACT_VALUES, HAZARDS, TREASURES, RuinsGame, build_deck


class DeckTest(unittest.TestCase):
    def test_composition(self):
        deck = build_deck(0, random.Random(1))
        treasures = [c for c in deck if c[0] == "treasure"]
        hazards = [c for c in deck if c[0] == "hazard"]
        artifacts = [c for c in deck if c[0] == "artifact"]
        self.assertEqual(len(treasures), 15)
        self.assertEqual(sum(v for _, v in treasures), 124)
        self.assertEqual(len(hazards), 15)
        for h in HAZARDS:
            self.assertEqual(sum(1 for c in hazards if c[1] == h), 3)
        self.assertEqual(artifacts, [("artifact", ARTIFACT_VALUES[0])])


def forced_game(deck_cards):
    """デッキを指定順（pop順=末尾から出る）で固定したゲームを作る。"""
    g = RuinsGame([10, 20, 30], rng=random.Random(0))
    g.start_round()
    g.deck = list(reversed(deck_cards))
    return g


class RuinsFlowTest(unittest.TestCase):
    def test_treasure_split_and_path_remainder(self):
        g = forced_game([("treasure", 7)])
        event = g.reveal()
        self.assertEqual(event["type"], "treasure")
        self.assertEqual(event["share"], 2)       # 7 // 3
        self.assertEqual(event["path_gems"], 1)   # 端数
        self.assertTrue(all(g.carrying[u] == 2 for u in g.players))

    def test_sole_leaver_gets_path_and_artifact(self):
        g = forced_game([("artifact", 5), ("treasure", 8)])
        g.reveal()  # artifact
        self.assertTrue(g.decide(10, True))
        self.assertTrue(g.decide(20, True))
        self.assertTrue(g.decide(30, True))
        g.resolve_decisions()
        g.reveal()  # treasure 8 -> 2 each, path 2
        g.decide(10, False)
        g.decide(20, True)
        g.decide(30, True)
        result = g.resolve_decisions()
        self.assertEqual(result["type"], "continue")
        # 10: carrying 2 + path 2 + artifact 5 = 9
        self.assertEqual(g.banked[10], 9)
        self.assertEqual(g.path_artifacts, [])

    def test_hazard_burst_loses_carried_and_removes_hazard(self):
        g = forced_game([("treasure", 9), ("hazard", "炎"), ("hazard", "炎")])
        g.reveal()  # 9 -> 3 each
        for uid in g.players:
            g.decide(uid, True)
        g.resolve_decisions()
        g.reveal()  # 炎 1枚目
        for uid in g.players:
            g.decide(uid, True)
        g.resolve_decisions()
        event = g.reveal()  # 炎 2枚目でバースト
        self.assertEqual(event["type"], "round_end")
        self.assertIn("炎", g.removed_hazards)
        self.assertTrue(all(g.banked[u] == 0 for u in g.players))
        self.assertEqual(g.phase, "round_end")

    def test_all_leave_ends_round_with_path_split(self):
        g = forced_game([("treasure", 10)])
        g.reveal()  # 3 each, path 1
        for uid in g.players:
            g.decide(uid, False)
        result = g.resolve_decisions()
        self.assertEqual(result["type"], "round_end")
        # 3 + path 1//3=0 -> 3 each
        self.assertTrue(all(g.banked[u] == 3 for u in g.players))

    def test_removed_hazard_stays_reduced_next_round(self):
        g = forced_game([("hazard", "炎"), ("hazard", "炎")])
        g.removed_hazards = set()
        g.reveal()
        for uid in g.players:
            g.decide(uid, True)
        g.resolve_decisions()
        g.reveal()  # burst
        g.start_round()
        flames = [c for c in g.deck if c == ("hazard", "炎")]
        self.assertEqual(len(flames), 2)  # 3 - 1枚欠け


if __name__ == "__main__":
    unittest.main()
