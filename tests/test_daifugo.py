"""大富豪の基本ルール回帰テスト。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import game_fakes  # noqa: F401
from cogs.game import DaifugoGame, label
from core.game.daifugo.cog import JOKER, card_label


class DaifugoRulesTest(unittest.TestCase):
    def test_eight_cut_clears_table_and_lead_returns_to_player(self):
        # 仕様修正 (2026-11-07, ユーザー報告): 8切りで場が流れたら、次へ
        # 回さず「出した本人が続けてリードする」のが本来の動き。以前の
        # 「次の人へ回す」期待はバグ側の仕様だったため差し替えた。
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
        self.assertEqual(game.turn, 2)
        self.assertTrue(game.cleared)
        self.assertTrue(game.eight_cut)


if __name__ == "__main__":
    unittest.main()


class DaifugoAutoEndTest(unittest.TestCase):
    """終了ガード（2026-11-07）: Bot を除く人間全員が2回連続でパスしたら自動終了。"""

    def game(self, hands, turn=1):
        g = DaifugoGame(1, 2, 1)
        g.players = {u: None for u in hands}
        g.hands = {u: list(h) for u, h in hands.items()}
        g.phase, g.turn = "playing", turn
        return g

    def test_all_humans_pass_twice_auto_ends(self):
        g = self.game({1: ["S3", "S4"], -1: ["H2", "C5"], -2: ["D6", "S7"]})
        g.table = ("S9",)
        g.last_player = -1
        self.assertTrue(g.pass_turn(1))             # 人間パス1回目
        self.assertEqual(g.play(-1, ("H2",)), "ok")  # Bot が出す（リセットしない）
        self.assertTrue(g.pass_turn(-2))            # Bot のパス（数えない）
        self.assertEqual(g.turn, 1)
        self.assertFalse(g.auto_ended)
        self.assertTrue(g.pass_turn(1))             # 人間パス2回目 → 自動終了
        self.assertTrue(g.auto_ended)
        self.assertEqual(g.phase, "done")
        # 順位: 残り手札の少ない順（人間1: 2枚、Bot-2: 2枚→参加順で人間が先、Bot-1: 1枚）
        self.assertEqual(g.finished, [-1, 1, -2])
        self.assertEqual(g.results()[0], (-1, "大富豪"))

    def test_human_play_resets_own_streak(self):
        g = self.game({1: ["S3", "SK"], -1: ["H2", "C5"], -2: ["D6", "S7"]})
        g.table = ("S3",)
        g.last_player = -1
        self.assertTrue(g.pass_turn(1))
        self.assertEqual(g.human_pass_streak[1], 1)
        self.assertEqual(g.play(-1, ("C5",)), "ok")
        self.assertTrue(g.pass_turn(-2))
        self.assertEqual(g.play(1, ("SK",)), "ok")   # 人間が出した → リセット
        self.assertEqual(g.human_pass_streak[1], 0)
        self.assertFalse(g.auto_ended)

    def test_single_pass_does_not_end(self):
        g = self.game({1: ["S3"], 2: ["S4"], -1: ["H2", "C5"]})
        g.table = ("S9",)
        g.last_player = -1
        self.assertTrue(g.pass_turn(1))
        self.assertTrue(g.pass_turn(2))
        self.assertFalse(g.auto_ended)               # 2人とも1回だけでは終わらない
        self.assertEqual(g.phase, "playing")

    def test_eight_cut_when_player_goes_out_passes_lead_on(self):
        g = self.game({1: ["S5"], 2: ["H8"], 3: ["D4", "C6"]}, turn=2)
        g.table = ("S5",)
        g.last_player = 1
        self.assertEqual(g.play(2, ("H8",)), "ok")   # 8切りで上がり → 次の人へ
        self.assertEqual(g.finished, [2])
        self.assertEqual(g.turn, 3)


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
