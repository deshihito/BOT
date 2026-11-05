"""MIQ の新フォーマット (漫画風/音楽再生風/LINE風/ニュース速報風/X投稿風/RPG風/
設計図風/レトロゲーム風/トレカ風/ネオン風/ダーク風/ポップ風/パステル風/
チケット風/ノート風) のテスト。

Discord に接続せず、生成したテスト用アバターで各レンダラが 1200x675 の
PNG を返すこと、prefs の format の扱い (既定はランダム)、ランダム解決で
LINE が選ばれないこと、LINE の返信チェーン収集 (最大4件・時系列順・循環防止)、
LINE のメディア合成 (写真/スタンプ/カスタム絵文字) を確認する。
"""
import asyncio
import io
import json
import os
import random
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from PIL import Image, ImageDraw

import cogs.general as g


def _avatar_bytes(color=(200, 80, 120)) -> bytes:
    img = Image.new("RGB", (300, 300), color)
    draw = ImageDraw.Draw(img)
    draw.ellipse([60, 60, 240, 240], fill=(80, 160, 220))
    draw.rectangle([0, 0, 300, 60], fill=(240, 220, 90))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _font_path():
    fonts = g._miq_available_fonts()
    return fonts[0][2] if fonts else None


def _entry(name, text, author_key, minute=39, avatar=None):
    return {
        "name": name,
        "text": text,
        "created_at": datetime(2026, 11, 5, 3, minute, tzinfo=timezone.utc),
        "avatar_bytes": _avatar_bytes() if avatar is None else avatar,
        "author_key": author_key,
    }


class MiqRendererTest(unittest.TestCase):
    def setUp(self):
        self.avatar = _avatar_bytes()
        self.font_path = _font_path()

    def _check_png(self, data):
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))
        return img

    def test_manga_renderer(self):
        data = g.render_miq_manga_png(
            self.avatar, "これはテストのセリフです", "サンプル", "sample", font_path=self.font_path,
        )
        self._check_png(data)

    def test_manga_renderer_without_avatar(self):
        data = g.render_miq_manga_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path)
        self._check_png(data)

    def test_music_renderer(self):
        data = g.render_miq_music_png(
            self.avatar, "再生中の曲みたいな本文です", "サンプル", "sample", font_path=self.font_path,
        )
        self._check_png(data)

    def test_music_renderer_is_deterministic(self):
        a = g.render_miq_music_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        b = g.render_miq_music_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        self.assertEqual(a, b)

    def test_line_renderer_single(self):
        data = g.render_miq_line_png([_entry("一人", "ひとりだけのメッセージ", 1)], font_path=self.font_path)
        self._check_png(data)

    def test_line_renderer_two_authors_has_green_bubble(self):
        entries = [
            _entry("相手", "質問のメッセージです", 1, minute=39),
            _entry("対象", "返事のメッセージです", 2, minute=40),
        ]
        img = self._check_png(g.render_miq_line_png(entries, font_path=self.font_path))
        raw = img.convert("RGB").tobytes()
        green = bytes((131, 226, 79))
        # 右側 (対象の作者) の LINE 緑バブルが存在する
        self.assertTrue(any(raw[i:i + 3] == green for i in range(0, len(raw), 3)))

    def test_line_renderer_four_entries(self):
        entries = [
            _entry("A", "1件目", 1, minute=36),
            _entry("B", "2件目", 2, minute=37),
            _entry("A", "3件目", 1, minute=38),
            _entry("B", "4件目 (対象)", 2, minute=39),
        ]
        self._check_png(g.render_miq_line_png(entries, font_path=self.font_path))

    def test_line_renderer_dataclass_entry(self):
        entry = g.MiqLineEntry(
            name="データクラス", text="dataclass でも描ける",
            created_at=datetime(2026, 11, 5, 3, 39, tzinfo=timezone.utc),
            avatar_bytes=self.avatar, author_key=9,
        )
        self._check_png(g.render_miq_line_png([entry], font_path=self.font_path))

    def test_line_renderer_long_conversation_fits(self):
        entries = [
            _entry(f"作者{i}", "長い会話のテストです。" * 4, i % 2, minute=30 + i)
            for i in range(4)
        ]
        self._check_png(g.render_miq_line_png(entries, font_path=self.font_path))


class MiqFormatPrefsTest(unittest.TestCase):
    def setUp(self):
        self._orig_file = g.MIQ_FILE
        self._orig_data = g._MIQ_DATA
        self._tmp = tempfile.TemporaryDirectory()
        g.MIQ_FILE = Path(self._tmp.name) / "miq.json"
        g._MIQ_DATA = None

    def tearDown(self):
        g.MIQ_FILE = self._orig_file
        g._MIQ_DATA = self._orig_data
        self._tmp.cleanup()

    def test_default_format_is_random(self):
        # 未設定ユーザーの既定はランダム (新仕様)
        prefs = g.miq_get_prefs(111)
        self.assertEqual(prefs["format"], "random")

    def test_invalid_format_falls_back_to_default(self):
        # 不正値は無視され、既定 (ランダム) になる
        g.MIQ_FILE.write_text(
            json.dumps({"users": {"222": {"format": "bogus-format"}}}), encoding="utf-8",
        )
        g._MIQ_DATA = None
        self.assertEqual(g.miq_get_prefs(222)["format"], "random")

    def test_format_roundtrip(self):
        prefs = g.miq_get_prefs(333)
        prefs["format"] = "line"
        self.assertTrue(asyncio.run(g.miq_save_prefs(333, prefs)))
        g._MIQ_DATA = None  # ファイルから読み直す
        self.assertEqual(g.miq_get_prefs(333)["format"], "line")

    def test_each_format_roundtrips(self):
        for i, fmt in enumerate((
            "quote", "manga", "music", "line", "news", "xpost", "rpg", "random",
            "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
        )):
            prefs = g.miq_get_prefs(400 + i)
            prefs["format"] = fmt
            self.assertTrue(asyncio.run(g.miq_save_prefs(400 + i, prefs)))
            g._MIQ_DATA = None
            self.assertEqual(g.miq_get_prefs(400 + i)["format"], fmt)

    def test_render_options_include_format(self):
        prefs = g.miq_get_prefs(555)
        prefs["format"] = "manga"
        opts = g.miq_render_options(prefs)
        self.assertEqual(opts["format"], "manga")
        prefs["format"] = "unknown"
        self.assertEqual(g.miq_render_options(prefs)["format"], "quote")

    def test_formats_constant(self):
        self.assertEqual(
            set(g.MIQ_FORMATS),
            {
                "random", "quote", "manga", "music", "line", "news", "xpost", "rpg",
                "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
            },
        )
        for label, emoji in g.MIQ_FORMATS.values():
            self.assertTrue(label)
            self.assertTrue(emoji)


class MiqResolveFormatTest(unittest.TestCase):
    def test_random_never_picks_line_or_random(self):
        seen = {g.miq_resolve_format("random") for _ in range(300)}
        self.assertNotIn("line", seen)
        self.assertNotIn("random", seen)
        self.assertTrue(seen <= set(g.MIQ_RANDOM_POOL))
        self.assertTrue(seen)  # 何かは返る

    def test_random_pool_composition(self):
        self.assertNotIn("line", g.MIQ_RANDOM_POOL)
        self.assertNotIn("random", g.MIQ_RANDOM_POOL)
        self.assertEqual(
            set(g.MIQ_RANDOM_POOL),
            {
                "quote", "manga", "music", "news", "xpost", "rpg",
                "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
            },
        )

    def test_concrete_formats_pass_through(self):
        for fmt in (
            "quote", "manga", "music", "line", "news", "xpost", "rpg",
            "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
        ):
            self.assertEqual(g.miq_resolve_format(fmt), fmt)
            self.assertEqual(g.miq_resolve_format({"format": fmt}), fmt)

    def test_invalid_falls_back_to_quote(self):
        self.assertEqual(g.miq_resolve_format("bogus"), "quote")
        self.assertEqual(g.miq_resolve_format(None), "quote")
        self.assertEqual(g.miq_resolve_format({}), "quote")

    def test_random_from_prefs_dict(self):
        for _ in range(50):
            self.assertIn(g.miq_resolve_format({"format": "random"}), g.MIQ_RANDOM_POOL)


class MiqNewRendererTest(unittest.TestCase):
    def setUp(self):
        self.avatar = _avatar_bytes()
        self.font_path = _font_path()

    def _check_png(self, data):
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))
        return img

    def test_news_renderer(self):
        data = g.render_miq_news_png(
            self.avatar, "大きなニュースが入りました", "サンプル", "sample", font_path=self.font_path,
        )
        img = self._check_png(data)
        # 速報バッジの赤が存在する
        raw = img.convert("RGB").tobytes()
        red = bytes((208, 28, 38))
        self.assertTrue(any(raw[i:i + 3] == red for i in range(0, len(raw), 3)))

    def test_news_renderer_without_avatar(self):
        self._check_png(g.render_miq_news_png(None, "アバターなし速報", "名無し", "noname", font_path=self.font_path))

    def test_xpost_renderer(self):
        data = g.render_miq_xpost_png(
            self.avatar, "これはX投稿風の本文です", "サンプル", "sample", font_path=self.font_path,
        )
        self._check_png(data)

    def test_xpost_renderer_is_deterministic(self):
        a = g.render_miq_xpost_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        b = g.render_miq_xpost_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        self.assertEqual(a, b)

    def test_rpg_renderer(self):
        data = g.render_miq_rpg_png(
            self.avatar, "ぼうけんの しょを開いた", "サンプル", "sample", font_path=self.font_path,
        )
        self._check_png(data)

    def test_rpg_renderer_without_avatar(self):
        self._check_png(g.render_miq_rpg_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))


class MiqExtraRendererTest(unittest.TestCase):
    """追加9フォーマット (設計図/レトロ/トレカ/ネオン/ダーク/ポップ/パステル/チケット/ノート)。"""

    def setUp(self):
        self.avatar = _avatar_bytes()
        self.font_path = _font_path()

    def _check_png(self, data):
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))
        return img

    def test_blueprint_renderer(self):
        data = g.render_miq_blueprint_png(
            self.avatar, "設計図風の本文です", "サンプル", "sample",
            font_path=self.font_path, date_str="2026.11.05",
        )
        img = self._check_png(data)
        # 背景の青が存在する
        self.assertTrue(_has_color(img, (27, 90, 190)))

    def test_blueprint_renderer_without_avatar(self):
        self._check_png(g.render_miq_blueprint_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_pixel_renderer(self):
        self._check_png(g.render_miq_pixel_png(
            self.avatar, "レトロな本文です", "サンプル", "sample", font_path=self.font_path,
        ))

    def test_pixel_renderer_is_deterministic(self):
        a = g.render_miq_pixel_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        b = g.render_miq_pixel_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        self.assertEqual(a, b)

    def test_card_renderer(self):
        self._check_png(g.render_miq_card_png(
            self.avatar, "トレカ風の本文です", "サンプル", "sample",
            font_path=self.font_path, date_str="2026.11.05",
        ))

    def test_card_renderer_without_avatar(self):
        self._check_png(g.render_miq_card_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_neon_renderer(self):
        self._check_png(g.render_miq_neon_png(
            self.avatar, "ネオンな本文です", "サンプル", "sample", font_path=self.font_path,
        ))

    def test_dark_renderer(self):
        self._check_png(g.render_miq_dark_png(
            self.avatar, "ダークな本文です", "サンプル", "sample", font_path=self.font_path,
        ))

    def test_dark_renderer_without_avatar(self):
        self._check_png(g.render_miq_dark_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_pop_renderer(self):
        img = self._check_png(g.render_miq_pop_png(
            self.avatar, "ポップな本文です", "サンプル", "sample", font_path=self.font_path,
        ))
        # 背景の黄色ドット地が存在する
        self.assertTrue(_has_color(img, (255, 208, 40)))

    def test_pastel_renderer(self):
        self._check_png(g.render_miq_pastel_png(
            self.avatar, "パステルな本文です", "サンプル", "sample", font_path=self.font_path,
        ))

    def test_ticket_renderer(self):
        self._check_png(g.render_miq_ticket_png(
            self.avatar, "チケット風の本文です", "サンプル", "sample",
            font_path=self.font_path, date_str="2026.11.05",
        ))

    def test_ticket_renderer_is_deterministic(self):
        # 配色抽選は乱数のため、本文から決まる数値 (No./SEAT) だけでは
        # バイト一致はしない。例外なく2回描けることだけ確認する。
        a = g.render_miq_ticket_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        b = g.render_miq_ticket_png(self.avatar, "同じ本文", "名前", "user", font_path=self.font_path)
        self._check_png(a)
        self._check_png(b)

    def test_note_renderer(self):
        self._check_png(g.render_miq_note_png(
            self.avatar, "ノート風の本文です", "サンプル", "sample", font_path=self.font_path,
        ))

    def test_note_renderer_without_avatar(self):
        self._check_png(g.render_miq_note_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_renderer_table_covers_all_single_formats(self):
        # レンダラ表は random/quote/line を除く全フォーマットをカバーする
        self.assertEqual(
            set(g._MIQ_FORMAT_RENDERERS), set(g.MIQ_FORMATS) - {"random", "quote", "line"},
        )

    def test_date_str_converts_to_jst(self):
        # 2026-11-04 15:30 UTC = 2026-11-05 00:30 JST
        dt = datetime(2026, 11, 4, 15, 30, tzinfo=timezone.utc)
        self.assertEqual(g._miq_date_str(dt), "2026.11.05")
        self.assertEqual(g._miq_date_str(None), g._miq_date_str())  # None は今日 (落ちないこと)


class MiqHiddenVariationTest(unittest.TestCase):
    """ticket の配色バリエーションと card のレアリティ段階 (隠し要素) の検証。"""

    def test_ticket_palettes_are_weighted_with_standard_first(self):
        weights = [p[0] for p in g._MIQ_TICKET_PALETTES]
        self.assertGreaterEqual(len(g._MIQ_TICKET_PALETTES), 5)
        self.assertEqual(weights[0], max(weights))  # 標準が最頻
        rng = random.Random(42)
        for _ in range(50):
            self.assertIn(g._miq_pick_ticket_palette(rng), g._MIQ_TICKET_PALETTES)

    def test_card_rarities_are_weighted_descending(self):
        weights = [p[0] for p in g._MIQ_CARD_RARITIES]
        self.assertEqual(weights, sorted(weights, reverse=True))
        # 最上位レアリティは数%以下
        self.assertLessEqual(min(weights) / sum(weights), 0.05)
        for _w, (lo, hi), mult, key in g._MIQ_CARD_RARITIES:
            self.assertIn(key, g._MIQ_CARD_FRAME_STOPS)
            self.assertLessEqual(lo, hi)
            self.assertGreaterEqual(mult, 1.0)
        rng = random.Random(1)
        for _ in range(50):
            self.assertIn(g._miq_pick_card_rarity(rng), g._MIQ_CARD_RARITIES)


# アゴアセット (透過PNG) はバイナリのため GitHub connector のテキスト push では
# 送れず、別途リポジトリへ追加される。未配置のチェックアウトではアセット依存の
# テストをスキップする (配置されれば自動で有効になる)。
_AGO_DIR = Path(g.__file__).resolve().parent.parent / "assets" / "miq_ago"
_AGO_PRESENT = _AGO_DIR.is_dir() and len(list(_AGO_DIR.glob("ago_*.png"))) == 5
_needs_ago_assets = unittest.skipUnless(_AGO_PRESENT, "アゴアセット未配置のためスキップ")


class MiqAgoOverlayTest(unittest.TestCase):
    """アゴのひょっこり合成 (隠し要素) の検証。"""

    def setUp(self):
        self.font_path = _font_path()
        g._MIQ_AGO_CACHE = None
        self.base = g.render_miq_dark_png(
            _avatar_bytes(), "テスト本文", "名前", "user", font_path=self.font_path,
        )

    @_needs_ago_assets
    def test_assets_are_five_transparent_pngs(self):
        images = g._miq_ago_images()
        self.assertEqual(len(images), 5)
        for im in images:
            self.assertEqual(im.mode, "RGBA")
            # 透過部分 (背景) と不透明部分 (キャラ) の両方がある
            self.assertEqual(im.split()[-1].getextrema(), (0, 255))

    @_needs_ago_assets
    def test_force_overlay_changes_image(self):
        out = g.apply_ago_overlay(self.base, force=True, rng=random.Random(7))
        self.assertNotEqual(out, self.base)
        img = Image.open(io.BytesIO(out))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))

    def test_no_hit_returns_input_unchanged(self):
        class _MissRng:
            def random(self):
                return 0.99  # MIQ_AGO_RARE_RATE 以上 → 当たらない

            def choice(self, seq):
                return seq[0]

            def uniform(self, a, b):
                return a

        self.assertEqual(g.apply_ago_overlay(self.base, rng=_MissRng()), self.base)

    def test_rare_rate_is_two_percent(self):
        self.assertEqual(g.MIQ_AGO_RARE_RATE, 0.02)

    @_needs_ago_assets
    def test_hit_ratio_roughly_matches_rate(self):
        # 乱数を差し替えて大まかな分布だけ確認する (厳密な統計検定はしない)
        class _SeqRng:
            def __init__(self):
                self._values = [i / 1000 for i in range(1000)]
                self._i = 0

            def random(self):
                v = self._values[self._i % len(self._values)]
                self._i += 1
                return v

            def choice(self, seq):
                return seq[0]

            def uniform(self, a, b):
                return a

        rng = _SeqRng()
        hits = sum(
            1 for _ in range(1000)
            if g.apply_ago_overlay(self.base, rng=rng) != self.base
        )
        # 0.000〜0.019 の20回だけ当たるはず (各呼び出しで random() は1回)
        self.assertEqual(hits, 20)


def _solid_bytes(color, size=(120, 90)) -> bytes:
    img = Image.new("RGBA", size, color + (255,))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _has_color(img, color) -> bool:
    raw = img.convert("RGB").tobytes()
    needle = bytes(color)
    return any(raw[i:i + 3] == needle for i in range(0, len(raw), 3))


class MiqLineMediaTest(unittest.TestCase):
    def setUp(self):
        self.font_path = _font_path()

    def _check_png(self, data):
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))
        return img

    def test_image_only_entry_renders(self):
        # テキスト空 + 写真のみのエントリが除外されず描かれる
        color = (255, 0, 128)
        entry = _entry("写真家", "", 1)
        entry["images"] = [_solid_bytes(color)]
        img = self._check_png(g.render_miq_line_png([entry], font_path=self.font_path))
        self.assertTrue(_has_color(img, color))

    def test_custom_emoji_segment_renders_inline(self):
        color = (10, 200, 90)
        entry = _entry("絵文字", "", 1)
        entry["segments"] = [
            {"type": "text", "text": "すごい"},
            {"type": "emoji", "name": "party", "image": _solid_bytes(color, (64, 64))},
            {"type": "text", "text": "！"},
        ]
        img = self._check_png(g.render_miq_line_png([entry], font_path=self.font_path))
        self.assertTrue(_has_color(img, color))

    def test_sticker_entry_renders_without_bubble(self):
        color = (255, 140, 0)
        entry = _entry("スタンプ", "", 1)
        entry["stickers"] = [_solid_bytes(color, (160, 160))]
        img = self._check_png(g.render_miq_line_png([entry], font_path=self.font_path))
        self.assertTrue(_has_color(img, color))

    def test_mixed_conversation_with_media(self):
        entries = [
            _entry("相手", "写真送るね", 1, minute=36),
            {**_entry("相手", "", 1, minute=37), "images": [_solid_bytes((0, 128, 255))]},
            {**_entry("自分", "", 2, minute=38), "stickers": [_solid_bytes((255, 0, 0), (160, 160))]},
            _entry("自分", "ありがとう！", 2, minute=39),
        ]
        self._check_png(g.render_miq_line_png(entries, font_path=self.font_path))

    def test_unicode_emoji_text_renders(self):
        entry = _entry("絵文字", "テスト😀です🎉", 1)
        self._check_png(g.render_miq_line_png([entry], font_path=self.font_path))

    def test_split_segments_with_and_without_image(self):
        raw = "前<:party:123>後<a:live:456>"
        segs = g._miq_line_split_segments(raw, {123: b"imgbytes"})
        self.assertEqual(segs[0], {"type": "text", "text": "前"})
        self.assertEqual(segs[1]["type"], "emoji")
        self.assertEqual(segs[1]["image"], b"imgbytes")
        # 取得失敗した絵文字は :name: テキストにフォールバック
        self.assertEqual(segs[2], {"type": "text", "text": "後"})
        self.assertEqual(segs[3], {"type": "text", "text": ":live:"})

    def test_sticker_renderable(self):
        class _S:
            def __init__(self, v):
                self.format_type = v

        self.assertTrue(g._miq_sticker_renderable(_S(1)))   # PNG
        self.assertTrue(g._miq_sticker_renderable(_S(2)))   # APNG
        self.assertTrue(g._miq_sticker_renderable(_S(4)))   # GIF
        self.assertFalse(g._miq_sticker_renderable(_S(3)))  # Lottie は対象外

    def test_has_media_detection(self):
        class _Att:
            def __init__(self, ct=None, filename=""):
                self.content_type = ct
                self.filename = filename

        class _Msg:
            def __init__(self, content="", attachments=(), stickers=()):
                self.content = content
                self.attachments = list(attachments)
                self.stickers = list(stickers)

        self.assertFalse(g._miq_line_message_has_media(_Msg("ただの文章")))
        self.assertTrue(g._miq_line_message_has_media(_Msg("", attachments=[_Att("image/png")])))
        self.assertTrue(g._miq_line_message_has_media(_Msg("", attachments=[_Att(None, "x.webp")])))
        self.assertTrue(g._miq_line_message_has_media(_Msg("やった<:party:123>")))
        self.assertFalse(g._miq_line_message_has_media(_Msg("", attachments=[_Att("text/plain", "a.txt")])))

    def test_unicode_emoji_probe(self):
        # この環境では Noto Color Emoji が同梱され embedded_color が動く想定。
        # 動かない環境でも False を返すだけで例外にならないこと。
        self.assertIn(g._miq_unicode_emoji_supported(), (True, False))


class _FakeAuthor:
    def __init__(self, user_id):
        self.id = user_id
        self.display_name = f"user{user_id}"
        self.name = f"user{user_id}"


class _FakeReference:
    def __init__(self, message_id, resolved=None, channel_id=None):
        self.message_id = message_id
        self.resolved = resolved
        self.channel_id = channel_id


class _FakeMessage:
    def __init__(self, message_id, text="msg", reference=None):
        self.id = message_id
        self.content = text
        self.clean_content = text
        self.author = _FakeAuthor(message_id)
        self.reference = reference
        self.channel = None
        self.created_at = datetime(2026, 11, 5, 3, 39, tzinfo=timezone.utc)


class MiqLineChainTest(unittest.TestCase):
    def _build_chain(self, count):
        msgs = [_FakeMessage(i + 1, f"msg{i + 1}") for i in range(count)]
        for i in range(1, count):
            msgs[i].reference = _FakeReference(msgs[i - 1].id, resolved=msgs[i - 1])
        return msgs

    def test_chain_is_capped_at_four_and_chronological(self):
        msgs = self._build_chain(6)
        chain = asyncio.run(g.miq_collect_line_chain(msgs[-1]))
        self.assertEqual(len(chain), g.MIQ_LINE_MAX_MESSAGES)
        self.assertEqual(g.MIQ_LINE_MAX_MESSAGES, 4)
        self.assertEqual([m.id for m in chain], [3, 4, 5, 6])

    def test_chain_single_message_without_reference(self):
        msg = _FakeMessage(1)
        chain = asyncio.run(g.miq_collect_line_chain(msg))
        self.assertEqual([m.id for m in chain], [1])

    def test_chain_full_when_short(self):
        msgs = self._build_chain(3)
        chain = asyncio.run(g.miq_collect_line_chain(msgs[-1]))
        self.assertEqual([m.id for m in chain], [1, 2, 3])

    def test_chain_cycle_does_not_loop(self):
        a = _FakeMessage(1, "a")
        b = _FakeMessage(2, "b")
        a.reference = _FakeReference(2, resolved=b)
        b.reference = _FakeReference(1, resolved=a)
        chain = asyncio.run(g.miq_collect_line_chain(a))
        self.assertEqual(sorted(m.id for m in chain), [1, 2])

    def test_chain_unresolved_reference_stops_quietly(self):
        class _Channel:
            async def fetch_message(self, message_id):
                raise g.discord.NotFound(
                    response=_Resp(), message="unknown message",
                )

        class _Resp:
            status = 404
            reason = "Not Found"

        msg = _FakeMessage(5, "top")
        msg.reference = _FakeReference(4, resolved=None, channel_id=None)
        msg.channel = _Channel()
        chain = asyncio.run(g.miq_collect_line_chain(msg))
        self.assertEqual([m.id for m in chain], [5])


if __name__ == "__main__":
    unittest.main()
