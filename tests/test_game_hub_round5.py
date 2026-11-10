# -*- coding: utf-8 -*-
import unittest
from pathlib import Path

from core.game.game.cog import GAME_COGS, game_select_pages
from core.game.game.game_guides import GAME_ORDER
from core.game.game.party_ranking import KNOWN_GAMES

ROUND5_GAMES = ("cipher", "wirecut", "liardice", "mendou", "yotsuba")
RANKING_GAMES = ("cipher", "liardice", "mendou")

REPO_ROOT = Path(__file__).resolve().parents[1]


class Round5HubTest(unittest.TestCase):
    def test_game_order_has_47_games(self):
        self.assertEqual(len(GAME_ORDER), 48)
        for game_id in ROUND5_GAMES:
            self.assertIn(game_id, GAME_ORDER)
            self.assertIn(game_id, GAME_COGS)

    def test_all_genre_paginates(self):
        pages = game_select_pages(None)
        self.assertEqual([len(p) for p in pages], [25, 23])
        flat = [item for page in pages for item in page]
        self.assertEqual(len(flat), len(set(flat)))

    def test_party_genre_paginates(self):
        pages = game_select_pages("party")
        self.assertEqual([len(p) for p in pages], [25, 5])
        flat = {item for page in pages for item in page}
        for game_id in ROUND5_GAMES:
            self.assertIn(game_id, flat)

    def test_ranking_known_games(self):
        for game_id in RANKING_GAMES:
            self.assertIn(game_id, KNOWN_GAMES)
        self.assertEqual(len(KNOWN_GAMES), 33)

    def test_sql_migration_lists_round5_games(self):
        sql = (REPO_ROOT / "docs" / "sql" / "party_game_ranking_add_round5_games.sql").read_text(encoding="utf-8")
        for game_id in RANKING_GAMES:
            self.assertIn(f"'{game_id}'", sql)


if __name__ == "__main__":
    unittest.main()
