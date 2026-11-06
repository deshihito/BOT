"""ワンナイト人狼（core/game/onenight.py）のテスト。"""

import random
import unittest

from core.game.onenight import ROBBER, SEER, VILLAGER, WOLF, OneNightSession, build_deck


def session_with(roles, center=(VILLAGER, VILLAGER)):
    """役職を固定してセッションを作る（players は 1..len）。"""
    players = list(range(1, len(roles) + 1))
    s = OneNightSession.__new__(OneNightSession)
    s.players = players
    s.initial = {uid: role for uid, role in zip(players, roles)}
    s.center = list(center)
    s.final = dict(s.initial)
    s.seer_views = {}
    s.robber_target = None
    s.robber_done = False
    s.votes = {}
    return s


class DeckTest(unittest.TestCase):
    def test_deck_composition(self):
        for n in (3, 4, 5, 6):
            deck = build_deck(n, random.Random(1))
            self.assertEqual(len(deck), n + 2)
            self.assertEqual(deck.count(WOLF), 2)
            self.assertEqual(deck.count(SEER), 1)
            self.assertEqual(deck.count(ROBBER), 1)

    def test_session_deals_center(self):
        s = OneNightSession([1, 2, 3], rng=random.Random(2))
        self.assertEqual(len(s.center), 2)
        self.assertEqual(len(s.initial), 3)


class NightTest(unittest.TestCase):
    def test_wolf_partners(self):
        s = session_with([WOLF, VILLAGER, WOLF])
        self.assertEqual(s.wolf_partners(1), [3])
        self.assertEqual(s.wolf_partners(3), [1])

    def test_seer_views_initial_role(self):
        s = session_with([SEER, WOLF, VILLAGER])
        self.assertEqual(s.seer_view_player(1, 2), WOLF)
        self.assertEqual(s.seer_view_center(1), [VILLAGER, VILLAGER])

    def test_robber_swap_changes_final_and_win_team(self):
        # 怪盗(1) が人狼(2) と交換 → 1 が人狼・2 が怪盗になる
        s = session_with([ROBBER, WOLF, VILLAGER, SEER])
        s.set_robber_target(1, 2)
        s.resolve_night()
        self.assertEqual(s.final[1], WOLF)
        self.assertEqual(s.final[2], ROBBER)
        # 村人陣営が 2（元人狼・今は怪盗）を処刑しても人狼は処刑されない
        s.vote(2, 2)
        s.vote(3, 2)
        s.vote(4, 2)
        s.vote(1, 3)
        result = s.result()
        self.assertFalse(result["village_win"])
        self.assertEqual(result["winners"], [1])

    def test_village_wins_by_executing_wolf(self):
        s = session_with([WOLF, VILLAGER, SEER])
        s.vote(1, 3)
        s.vote(2, 1)
        s.vote(3, 1)
        result = s.result()
        self.assertTrue(result["village_win"])
        self.assertEqual(sorted(result["winners"]), [2, 3])
        self.assertEqual(result["executed"], [1])

    def test_peaceful_night_village_wins(self):
        s = session_with([VILLAGER, SEER, ROBBER], center=(WOLF, WOLF))
        s.vote(1, 2)
        s.vote(2, 1)
        s.vote(3, 1)
        result = s.result()
        self.assertTrue(result["peaceful"])
        self.assertTrue(result["village_win"])

    def test_tie_votes_execute_all_tied(self):
        s = session_with([WOLF, VILLAGER, SEER, ROBBER])
        s.vote(1, 2)
        s.vote(2, 1)
        s.vote(3, 1)
        s.vote(4, 2)
        self.assertEqual(sorted(s.executed()), [1, 2])


if __name__ == "__main__":
    unittest.main()
