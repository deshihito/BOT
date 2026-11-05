"""大富豪の基本ルール回帰テスト。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import game_fakes  # noqa: F401
from cogs.daifugo import DaifugoGame, JOKER, card_label, label


class DaifugoRulesTest(unittest.TestCase):
    def test_eight_cut_clears_table_and_passes_lead_to_next_player(self):
        game = DaifugoGame(10, 20, 1)
        game.players = {1: object(), 2: object(), 3: object()}
        game.hands = {1: ["S5"], 2: ["H8", "C3"], 3: ["D4"]}
        game.phase = "playing"
        game.turn = 2
        game.table = ("S5",)
        game.last_player = 1

        result = game.play(2, ("H8",))

        self.assertEqual(result, "ok")
        self.assertIsNone(game.table)
        self.assertEqual(game.turn, 3)
        self.assertTrue(game.cleared)
        self.assertTrue(game.eight_cut)


if __name__ == "__main__":
    unittest.main()


class DaifugoRuleOptionsTest(unittest.TestCase):
    def game(self, hands):
        g = DaifugoGame(1, 2, 1)
        g.players = {u: None for u in hands}
        g.hands = {u: list(h) for u, h in hands.items()}
        g.phase = "playing"
        return g

    def test_eight_cut_disabled_keeps_table(self):
        g = self.game({1: ["H8", "C3"], 2: ["S5"], 3: ["D4"]})
        g.rule_eight_cut = False
        g.turn = 1
        result = g.play(1, ("H8",))
        self.assertEqual(result, "ok")
        self.assertFalse(g.eight_cut)
        self.assertEqual(g.table, ("H8",))

    def test_spade3_beats_joker_only_when_enabled(self):
        g = self.game({1: ["S9"], 2: ["S3", "H7"], 3: ["S6"]})
        g.table = (JOKER,)
        g.turn = 2
        self.assertNotIn(("S3",), g.legal(2))
        g.rule_spade3 = True
        self.assertIn(("S3",), g.legal(2))
        self.assertEqual(g.play(2, ("S3",)), "ok")

    def test_spade3_does_not_beat_other_tables(self):
        g = self.game({1: ["S9"], 2: ["S3"], 3: ["S6"]})
        g.rule_spade3 = True
        g.table = ("H2",)
        g.turn = 2
        self.assertNotIn(("S3",), g.legal(2))

    def test_card_label_uses_suit_names(self):
        self.assertEqual(card_label("S5"), "スペード5")
        self.assertEqual(card_label("HK"), "ハートK")
        self.assertEqual(card_label(JOKER), "ジョーカー")
        self.assertEqual(label(("S5", "H5")), "スペード5 ハート5")
