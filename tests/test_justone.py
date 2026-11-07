# -*- coding: utf-8 -*-
import unittest

from core.game.justone.justone import WORDS, JustOneSession, eliminate_duplicates, normalize


class JustOneBankTest(unittest.TestCase):
    def test_bank_size_and_unique(self):
        self.assertGreaterEqual(len(WORDS), 150)
        self.assertEqual(len(WORDS), len(set(WORDS)))

    def test_normalize(self):
        self.assertEqual(normalize("ＡＢＣ "), normalize("abc"))


class EliminateTest(unittest.TestCase):
    def test_duplicates_removed(self):
        kept, removed = eliminate_duplicates({1: "海", 2: "海", 3: "青い", 4: "波"})
        self.assertEqual(set(kept.values()), {"青い", "波"})
        self.assertEqual(removed, ["海"])

    def test_fullwidth_duplicate_removed(self):
        kept, _ = eliminate_duplicates({1: "abc", 2: "ＡＢＣ"})
        self.assertEqual(kept, {})


class JustOneSessionTest(unittest.TestCase):
    def setUp(self):
        self.session = JustOneSession([10, 20, 30], ["ねこ", "富士山"])

    def test_flow(self):
        self.assertEqual(self.session.next_round(), "ねこ")
        self.assertEqual(self.session.guesser, 10)
        # 回答者はヒントを出せない
        self.assertFalse(self.session.submit_hint(10, "動物"))
        # 空白を含むヒントは不可
        self.assertFalse(self.session.submit_hint(20, "かわいい 動物"))
        self.assertTrue(self.session.submit_hint(20, "動物"))
        self.assertTrue(self.session.submit_hint(30, "ペット"))
        self.assertTrue(self.session.all_hints_in())
        self.assertTrue(self.session.answer("ねこ"))
        self.assertEqual(self.session.successes, 1)
        self.session.next_round()
        self.assertEqual(self.session.guesser, 20)
        self.assertFalse(self.session.answer("山"))
        self.assertEqual(self.session.successes, 1)
        self.assertIsNone(self.session.next_round())
        self.assertTrue(self.session.finished)


if __name__ == "__main__":
    unittest.main()
