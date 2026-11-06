# -*- coding: utf-8 -*-
import unittest
from collections import Counter

from core.game.mendou import COPIES, KINDS, MendouGame

DECK_SIZE = len(KINDS) * COPIES


class MendouGameTest(unittest.TestCase):
    def test_deck_composition_and_deal(self):
        game = MendouGame([1, 2, 3])
        total = Counter()
        for hand in game.hands.values():
            total.update(hand)
        self.assertEqual(sum(total.values()), DECK_SIZE)
        for kind in KINDS:
            self.assertEqual(total[kind], 4)

    def test_chain_start_and_peek(self):
        game = MendouGame([1, 2, 3])
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        self.assertTrue(game.start_chain(starter, kind, target, "宿題"))
        self.assertTrue(game.chain_active)
        self.assertEqual(game.holder, target)
        self.assertEqual(game.peek(target), kind)
        self.assertIsNone(game.peek(starter))
        self.assertEqual(game.hand_size(starter), sum(game.hands[starter].values()))

    def test_pass_on_excludes_visited(self):
        game = MendouGame([1, 2, 3])
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, "宿題")
        self.assertNotIn(starter, game.pass_targets(target))
        third = game.pass_targets(target)[0]
        self.assertTrue(game.pass_on(target, third, "残業"))
        self.assertEqual(game.holder, third)
        self.assertTrue(game.must_accept())

    def test_accept_truth_correct_guess_passer_takes(self):
        game = MendouGame([1, 2, 3])
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, kind)  # 正直に宣言
        result = game.accept(target, True)  # 本当だと思う → 的中
        self.assertTrue(result["truth"])
        self.assertTrue(result["guessed_right"])
        self.assertEqual(result["taker"], starter)
        self.assertEqual(game.fronts[starter][kind], 1)
        self.assertEqual(game.starter, starter)

    def test_accept_lie_caught_passer_takes(self):
        game = MendouGame([1, 2, 3])
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        other = next(k for k in KINDS if k != kind)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, other)  # 嘘の宣言
        result = game.accept(target, False)  # 嘘だと思う → 的中
        self.assertFalse(result["truth"])
        self.assertTrue(result["guessed_right"])
        self.assertEqual(result["taker"], starter)  # 見抜かれたら渡した側が引き取る
        self.assertEqual(game.fronts[starter][kind], 1)
        self.assertEqual(game.starter, starter)

    def test_accept_wrong_guess_holder_takes(self):
        game = MendouGame([1, 2, 3])
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, kind)  # 正直な宣言
        result = game.accept(target, False)  # 嘘だと思う → 外れ
        self.assertTrue(result["truth"])
        self.assertFalse(result["guessed_right"])
        self.assertEqual(result["taker"], target)
        self.assertEqual(game.starter, target)

    def test_four_of_a_kind_loses(self):
        from collections import Counter as _Counter
        game = MendouGame([1, 2])
        game.fronts[1]["宿題"] = 3
        game.hands[1] = _Counter({"宿題": 1})
        game.starter = 1
        self.assertTrue(game.start_chain(1, "宿題", 2, "宿題"))
        result = game.accept(2, True)  # 本当だと見抜く → 渡した側(1)が引き取る
        self.assertEqual(result["taker"], 1)
        self.assertEqual(game.fronts[1]["宿題"], 4)
        self.assertEqual(game.loser, 1)
        self.assertTrue(game.finished)
        self.assertEqual(game.winners, [2])

    def test_starter_without_cards_loses(self):
        game = MendouGame([1, 2])
        game.starter = 1
        game.hands[1] = Counter()
        self.assertFalse(game.check_starter_can_play())
        self.assertEqual(game.loser, 1)


if __name__ == "__main__":
    unittest.main()
