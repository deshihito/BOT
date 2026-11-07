"""マジョリティ連想（core/game/majority/majority.py）のテスト。"""

import unittest

from core.game.majority.majority import TOPICS, MajoritySession, normalize_answer


class NormalizeTest(unittest.TestCase):
    def test_normalization(self):
        self.assertEqual(normalize_answer("  Apple "), "apple")
        self.assertEqual(normalize_answer("ＡＢＣ"), "abc")
        self.assertEqual(normalize_answer(" 寿司 "), "寿司")
        self.assertEqual(normalize_answer("   "), "")


class SessionTest(unittest.TestCase):
    def test_topics_bank_size(self):
        self.assertGreaterEqual(len(TOPICS), 20)

    def test_tally_majority_points(self):
        s = MajoritySession(["お題"])
        for uid in (1, 2, 3, 4):
            s.add_player(uid)
        s.next_round()
        s.submit(1, "りんご")
        s.submit(2, " りんご ")
        s.submit(3, "バナナ")
        s.submit(4, "りんご")
        result = s.tally()
        self.assertEqual(result["gained"][1], 3)
        self.assertEqual(result["gained"][2], 3)
        self.assertEqual(result["gained"][3], 0)  # 1人だけは0点
        self.assertEqual(result["gained"][4], 3)
        self.assertEqual(sorted(s.winners()), [1, 2, 4])

    def test_duplicate_submit_rejected_and_empty_rejected(self):
        s = MajoritySession(["お題"])
        s.add_player(1)
        s.next_round()
        self.assertTrue(s.submit(1, "a"))
        self.assertFalse(s.submit(1, "b"))
        self.assertFalse(s.submit(2, "   "))

    def test_unanswered_player_gets_zero(self):
        s = MajoritySession(["お題"])
        s.add_player(1)
        s.add_player(2)
        s.next_round()
        s.submit(1, "x")
        result = s.tally()
        self.assertEqual(result["gained"][2], 0)


if __name__ == "__main__":
    unittest.main()
