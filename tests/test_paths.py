# -*- coding: utf-8 -*-
"""core/paths.py (パス解決の基底) と、移行した各モジュールの定数が
同じ実パスを指すことを確認する。再構成でモジュールを動かしても
アセット・フォント・保存先がずれないための回帰テスト。"""
import os
import sys
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import paths  # noqa: E402


class PathsBaseTest(unittest.TestCase):
    def test_repo_root_detection(self):
        self.assertEqual(paths.REPO_ROOT, Path(ROOT))
        self.assertTrue((paths.REPO_ROOT / "font.ttf").is_file())
        self.assertTrue((paths.REPO_ROOT / "assets" / "fonts").is_dir())

    def test_constants_exist(self):
        self.assertTrue(paths.DEFAULT_FONT_PATH.is_file())
        self.assertTrue(paths.FONTS_DIR.is_dir())
        self.assertTrue(paths.asset_path("reversi").is_dir())
        self.assertTrue(paths.asset_path("wordle").is_dir())
        self.assertTrue(paths.asset_path("chess", "IMG_4904.png").is_file())
        self.assertTrue(paths.shared_asset_path("hrtf", "kemar_hrir_48k.npz").is_file())
        self.assertTrue(paths.shared_asset_path("spatial").is_dir())
        self.assertTrue(paths.font_path("DelaGothicOne-Regular.ttf").is_file())

    def test_data_path(self):
        p = paths.data_path("example.json")
        self.assertEqual(p.parent, paths.REPO_ROOT / "data")
        self.assertEqual(p.name, "example.json")


class MigratedModulesTest(unittest.TestCase):
    def test_data_paths_agrees(self):
        from core.support import data_paths
        self.assertEqual(data_paths.repo_root(), paths.REPO_ROOT)
        self.assertEqual(data_paths.data_path("x.json"), paths.data_path("x.json"))

    def test_board_and_uno_fonts(self):
        from core.game.hub import board_image
        from core.game.uno import board as uno_board
        self.assertEqual(board_image.FONT_PATH, paths.DEFAULT_FONT_PATH)
        self.assertEqual(uno_board._FONT_PATH, paths.DEFAULT_FONT_PATH)
        self.assertEqual(
            uno_board._DISPLAY_FONT_PATH, paths.font_path("DelaGothicOne-Regular.ttf"))

    def test_asset_dirs(self):
        from core.game.othello import cog as othello_cog
        from core.game.shogi import cog as shogi_cog
        from core.game.wordle import cog as wordle_cog
        self.assertEqual(othello_cog.ASSET_DIR, paths.asset_path("reversi"))
        self.assertEqual(shogi_cog.ASSET_DIR, paths.asset_path("shogi"))
        self.assertEqual(wordle_cog.DATA_DIR, paths.asset_path("wordle"))

    def test_roots_agree(self):
        from core.general.exp import exp
        from core.general.miq import miq
        from core.support.server_assist.features import welcome
        self.assertEqual(exp._REPO_ROOT, paths.REPO_ROOT)
        self.assertEqual(miq._MIQ_ASSET_FONTS, paths.FONTS_DIR)
        self.assertEqual(welcome._REPO_ROOT, paths.REPO_ROOT)

    def test_market_and_luna_and_music(self):
        from core.general.market import cog as market_cog
        from core.support.server_assist.features import luna_ai
        from core.vc.music import hrtf, measured
        self.assertEqual(market_cog.CHART_PATH, paths.data_path("market_chart.png"))
        self.assertEqual(
            market_cog.CHART_FONT_PATH, paths.font_path("MPLUSRounded1c-Regular.ttf"))
        self.assertEqual(luna_ai.ICON_PATH, paths.asset_path("luna_ai_icon.jpg"))
        self.assertTrue(luna_ai.ICON_B64_PATH.is_file())
        self.assertEqual(
            hrtf._HRTF_PATH, paths.shared_asset_path("hrtf", "kemar_hrir_48k.npz"))
        self.assertEqual(measured._ASSETS, paths.shared_asset_path("spatial"))


if __name__ == "__main__":
    unittest.main()
