# -*- coding: utf-8 -*-
import unittest
from collections import Counter
from unittest.mock import AsyncMock, MagicMock

from core.game.mendou.mendou import COPIES, DEAL_PER_PLAYER, KINDS, MendouGame

DECK_SIZE = len(KINDS) * COPIES


class MendouGameTest(unittest.TestCase):
    def test_deck_composition_and_deal(self):
        # 短縮仕様（2026-11-06）: 山は8種×4枚のまま、配るのは1人5枚だけ。
        # 残りは除外され、各種の配布枚数は4を超えない。
        game = MendouGame([1, 2, 3])
        total = Counter()
        for hand in game.hands.values():
            total.update(hand)
            self.assertEqual(sum(hand.values()), DEAL_PER_PLAYER)
        self.assertEqual(sum(total.values()), DEAL_PER_PLAYER * 3)
        self.assertEqual(game.dealt_total, DEAL_PER_PLAYER * 3)
        self.assertEqual(game.excluded_total, DECK_SIZE - DEAL_PER_PLAYER * 3)
        for kind in KINDS:
            self.assertLessEqual(total[kind], COPIES)

    def test_deal_five_each_for_all_player_counts(self):
        for n in range(2, 7):
            game = MendouGame(list(range(1, n + 1)))
            for hand in game.hands.values():
                self.assertEqual(sum(hand.values()), DEAL_PER_PLAYER)
            self.assertEqual(game.dealt_total, DEAL_PER_PLAYER * n)

    def test_last_result_recorded_on_accept(self):
        game = MendouGame([1, 2, 3])
        self.assertIsNone(game.last_result)
        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, kind)
        result = game.accept(target, True)
        self.assertEqual(game.last_result, result)

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


class MendouPanelTest(unittest.IsolatedAsyncioTestCase):
    """進行の単一メッセージ集約（2026-11-06）: 判定で新規投稿しないこと。"""

    async def test_apply_accept_edits_session_message_only(self):
        from core.game.mendou.cog import Mendou, status_text

        cog = Mendou(MagicMock())
        game = MendouGame([1, 2, 3])
        cog.channels[99] = game
        panel_msg = MagicMock()
        panel_msg.edit = AsyncMock()
        cog.messages[99] = panel_msg

        channel = MagicMock()
        channel.id = 99
        channel.send = AsyncMock(side_effect=AssertionError("ゲーム中に新規投稿してはいけない"))

        starter = game.starter
        kind = next(k for k, n in game.hands[starter].items() if n > 0)
        target = next(u for u in game.players if u != starter)
        game.start_chain(starter, kind, target, kind)

        interaction = MagicMock()
        interaction.user.id = target
        interaction.channel = channel
        interaction.response.send_message = AsyncMock()
        interaction.response.edit_message = AsyncMock()

        await cog.apply_accept(interaction, game, True)
        channel.send.assert_not_called()
        panel_msg.edit.assert_awaited()
        # 判定結果はセッションメッセージ本文（status_text）に集約される
        self.assertIn("直近の判定", status_text(game))
        self.assertIn(kind, status_text(game))


if __name__ == "__main__":
    unittest.main()
