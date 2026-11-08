# -*- coding: utf-8 -*-
"""ジャンルワープ（core/panel_warps.py）の固定テスト。

- 対応表の from/to の root・genre が各ルートの正リストに実在すること
  （存在しないジャンルキーを書かないことの固定）
- support パネルが対応表を参照してワープボタンを描画すること
- support パネルのページングで25件超ジャンルの全件が選べること
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.panel_warps import PANEL_WARPS, warps_from  # noqa: E402


def _genre_keys(root: str) -> set:
    if root == "general":
        from core.general.common import GENERAL_GENRES
        return set(GENERAL_GENRES)
    if root == "vc":
        from core.vc.common import VOICE_GENRES
        return set(VOICE_GENRES)
    if root == "support":
        from cogs.support import SUPPORT_GENRES
        return set(SUPPORT_GENRES)
    if root == "game":
        from core.game.game.cog import GAME_GENRES
        return set(GAME_GENRES)
    raise AssertionError(f"unknown root: {root}")


class WarpTableValidityTest(unittest.TestCase):
    def test_roots_and_genres_exist(self):
        for warp in PANEL_WARPS:
            with self.subTest(warp=warp):
                self.assertEqual(warp.landing, "panel")
                self.assertIn(warp.scope, {"genre", "action"})
                # from / to のジャンルは各ルートの実キーか、ハブ全体を
                # 表す None のどちらかであること。
                self.assertTrue(
                    warp.from_genre is None or warp.from_genre in _genre_keys(warp.from_root),
                    f"from {warp.from_root}:{warp.from_genre} が実在しません",
                )
                self.assertTrue(
                    warp.to_genre is None or warp.to_genre in _genre_keys(warp.to_root),
                    f"to {warp.to_root}:{warp.to_genre} が実在しません",
                )

    def test_support_panel_warps_are_the_specified_three(self):
        # support 側パネルに組み込むのは boardnotify / rta / automation の3本。
        self.assertEqual(
            [(w.to_root, w.to_genre) for w in warps_from("support", "boardnotify")],
            [("general", "boardnotify_rta")],
        )
        self.assertEqual(
            [(w.to_root, w.to_genre) for w in warps_from("support", "rta")],
            [("general", "boardnotify_rta")],
        )
        automation = warps_from("support", "automation")
        self.assertEqual(len(automation), 1)  # ジャンル単位で1本まで
        self.assertEqual(
            (automation[0].to_root, automation[0].to_genre, automation[0].label),
            ("general", "exp", "EXP・レベルへ移動"),
        )

    def test_all_pairs_declared(self):
        pairs = {(w.from_root, w.from_genre, w.to_root, w.to_genre) for w in PANEL_WARPS}
        expected = {
            ("support", "boardnotify", "general", "boardnotify_rta"),
            ("general", "boardnotify_rta", "support", "boardnotify"),
            ("support", "rta", "general", "boardnotify_rta"),
            ("general", "boardnotify_rta", "support", "rta"),
            ("support", "automation", "general", "exp"),
            ("general", "exp", "support", "automation"),
            ("vc", "trigger", "support", "automation"),
            ("support", "automation", "vc", "gvc_rooms"),
            ("vc", "gvc_rooms", "support", "automation"),
            ("general", "money", "general", "boardnotify_rta"),
            ("general", "boardnotify_rta", "general", "money"),
            ("game", None, "general", "boardnotify_rta"),
            ("general", "boardnotify_rta", "game", None),
        }
        self.assertTrue(expected <= pairs, expected - pairs)


class SupportPanelWarpRenderTest(unittest.TestCase):
    def _warp_ids(self, genre):
        from core.support.panel import SupportPanelView

        view = SupportPanelView(None, genre=genre)
        return {
            item.custom_id: item.label
            for item in view.children
            if getattr(item, "custom_id", None) and ":warp_" in item.custom_id
        }

    def test_boardnotify_and_rta_have_warp(self):
        self.assertEqual(
            self._warp_ids("boardnotify"),
            {"panel:support:warp_general_boardnotify_rta": "RTAランキングへ移動"},
        )
        self.assertEqual(
            self._warp_ids("rta"),
            {"panel:support:warp_general_boardnotify_rta": "RTAランキングへ移動"},
        )

    def test_automation_has_single_warp(self):
        self.assertEqual(
            self._warp_ids("automation"),
            {"panel:support:warp_general_exp": "EXP・レベルへ移動"},
        )

    def test_moderation_has_no_warp(self):
        self.assertEqual(self._warp_ids("moderation"), {})


class SupportPanelPagingTest(unittest.TestCase):
    def test_automation_pages_cover_all_actions(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE
        from core.support.panel import ACTION_PAGE_SIZE, support_action_pages

        pages = support_action_pages("automation")
        self.assertGreater(len(SUPPORT_ACTIONS_BY_GENRE["automation"]), ACTION_PAGE_SIZE)
        self.assertEqual(len(pages), 2)
        flat = [value for page in pages for _label, value in page]
        self.assertEqual(flat, [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["automation"]])

    def test_panel_second_page_select_shows_remaining(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE
        from core.support.panel import SupportPanelView

        view = SupportPanelView(None, genre="automation")
        ids = {item.custom_id for item in view.children if getattr(item, "custom_id", None)}
        self.assertIn("panel:support:action_next", ids)
        view.action_page = 1
        view.refresh()
        select = next(
            item for item in view.children
            if getattr(item, "custom_id", None) == "panel:support:action"
        )
        shown = [option.value for option in select.options]
        expected = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["automation"][25:]]
        self.assertEqual(shown, expected)

    def test_small_genre_has_no_pager(self):
        from core.support.panel import SupportPanelView

        view = SupportPanelView(None, genre="boardnotify")
        ids = {item.custom_id for item in view.children if getattr(item, "custom_id", None)}
        self.assertNotIn("panel:support:action_next", ids)


if __name__ == "__main__":
    unittest.main()
