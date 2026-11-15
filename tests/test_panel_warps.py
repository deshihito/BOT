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
        # support 側パネルに組み込むのは boardnotify / notices の2本。
        # （導線最適化 U2: 旧 rta は boardnotify へ吸収、旧 automation の
        #  ワープは通知系の移行先 notices へ移動。automation 自体はワープ無し）
        self.assertEqual(
            [(w.to_root, w.to_genre) for w in warps_from("support", "boardnotify")],
            [("general", "boardnotify_rta")],
        )
        self.assertEqual(warps_from("support", "rta"), [])
        notices = warps_from("support", "notices")
        self.assertEqual(len(notices), 1)  # ジャンル単位で1本まで
        self.assertEqual(
            (notices[0].to_root, notices[0].to_genre, notices[0].label),
            ("general", "exp", "EXP・レベルへ移動"),
        )
        self.assertEqual(warps_from("support", "automation"), [])

    def test_all_pairs_declared(self):
        pairs = {(w.from_root, w.from_genre, w.to_root, w.to_genre) for w in PANEL_WARPS}
        expected = {
            ("support", "boardnotify", "general", "boardnotify_rta"),
            ("general", "boardnotify_rta", "support", "boardnotify"),
            ("support", "notices", "general", "exp"),
            ("general", "exp", "support", "notices"),
            ("vc", "trigger", "support", "notices"),
            ("support", "notices", "vc", "trigger"),
            ("vc", None, "support", "notices"),
            ("support", "notices", "vc", None),
            ("support", "notices", "vc", "gvc_rooms"),
            ("vc", "gvc_rooms", "support", "notices"),
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

    def test_boardnotify_has_warp(self):
        self.assertEqual(
            self._warp_ids("boardnotify"),
            {"panel:support:warp_general_boardnotify_rta": "RTAランキングへ移動"},
        )

    def test_legacy_rta_genre_resolves_to_boardnotify(self):
        # 旧保存ジャンル "rta" はエイリアスで boardnotify へ移行する。
        self.assertEqual(
            self._warp_ids("rta"),
            {"panel:support:warp_general_boardnotify_rta": "RTAランキングへ移動"},
        )

    def test_notices_has_single_warp(self):
        self.assertEqual(
            self._warp_ids("notices"),
            {"panel:support:warp_general_exp": "EXP・レベルへ移動"},
        )

    def test_automation_has_no_warp(self):
        self.assertEqual(self._warp_ids("automation"), {})

    def test_moderation_has_no_warp(self):
        self.assertEqual(self._warp_ids("moderation"), {})


class SupportPanelPagingTest(unittest.TestCase):
    def test_all_support_genres_fit_one_page(self):
        # 導線最適化 U2: automation 36件の2ページ化を解消し、全ジャンルが
        # 25件以下・1ページに収まること（ページめくり不要）。
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE
        from core.support.panel import ACTION_PAGE_SIZE, SupportPanelView, support_action_pages

        for genre, items in SUPPORT_ACTIONS_BY_GENRE.items():
            with self.subTest(genre=genre):
                self.assertLessEqual(len(items), ACTION_PAGE_SIZE)
                self.assertEqual(len(support_action_pages(genre)), 1)
                view = SupportPanelView(None, genre=genre)
                ids = {item.custom_id for item in view.children
                       if getattr(item, "custom_id", None)}
                self.assertNotIn("panel:support:action_next", ids)

    def test_small_genre_has_no_pager(self):
        from core.support.panel import SupportPanelView

        view = SupportPanelView(None, genre="boardnotify")
        ids = {item.custom_id for item in view.children if getattr(item, "custom_id", None)}
        self.assertNotIn("panel:support:action_next", ids)


if __name__ == "__main__":
    unittest.main()
