# -*- coding: utf-8 -*-
"""導線最適化 M3（/game 1段化）の固定テスト。"""
import unittest


class GameHubOneStepTest(unittest.TestCase):
    def test_hub_shows_all_games_without_genre(self):
        from cogs.game import GameHubView, GameSelect, GameGenreSelect, game_select_pages
        from core.game_guides import GAME_ORDER

        view = GameHubView(None)
        selects = [c for c in view.children if isinstance(c, GameSelect)]
        genres = [c for c in view.children if isinstance(c, GameGenreSelect)]
        self.assertEqual(len(genres), 1)  # ジャンルは絞り込みとして残る
        # ページめくり化: セレクトは1つだけにし、全ゲームはページをめくって届く。
        self.assertEqual(len(selects), 1)
        pages = game_select_pages()
        seen = []
        for i, chunk in enumerate(pages):
            view.page = i
            view.refresh()
            select = next(c for c in view.children if isinstance(c, GameSelect))
            self.assertLessEqual(len(select.options), 25)
            seen.extend(o.value for o in select.options)
        self.assertEqual(seen, list(GAME_ORDER))

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


class FakeResponse:
    def __init__(self):
        self.edits = []

    def is_done(self):
        return False

    async def edit_message(self, **kwargs):
        self.edits.append(kwargs)


def fake_interaction():
    import types
    return types.SimpleNamespace(response=FakeResponse())


class GameHubPagerTest(unittest.IsolatedAsyncioTestCase):
    def pager_buttons(self, view):
        from cogs.game import GamePageButton
        by_id = {c.custom_id: c for c in view.children if getattr(c, "custom_id", None)}
        return by_id

    def test_pager_buttons_state_at_edges(self):
        from cogs.game import GameHubView

        view = GameHubView(None)
        buttons = self.pager_buttons(view)
        self.assertTrue(buttons["panel:game:page_prev"].disabled)   # 先頭ページ
        self.assertFalse(buttons["panel:game:page_next"].disabled)
        self.assertTrue(buttons["panel:game:page_indicator"].disabled)
        self.assertEqual(buttons["panel:game:page_indicator"].label, "1 / 2ページ")

        view.page = 1
        view.refresh()
        buttons = self.pager_buttons(view)
        self.assertFalse(buttons["panel:game:page_prev"].disabled)
        self.assertTrue(buttons["panel:game:page_next"].disabled)   # 最終ページ
        self.assertEqual(buttons["panel:game:page_indicator"].label, "2 / 2ページ")

    async def test_next_button_switches_select_options(self):
        from cogs.game import GameHubView, GameSelect, game_select_pages
        from core.panel_v2 import PanelLayoutView

        view = GameHubView(None)
        pages = game_select_pages()
        self.assertGreater(len(pages), 1)
        next_button = self.pager_buttons(view)["panel:game:page_next"]
        interaction = fake_interaction()
        await next_button.callback(interaction)

        self.assertEqual(view.page, 1)
        self.assertEqual(len(interaction.response.edits), 1)
        sent_view = interaction.response.edits[0]["view"]
        self.assertIsInstance(sent_view, PanelLayoutView)
        self.assertIs(sent_view.panel, view)
        select = next(c for c in view.children if isinstance(c, GameSelect))
        self.assertEqual([o.value for o in select.options], pages[1])
        self.assertEqual(select.custom_id, "panel:game:select")
        buttons = self.pager_buttons(view)
        self.assertEqual(buttons["panel:game:page_indicator"].label, "2 / 2ページ")

    async def test_prev_button_returns_to_first_page(self):
        from cogs.game import GameHubView, GameSelect, game_select_pages

        view = GameHubView(None, page=1)
        prev_button = self.pager_buttons(view)["panel:game:page_prev"]
        await prev_button.callback(fake_interaction())
        self.assertEqual(view.page, 0)
        select = next(c for c in view.children if isinstance(c, GameSelect))
        self.assertEqual([o.value for o in select.options], game_select_pages()[0])

    async def test_select_on_second_page_opens_detail(self):
        from cogs.game import GameDetailView, GameHubView, GameSelect
        from core.game_guides import GAME_ORDER
        from core.panel_v2 import PanelLayoutView

        view = GameHubView(None, page=1)
        select = next(c for c in view.children if isinstance(c, GameSelect))
        target = GAME_ORDER[-1]
        self.assertIn(target, [o.value for o in select.options])
        select._values = [target]
        interaction = fake_interaction()
        await select.callback(interaction)

        self.assertEqual(len(interaction.response.edits), 1)
        sent_view = interaction.response.edits[0]["view"]
        self.assertIsInstance(sent_view, PanelLayoutView)
        self.assertIsInstance(sent_view.panel, GameDetailView)
        self.assertEqual(sent_view.panel.game_id, target)

    async def test_back_opens_hub_on_games_page(self):
        from cogs.game import GameDetailView, GameHubView, GameSelect
        from core.game_guides import GAME_ORDER

        target = GAME_ORDER[-1]  # 2ページ目のゲーム
        detail = GameDetailView(None, target)
        back_button = next(c for c in detail.children
                           if getattr(c, "custom_id", None) == "panel:game:back")
        interaction = fake_interaction()
        await back_button.callback(interaction)

        self.assertEqual(len(interaction.response.edits), 1)
        hub = interaction.response.edits[0]["view"]
        self.assertIsInstance(hub, GameHubView)
        self.assertEqual(hub.page, 1)
        select = next(c for c in hub.children if isinstance(c, GameSelect))
        self.assertIn(target, [o.value for o in select.options])


if __name__ == "__main__":
    unittest.main()
