# -*- coding: utf-8 -*-
"""導線最適化 M3（/game 1段化）の固定テスト。"""
import unittest


class GameHubOneStepTest(unittest.TestCase):
    def test_hub_shows_all_games_without_genre(self):
        from cogs.game import GameHubView, GameSelect, GameGenreSelect
        from core.game_guides import GAME_ORDER

        view = GameHubView(None)
        selects = [c for c in view.children if isinstance(c, GameSelect)]
        genres = [c for c in view.children if isinstance(c, GameGenreSelect)]
        self.assertEqual(len(genres), 1)  # ジャンルは絞り込みとして残る
        # ラウンド3で全34ゲームとなり上限25件を超えたため、全ゲームは
        # 25件ごとの複数セレクトに分割して出す（合算で全ゲームに1段で届く）。
        values = [o.value for s in selects for o in s.options]
        self.assertEqual(values, list(GAME_ORDER))
        for s in selects:
            self.assertLessEqual(len(s.options), 25)

    def test_hub_genre_filter_narrows_games(self):
        from cogs.game import GameHubView, GameSelect

        view = GameHubView(None)
        view.genre = "solo"
        view.refresh()
        selects = [c for c in view.children if isinstance(c, GameSelect)]
        self.assertEqual(len(selects), 1)
        values = [o.value for o in selects[0].options]
        # ラウンド3: ダンジョンは「アドベンチャー」1件ジャンルを畳んで solo へ寄せた
        self.assertEqual(sorted(values), ["dungeon", "flash", "game2048", "guess", "highlow", "minesweeper",
                                          "nonogram", "shinkei", "sudoku", "wordle"])

    def test_genres_have_no_single_game_genre(self):
        # ラウンド3: 1件ジャンル（旧アドベンチャー）は器を畳んだ。ジャンルは3種
        from cogs.game import GAME_GENRES, GAME_GENRE_BY_GAME

        self.assertEqual(sorted(GAME_GENRES), ["board", "party", "solo"])
        counts = {}
        for genre in GAME_GENRE_BY_GAME.values():
            counts[genre] = counts.get(genre, 0) + 1
        self.assertTrue(all(n >= 2 for n in counts.values()))
        self.assertEqual(GAME_GENRE_BY_GAME["dungeon"], "solo")

    def test_select_options_have_no_description(self):
        # ラウンド3: 人数・所要時間は詳細フィールドが担い、セレクトでは重ねない
        from cogs.game import GameHubView, GameSelect, detail_embed

        view = GameHubView(None)
        for s in [c for c in view.children if isinstance(c, GameSelect)]:
            for o in s.options:
                self.assertIsNone(o.description)
        fields = {f.name: f.value for f in detail_embed("dungeon").fields}
        self.assertEqual(fields["人数の目安"], "1人")
        self.assertIn("所要時間", fields)

    def test_custom_ids_unchanged(self):
        # PR-B 不変条件: 固定 custom_id は変更しない
        from cogs.game import GameHubView

        view = GameHubView(None)
        ids = [c.custom_id for c in view.children if getattr(c, "custom_id", None)]
        self.assertIn("panel:game:genre", ids)
        self.assertIn("panel:game:select", ids)


if __name__ == "__main__":
    unittest.main()
