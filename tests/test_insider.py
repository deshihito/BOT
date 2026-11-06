# -*- coding: utf-8 -*-
import random
import unittest

from core.insider import TOPICS, InsiderGame


def make_game(seed=1):
    return InsiderGame([10, 20, 30, 40, 50], topic="ねこ", rng=random.Random(seed))


class InsiderBankTest(unittest.TestCase):
    def test_topics(self):
        self.assertGreaterEqual(len(TOPICS), 60)
        self.assertEqual(len(TOPICS), len(set(TOPICS)))


class InsiderGameTest(unittest.TestCase):
    def test_roles_distinct(self):
        g = make_game()
        self.assertNotEqual(g.master, g.insider)
        self.assertIn(g.master, g.players)
        self.assertIn(g.insider, g.players)

    def test_citizens_win(self):
        g = make_game()
        citizen = next(p for p in g.players if p not in (g.master, g.insider))
        self.assertTrue(g.guess_topic(citizen, "ねこ"))
        self.assertEqual(g.phase, "vote")
        for p in g.players:
            self.assertTrue(g.vote(p, g.insider))
        self.assertEqual(g.settle(), "citizens")

    def test_wrong_vote_insider_wins(self):
        g = make_game()
        citizen = next(p for p in g.players if p not in (g.master, g.insider))
        other = next(p for p in g.players if p not in (g.master, g.insider, citizen))
        g.guess_topic(citizen, "ねこ")
        for p in g.players:
            g.vote(p, other)
        self.assertEqual(g.settle(), "insider")

    def test_master_cannot_be_voted(self):
        g = make_game()
        citizen = next(p for p in g.players if p not in (g.master, g.insider))
        g.guess_topic(citizen, "ねこ")
        self.assertFalse(g.vote(citizen, g.master))

    def test_question_limit_ends_game(self):
        g = InsiderGame([10, 20, 30, 40], topic="ねこ", rng=random.Random(2), question_limit=3)
        g.answer_question()
        g.answer_question()
        self.assertEqual(g.phase, "question")
        g.answer_question()
        self.assertEqual(g.phase, "done")
        self.assertEqual(g.result, "insider")

    def test_wrong_guess_stays_in_question_phase(self):
        g = make_game()
        citizen = next(p for p in g.players if p not in (g.master, g.insider))
        self.assertFalse(g.guess_topic(citizen, "いぬ"))
        self.assertEqual(g.phase, "question")


if __name__ == "__main__":
    unittest.main()
