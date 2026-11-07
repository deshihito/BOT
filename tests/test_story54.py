# -*- coding: utf-8 -*-
"""54字の物語のテスト。

Discord に接続せず、正規化・文字数判定・PIL レンダリングの出力と、
/general のジャンル再編（make_image 新設、meme/miq 統合）が
action_registry に伝播すること、story54 が AI tools の代理実行候補に
入らないことを確認する。
"""
import io
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from PIL import Image

import cogs.general as g
from core.general import story54 as s54

# ユーザーが参考画像で示したサンプル文（54字ぴったり）
SAMPLE = ("この村では、来訪者一人を神に捧げますが今なら期間限定でもう一人！"
          "何と手数料は村が負担！詳しくは明日の朝刊で！")


class NormalizeTest(unittest.TestCase):
    def test_sample_is_exactly_54(self):
        self.assertEqual(s54.story54_char_count(SAMPLE), 54)
        self.assertEqual(s54.normalize_story54_text(SAMPLE), SAMPLE)

    def test_newlines_are_removed(self):
        with_breaks = "\n".join(SAMPLE[i:i + 9] for i in range(0, 54, 9))
        self.assertEqual(s54.normalize_story54_text(with_breaks), SAMPLE)
        self.assertEqual(s54.story54_char_count(with_breaks), 54)

    def test_surrounding_whitespace_is_stripped(self):
        self.assertEqual(s54.story54_char_count("  \n" + SAMPLE + " \n"), 54)

    def test_inner_space_counts_as_a_char(self):
        spaced = SAMPLE[:10] + " " + SAMPLE[11:]
        self.assertEqual(len(spaced), 54)
        self.assertEqual(s54.story54_char_count(spaced), 54)

    def test_punctuation_counts(self):
        # 句読点・！を削ると 54 にならない（各1字として数える）
        stripped = SAMPLE.replace("、", "").replace("！", "")
        self.assertLess(s54.story54_char_count(stripped), 54)


class RenderTest(unittest.TestCase):
    def test_render_returns_png_1080(self):
        data = s54.render_story54_png(SAMPLE)
        self.assertTrue(data.startswith(b"\x89PNG"))
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.size, (1080, 1080))

    def test_render_rejects_53_and_55(self):
        with self.assertRaises(ValueError):
            s54.render_story54_png(SAMPLE[:-1])
        with self.assertRaises(ValueError):
            s54.render_story54_png(SAMPLE + "あ")

    def test_render_accepts_newline_separated_input(self):
        with_breaks = "\n".join(SAMPLE[i:i + 9] for i in range(0, 54, 9))
        data = s54.render_story54_png(with_breaks)
        self.assertTrue(data.startswith(b"\x89PNG"))

    def test_first_and_last_cells_have_ink(self):
        img = Image.open(io.BytesIO(s54.render_story54_png(SAMPLE))).convert("RGB")
        cell_w = 864 // 6
        cell_h = 864 // 9

        def has_ink(cx, cy):
            region = img.crop((cx - 30, cy - 30, cx + 30, cy + 30))
            return any(sum(px) < 300 for px in region.getdata())

        # 1字目「こ」は右端列・最上行、54字目「！」は左端列・最下行
        first = (108 + 5 * cell_w + cell_w // 2, 108 + cell_h // 2)
        last = (108 + cell_w // 2, 108 + 8 * cell_h + cell_h // 2)
        self.assertTrue(has_ink(*first))
        self.assertTrue(has_ink(*last))


class GenreReorgTest(unittest.TestCase):
    def test_make_image_genre_and_actions(self):
        self.assertEqual(g.GENERAL_GENRES["make_image"], ("画像作成", ""))
        values = [v for _label, v in g.GENERAL_ACTIONS["make_image"]]
        self.assertEqual(values, ["story54", "meme_create", "meme_help", "miq_settings"])
        labels = {v: label for label, v in g.GENERAL_ACTIONS["make_image"]}
        self.assertEqual(labels["story54"], "54字の物語")

    def test_old_genres_gone_and_custom_cleaned(self):
        self.assertNotIn("meme", g.GENERAL_GENRES)
        self.assertNotIn("meme", g.GENERAL_ACTIONS)
        self.assertNotIn("miq", g.GENERAL_GENRES)
        custom_values = {v for _label, v in g.GENERAL_ACTIONS["custom"]}
        self.assertNotIn("miq_settings", custom_values)
        self.assertEqual(len(g.GENERAL_GENRES), 8)  # 栽培ジャンル追加後

    def test_aliases_for_saved_shortcuts(self):
        self.assertEqual(g.GENERAL_GENRE_ALIASES["meme"], "make_image")
        self.assertEqual(g.GENERAL_GENRE_ALIASES["miq"], "make_image")
        self.assertEqual(g.GENERAL_GENRE_ALIASES["translation"], "custom")


class RegistryTest(unittest.TestCase):
    def test_story54_registered_under_make_image(self):
        from core.general import action_registry

        registry = action_registry.default_registry()
        spec = registry.get("general:story54")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "make_image")

    def test_moved_actions_keep_ids_and_genre(self):
        from core.general import action_registry

        registry = action_registry.default_registry()
        for value in ("meme_create", "meme_help", "miq_settings"):
            spec = registry.get(f"general:{value}")
            self.assertIsNotNone(spec, value)
            self.assertEqual(spec.genre, "make_image", value)

    def test_story54_blocked_for_ai(self):
        from core.general import action_registry
        from core.general.ai_tools import ai_tools_router
        self.assertIn("general:story54", action_registry.AI_BLOCKED_IDS)
        self.assertNotIn("general:story54", ai_tools_router.action_candidates())


if __name__ == "__main__":
    unittest.main()
