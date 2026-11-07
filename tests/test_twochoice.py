"""究極の二択（core/game/twochoice/twochoice.py）のテスト。お題バンクと集計。"""

import random
import unittest

from core.game.twochoice.twochoice import QUESTIONS, QUESTIONS_PER_SESSION, minority_side, pick_questions, tally


class BankTest(unittest.TestCase):
    def test_bank_has_at_least_30_pairs(self):
        self.assertGreaterEqual(len(QUESTIONS), 30)
        for q in QUESTIONS:
            self.assertEqual(len(q), 2)
            self.assertTrue(all(isinstance(x, str) and x for x in q))
            self.assertNotEqual(q[0], q[1])

    def test_pick_questions_count_and_unique(self):
        picked = pick_questions(random.Random(3))
        self.assertEqual(len(picked), QUESTIONS_PER_SESSION)
        self.assertEqual(len({tuple(q) for q in picked}), QUESTIONS_PER_SESSION)


class TallyTest(unittest.TestCase):
    def test_tally(self):
        self.assertEqual(tally({1: "A", 2: "A", 3: "B"}), (2, 1))
        self.assertEqual(tally({}), (0, 0))

    def test_minority(self):
        self.assertEqual(minority_side({1: "A", 2: "A", 3: "B"}), "B")
        self.assertEqual(minority_side({1: "A", 2: "B", 3: "B"}), "A")
        self.assertIsNone(minority_side({1: "A", 2: "B"}))
        self.assertIsNone(minority_side({}))


if __name__ == "__main__":
    unittest.main()
