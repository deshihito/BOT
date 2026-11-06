"""ボード系3種（オセロ・将棋・チェス）の勝敗記録（A2）のテスト。

- 対人戦の勝者は core/game/party_ranking.py のサーバー別ランキングに記録される
- CPU戦は対人戦と混ぜないため記録しない
- 引き分け（オセロの同数・チェスのステイルメイト相当）はどちらにも付けない
"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import game_fakes  # noqa: F401
from core.game import party_ranking
from cogs import chess, othello, shogi


def fresh_ranking():
    party_ranking._shared = party_ranking.PartyRanking(client=None)
    return party_ranking.shared()


def user(uid):
    return SimpleNamespace(id=uid, mention=f"<@{uid}>")


class RegistrationTest(unittest.TestCase):
    def test_board_games_registered(self):
        for game in ("othello", "shogi", "chess"):
            self.assertIn(game, party_ranking.KNOWN_GAMES)
            self.assertTrue(party_ranking.is_ranked(game))


class OthelloRecordTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ranking = fresh_ranking()

    def make_game(self, mode="human"):
        g = othello.OthelloGame(100, 55, 1, mode=mode)
        g.players = {othello.BLACK: user(1), othello.WHITE: user(2)}
        return g

    async def test_human_win_recorded(self):
        g = self.make_game()
        g.board = [[othello.BLACK] * 8 for _ in range(8)]
        g.board[0][0] = othello.WHITE
        await othello.record_result(g)
        self.assertEqual(self.ranking.memory.get((55, "othello")), {1: 1})

    async def test_draw_not_recorded(self):
        g = self.make_game()
        g.board = [[othello.BLACK] * 4 + [othello.WHITE] * 4 for _ in range(8)]
        await othello.record_result(g)
        self.assertEqual(self.ranking.memory.get((55, "othello"), {}), {})

    async def test_cpu_win_not_recorded(self):
        g = self.make_game(mode="cpu")
        g.players = {othello.BLACK: user(1), othello.WHITE: None}
        g.board = [[othello.BLACK] * 8 for _ in range(8)]
        await othello.record_result(g)
        self.assertEqual(self.ranking.memory.get((55, "othello"), {}), {})


class ShogiRecordTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ranking = fresh_ranking()

    async def test_human_win_recorded(self):
        s = SimpleNamespace(mode="human", guild_id=66)
        await shogi.record_win(s, user(7))
        self.assertEqual(self.ranking.memory.get((66, "shogi")), {7: 1})

    async def test_cpu_win_not_recorded(self):
        s = SimpleNamespace(mode="cpu", guild_id=66)
        await shogi.record_win(s, user(7))
        self.assertEqual(self.ranking.memory.get((66, "shogi"), {}), {})

    async def test_no_winner_not_recorded(self):
        s = SimpleNamespace(mode="human", guild_id=66)
        await shogi.record_win(s, None)
        self.assertEqual(self.ranking.memory.get((66, "shogi"), {}), {})


class ChessRecordTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ranking = fresh_ranking()

    def make_game(self, mode="human"):
        return SimpleNamespace(mode=mode, guild_id=77,
                               players={"white": user(3), "black": user(4)})

    async def test_checkmate_or_timeout_win_recorded(self):
        # チェックメイト・時間切れの両決着が同じ record_win を通る
        g = self.make_game()
        await chess.record_win(g, "black")
        self.assertEqual(self.ranking.memory.get((77, "chess")), {4: 1})

    async def test_cpu_win_not_recorded(self):
        g = self.make_game(mode="cpu")
        g.players = {"white": user(3)}
        await chess.record_win(g, "white")
        self.assertEqual(self.ranking.memory.get((77, "chess"), {}), {})


if __name__ == "__main__":
    unittest.main()
