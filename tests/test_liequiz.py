# -*- coding: utf-8 -*-
import random
import unittest

from core.liequiz import QUESTIONS, LieQuizSession


class LieQuizBankTest(unittest.TestCase):
    def test_questions(self):
        self.assertGreaterEqual(len(QUESTIONS), 60)
        self.assertTrue(all(q and a for q, a in QUESTIONS))


class LieQuizFlowTest(unittest.TestCase):
    def setUp(self):
        self.session = LieQuizSession([10, 20, 30], [("質問？", "本物")], rng=random.Random(1))
        self.session.next_round()

    def test_submit_rules(self):
        s = self.session
        self.assertEqual(s.submit_lie(10, "本物"), "is_truth")
        self.assertEqual(s.submit_lie(10, "嘘A"), "ok")
        self.assertEqual(s.submit_lie(20, "嘘A"), "duplicate")
        self.assertEqual(s.submit_lie(20, "嘘B"), "ok")
        self.assertEqual(s.submit_lie(10, "嘘C"), "invalid")  # 提出済み

    def test_choices_and_votes_and_tally(self):
        s = self.session
        s.submit_lie(10, "嘘A")
        s.submit_lie(20, "嘘B")
        s.submit_lie(30, "嘘C")
        choices = s.build_choices()
        self.assertEqual(len(choices), 4)
        truth_idx = next(i for i, c in enumerate(choices) if c["author"] is None)
        lie_a_idx = next(i for i, c in enumerate(choices) if c["text"] == "嘘A")
        # 自分の嘘には投票できない
        self.assertFalse(s.vote(10, lie_a_idx))
        # 20 は嘘Aに釣られる、30 は本物を当てる、10 は本物を当てる
        self.assertTrue(s.vote(20, lie_a_idx))
        self.assertTrue(s.vote(30, truth_idx))
        self.assertTrue(s.vote(10, truth_idx))
        result = s.tally()
        self.assertEqual(result["gained"][30], 2)
        self.assertEqual(result["gained"][10], 2 + 1)  # 本物 +2、嘘Aが1人を釣った +1
        self.assertEqual(result["gained"][20], 0)
        self.assertEqual(s.winners(), [10])


if __name__ == "__main__":
    unittest.main()
