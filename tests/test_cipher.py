# -*- coding: utf-8 -*-
import unittest

from core.game.cipher import ALL_CODES, MAX_ROUNDS, WORDS, CipherGame

KEYWORDS = {0: ["あ", "い", "う", "え"], 1: ["か", "き", "く", "け"]}


def make_game():
    game = CipherGame([[1, 3], [2, 4]], KEYWORDS)
    game.start_round()
    return game


def wrong_code(actual):
    return next(c for c in ALL_CODES if c != actual)


def play_round(game, decode0=None, decode1=None, intercept0=None, intercept1=None):
    game.submit_hints(0, game.encryptor(0), ["h1", "h2", "h3"])
    game.submit_hints(1, game.encryptor(1), ["g1", "g2", "g3"])
    if intercept0 is not None:
        game.submit_intercept(0, game.teams[0][0], intercept0)
    if intercept1 is not None:
        game.submit_intercept(1, game.teams[1][0], intercept1)
    game.submit_decode(0, game.teams[0][0], game.codes[0] if decode0 is None else decode0)
    game.submit_decode(1, game.teams[1][0], game.codes[1] if decode1 is None else decode1)
    return game.resolve_round()


class CipherGameTest(unittest.TestCase):
    def test_code_is_three_distinct_digits(self):
        self.assertEqual(len(ALL_CODES), 24)
        game = make_game()
        for team in (0, 1):
            code = game.codes[team]
            self.assertEqual(len(set(code)), 3)
            self.assertTrue(all(1 <= d <= 4 for d in code))

    def test_word_bank_unique(self):
        self.assertEqual(len(WORDS), len(set(WORDS)))
        self.assertGreaterEqual(len(WORDS), 160)

    def test_teams_and_encryptor(self):
        game = make_game()
        self.assertEqual(game.team_of(3), 0)
        self.assertEqual(game.team_of(4), 1)
        self.assertIsNone(game.team_of(99))
        self.assertEqual(game.encryptor(0), 1)
        self.assertEqual(game.encryptor(1), 2)

    def test_only_encryptor_can_submit_hints(self):
        game = make_game()
        self.assertFalse(game.submit_hints(0, 3, ["a", "b", "c"]))  # 暗号担当は 1
        self.assertTrue(game.submit_hints(0, 1, ["a", "b", "c"]))
        self.assertFalse(game.submit_hints(0, 1, ["x", "y", "z"]))  # 二重提出
        self.assertFalse(game.submit_hints(1, 2, ["a", "", "c"]))   # 空白不可

    def test_correct_round_no_tokens(self):
        game = make_game()
        events = play_round(game)
        self.assertEqual(events, {0: {"intercepted": False, "decoded": True},
                                  1: {"intercepted": False, "decoded": True}})
        self.assertEqual(game.miscom_tokens, [0, 0])
        self.assertEqual(game.intercept_tokens, [0, 0])
        self.assertFalse(game.finished)

    def test_first_round_intercept_rejected(self):
        game = make_game()
        game.submit_hints(0, 1, ["a", "b", "c"])
        game.submit_hints(1, 2, ["a", "b", "c"])
        self.assertFalse(game.submit_intercept(0, 1, game.codes[1]))

    def test_two_miscommunications_lose(self):
        game = make_game()
        play_round(game, decode0=wrong_code(game.codes[0]))
        self.assertEqual(game.miscom_tokens[0], 1)
        game.start_round()
        play_round(game, decode0=wrong_code(game.codes[0]))
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, 1)

    def test_two_intercepts_lose(self):
        game = make_game()
        play_round(game)  # 1ラウンド目は傍受なし
        game.start_round()
        play_round(game, intercept1=game.codes[0])
        self.assertEqual(game.intercept_tokens[1], 1)
        game.start_round()
        play_round(game, intercept1=game.codes[0])
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, 1)

    def test_final_round_tiebreak_draw(self):
        game = make_game()
        game.round_index = MAX_ROUNDS - 1
        play_round(game)
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, -1)

    def test_final_round_tiebreak_by_tokens(self):
        game = make_game()
        play_round(game, decode1=wrong_code(game.codes[1]))  # チーム1が1失敗
        game.round_index = MAX_ROUNDS - 1
        self.assertFalse(game.start_round())  # 最終ラウンドを消化済みとして得点判定へ
        self.assertTrue(game.finished)
        self.assertEqual(game.winner, 0)

    def test_hint_history_accumulates_by_slot(self):
        game = make_game()
        play_round(game)
        hist = game.hints_by_slot(0)
        self.assertEqual(sum(len(v) for v in hist.values()), 3)
        self.assertEqual(set(hist.keys()), {1, 2, 3, 4})


if __name__ == "__main__":
    unittest.main()
