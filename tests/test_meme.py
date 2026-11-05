"""meme作成ツールのテスト。

Discord に接続せず、PIL で生成したテスト画像で render_meme_png が
PNG を返すこと・サイズ上限・テキスト描画・空テキストの ValueError を
確認し、/general へのジャンル追加が action_registry に伝播すること、
meme_create が AI tools の代理実行候補に入らないことを確認する。
"""
import io
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from PIL import Image, ImageDraw

import cogs.general as g


def _image_bytes(size=(800, 600), color=(70, 130, 200)) -> bytes:
    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    draw.ellipse([size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4],
                 fill=(230, 200, 90))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _font_path():
    path = g._meme_font_path()
    if path:
        return path
    fonts = g._miq_available_fonts()
    return fonts[0][2] if fonts else None


class RenderMemeTest(unittest.TestCase):
    def setUp(self):
        self.font_path = _font_path()

    def test_returns_png_and_draws_text(self):
        base = _image_bytes()
        data = g.render_meme_png(base, "上テキスト", "下テキスト", font_path=self.font_path)
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (800, 600))
        # テキスト描画で元画像からピクセルが変化している (白文字+黒縁取り)
        rendered = Image.open(io.BytesIO(data)).convert("RGB")
        base_img = Image.open(io.BytesIO(base)).convert("RGB")
        self.assertNotEqual(rendered.tobytes(), base_img.tobytes())
        px = rendered.load()
        whites = sum(
            1 for y in range(0, 120) for x in range(0, 800, 3)
            if px[x, y] == (255, 255, 255)
        )
        self.assertGreater(whites, 50, "上テキストの白文字が描かれていません")

    def test_top_only_and_bottom_only(self):
        base = _image_bytes()
        for top, bottom in (("上だけ", ""), ("", "下だけ")):
            data = g.render_meme_png(base, top, bottom, font_path=self.font_path)
            self.assertEqual(Image.open(io.BytesIO(data)).format, "PNG")

    def test_both_texts_empty_raise(self):
        base = _image_bytes()
        with self.assertRaises(ValueError):
            g.render_meme_png(base, "", "", font_path=self.font_path)
        with self.assertRaises(ValueError):
            g.render_meme_png(base, "  ", None, font_path=self.font_path)

    def test_invalid_image_raises(self):
        with self.assertRaises(ValueError):
            g.render_meme_png(b"not an image", "上", "", font_path=self.font_path)
        with self.assertRaises(ValueError):
            g.render_meme_png(None, "上", "", font_path=self.font_path)

    def test_large_image_is_scaled_down(self):
        base = _image_bytes(size=(2400, 1800))
        data = g.render_meme_png(base, "大きい画像", "縮小される", font_path=self.font_path)
        img = Image.open(io.BytesIO(data))
        self.assertLessEqual(img.width, g.MEME_MAX_EDGE)
        self.assertLessEqual(img.height, g.MEME_MAX_EDGE)
        self.assertEqual(img.size, (1200, 900))

    def test_small_image_is_upscaled_at_most_double(self):
        base = _image_bytes(size=(100, 80))
        data = g.render_meme_png(base, "小さい", "", font_path=self.font_path)
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.size, (200, 160))

    def test_long_text_still_renders(self):
        base = _image_bytes()
        long_top = "これはとても長いテキストです" * 20
        long_bottom = "abcdefghijklmnopqrstuvwxyz" * 20
        data = g.render_meme_png(base, long_top, long_bottom, font_path=self.font_path)
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (800, 600))

    def test_text_is_truncated_to_limit(self):
        cleaned = g._miq_clean_text("あ" * 300)[: g.MEME_MAX_TEXT]
        self.assertLessEqual(len(cleaned), g.MEME_MAX_TEXT)
        data = g.render_meme_png(_image_bytes(), "あ" * 300, "", font_path=self.font_path)
        self.assertEqual(Image.open(io.BytesIO(data)).format, "PNG")

    def test_gif_uses_first_frame(self):
        frame1 = Image.new("RGB", (200, 150), (200, 60, 60))
        frame2 = Image.new("RGB", (200, 150), (60, 60, 200))
        buf = io.BytesIO()
        frame1.save(buf, "GIF", save_all=True, append_images=[frame2], duration=100, loop=0)
        data = g.render_meme_png(buf.getvalue(), "GIF", "", font_path=self.font_path)
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (400, 300))
        # 1フレーム目 (赤系) の色が残っている
        r, gg, b = img.convert("RGB").getpixel((10, 140))
        self.assertGreater(r, gg)


class MemeFontTest(unittest.TestCase):
    def test_meme_font_path_found(self):
        path = g._meme_font_path()
        self.assertIsNotNone(path)
        self.assertTrue(os.path.exists(path))


class MemeAttachmentTest(unittest.TestCase):
    class _Att:
        def __init__(self, content_type=None, filename=""):
            self.content_type = content_type
            self.filename = filename

    class _Msg:
        def __init__(self, attachments):
            self.attachments = attachments

    def test_picks_image_by_content_type(self):
        att = self._Att("image/png", "a.bin")
        self.assertIs(g._meme_image_attachment(self._Msg([att])), att)

    def test_picks_image_by_extension(self):
        att = self._Att(None, "photo.JPG")
        self.assertIs(g._meme_image_attachment(self._Msg([att])), att)

    def test_skips_non_image(self):
        att = self._Att("text/plain", "note.txt")
        self.assertIsNone(g._meme_image_attachment(self._Msg([att])))
        self.assertIsNone(g._meme_image_attachment(self._Msg([])))


class MemeRegistryTest(unittest.TestCase):
    def test_genre_and_actions_registered(self):
        self.assertIn("meme", g.GENERAL_GENRES)
        values = {value for _label, value in g.GENERAL_ACTIONS["meme"]}
        self.assertEqual(values, {"meme_create", "meme_help"})

    def test_registry_contains_meme_actions(self):
        from core import action_registry

        registry = action_registry.default_registry()
        general_ids = {spec.id for spec in registry.by_root("general")}
        self.assertIn("general:meme_create", general_ids)
        self.assertIn("general:meme_help", general_ids)

    def test_meme_create_not_in_ai_candidates(self):
        from core import ai_tools_router

        candidates = ai_tools_router.action_candidates()
        ids = {
            c["id"] if isinstance(c, dict) else getattr(c, "id", str(c))
            for c in candidates
        }
        self.assertNotIn("general:meme_create", ids)
        self.assertIn("general:meme_create", ai_tools_router.BLOCKED_ACTIONS)


if __name__ == "__main__":
    unittest.main()
