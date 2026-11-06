"""クイズ大会（core/game/quiz_bank.py / core/game/quiz_game.py）のテスト。"""

import random
import unittest

from core.game.quiz_bank import QUESTIONS, BankQuizSource
from core.game.quiz_game import QuizSession, points_for


class BankTest(unittest.TestCase):
    def test_bank_has_at_least_30_questions_with_4_choices(self):
        self.assertGreaterEqual(len(QUESTIONS), 30)
        for q in QUESTIONS:
            self.assertEqual(len(q["choices"]), 4)
            self.assertIn(q["answer"], range(4))

    def test_source_shuffles_choices_but_keeps_answer(self):
        source = BankQuizSource()
        picked = source.get_questions(10, rng=random.Random(7))
        self.assertEqual(len(picked), 10)
        bank_texts = {q["q"] for q in QUESTIONS}
        for q in picked:
            self.assertIn(q["q"], bank_texts)
            original = next(o for o in QUESTIONS if o["q"] == q["q"])
            self.assertEqual(q["choices"][q["answer"]], original["choices"][original["answer"]])
            self.assertEqual(sorted(q["choices"]), sorted(original["choices"]))


class ScoringTest(unittest.TestCase):
    def test_points(self):
        self.assertEqual(points_for(False, 1.0, 3), 0)
        self.assertEqual(points_for(True, 1.0, 1), 150)   # 100 + 速度50 + 連続0
        self.assertEqual(points_for(True, 0.0, 3), 120)   # 100 + 速度0 + 連続20
        self.assertEqual(points_for(True, 0.5, 9), 175)   # 100 + 25 + 連続上限50


class SessionTest(unittest.TestCase):
    def make_session(self):
        return QuizSession([
            {"category": "t", "q": "q1", "choices": ["a", "b", "c", "d"], "answer": 0},
            {"category": "t", "q": "q2", "choices": ["a", "b", "c", "d"], "answer": 1},
        ])

    def test_full_flow_and_winners(self):
        s = self.make_session()
        s.add_player(1)
        s.add_player(2)
        s.next_question()
        self.assertTrue(s.submit(1, 0, 1.0))
        self.assertFalse(s.submit(1, 1, 1.0))  # 二重回答は不可
        self.assertTrue(s.submit(2, 2, 0.5))
        self.assertTrue(s.all_answered())
        gained = s.close_question()
        self.assertEqual(gained[1], 150)
        self.assertEqual(gained[2], 0)
        s.next_question()
        s.submit(1, 1, 0.0)  # 正解（連続2問目）
        s.submit(2, 1, 0.0)  # 正解
        gained = s.close_question()
        self.assertEqual(gained[1], 110)
        self.assertEqual(s.winners(), [1])
        rows = s.standings()
        self.assertEqual(rows[0][0], 1)
        self.assertEqual(rows[0][1], 260)

    def test_late_joiner_scores_from_next_answers(self):
        s = self.make_session()
        s.add_player(1)
        s.next_question()
        s.submit(1, 0, 1.0)
        s.close_question()
        s.next_question()
        self.assertTrue(s.submit(9, 1, 1.0))  # 途中参加
        gained = s.close_question()
        self.assertEqual(gained[9], 150)
        self.assertIn(9, [r[0] for r in s.standings()])

    def test_unanswered_resets_streak(self):
        s = self.make_session()
        s.add_player(1)
        s.next_question()
        s.submit(1, 0, 1.0)
        s.close_question()
        self.assertEqual(s.players[1]["streak"], 1)
        s.next_question()
        s.close_question()  # 無回答
        self.assertEqual(s.players[1]["streak"], 0)


if __name__ == "__main__":
    unittest.main()
