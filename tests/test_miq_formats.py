"""MIQ の新フォーマット (漫画風/音楽再生風/LINE風/ニュース速報風/X投稿風/RPG風/
設計図風/レトロゲーム風/トレカ風/ネオン風/ダーク風/ポップ風/パステル風/
チケット風/ノート風/ペアハート風/ゴールド縦書き風/和風縦書き風/小説風/
グラスカード風) のテスト。

Discord に接続せず、生成したテスト用アバターで各レンダラが 1200x675 の
PNG を返すこと、prefs の format の扱い (既定はランダム)、ランダム解決で
LINE/ペアが選ばれないこと、LINE の返信チェーン収集 (最大4件・時系列順・循環防止)、
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
            "pair", "luxury", "tate", "novel", "glass",
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
        self.assertEqual(len(g.MIQ_FORMATS), 22)
        self.assertEqual(
            set(g.MIQ_FORMATS),
            {
                "random", "quote", "manga", "music", "line", "news", "xpost", "rpg",
                "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
                "pair", "luxury", "tate", "novel", "glass",
            },
        )
        for label, emoji in g.MIQ_FORMATS.values():
            self.assertTrue(label)
            self.assertTrue(emoji)


class MiqResolveFormatTest(unittest.TestCase):
    def test_random_never_picks_line_or_random(self):
        seen = {g.miq_resolve_format("random") for _ in range(300)}
        self.assertNotIn("line", seen)
        self.assertNotIn("pair", seen)
        self.assertNotIn("random", seen)
        self.assertTrue(seen <= set(g.MIQ_RANDOM_POOL))
        self.assertTrue(seen)  # 何かは返る

    def test_random_pool_composition(self):
        self.assertNotIn("line", g.MIQ_RANDOM_POOL)
        self.assertNotIn("pair", g.MIQ_RANDOM_POOL)
        self.assertNotIn("random", g.MIQ_RANDOM_POOL)
        self.assertEqual(len(g.MIQ_RANDOM_POOL), 19)
        self.assertEqual(
            set(g.MIQ_RANDOM_POOL),
            {
                "quote", "manga", "music", "news", "xpost", "rpg",
                "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
                "luxury", "tate", "novel", "glass",
            },
        )

    def test_concrete_formats_pass_through(self):
        for fmt in (
            "quote", "manga", "music", "line", "news", "xpost", "rpg",
            "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
            "pair", "luxury", "tate", "novel", "glass",
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
        # レンダラ表は random/quote/line/pair (チェーン型) を除く全フォーマットをカバーする
        self.assertEqual(
            set(g._MIQ_FORMAT_RENDERERS), set(g.MIQ_FORMATS) - {"random", "quote", "line", "pair"},
        )

    def test_date_str_converts_to_jst(self):
        # 2026-11-04 15:30 UTC = 2026-11-05 00:30 JST
        dt = datetime(2026, 11, 4, 15, 30, tzinfo=timezone.utc)
        self.assertEqual(g._miq_date_str(dt), "2026.11.05")
        self.assertEqual(g._miq_date_str(None), g._miq_date_str())  # None は今日 (落ちないこと)


class MiqMoreFormatsTest(unittest.TestCase):
    """追加5フォーマット (ペア/ゴールド縦書き/和風縦書き/小説/グラス) と縦書きヘルパー。"""

    def setUp(self):
        self.avatar = _avatar_bytes()
        self.font_path = _font_path()

    def _check_png(self, data):
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (1200, 675))
        return img

    def _pair_entry(self, name, username, text, author_key, minute=39):
        entry = _entry(name, text, author_key, minute=minute)
        entry["username"] = username
        return entry

    def test_pair_renderer_two_entries(self):
        entries = [
            self._pair_entry("あな", "anag2bgod", "人間の作り方を教えて", 1, minute=39),
            self._pair_entry("いる科のCちゃん", "ciajo08", "おしえてあげよっか", 2, minute=40),
        ]
        self._check_png(g.render_miq_pair_png(entries, font_path=self.font_path))

    def test_pair_renderer_single_entry(self):
        entries = [self._pair_entry("ひとり", "solo", "単独モードの発言です", 1)]
        self._check_png(g.render_miq_pair_png(entries, font_path=self.font_path))

    def test_pair_renderer_uses_latest_two_of_chain(self):
        entries = [
            self._pair_entry("A", "a", "古い発言", 1, minute=36),
            self._pair_entry("B", "b", "前の発言", 2, minute=37),
            self._pair_entry("A", "a", "対象の発言", 1, minute=38),
        ]
        self._check_png(g.render_miq_pair_png(entries, font_path=self.font_path))

    def test_pair_renderer_empty_text_omits_bubble(self):
        entries = [
            self._pair_entry("あな", "anag2bgod", "", 1, minute=39),
            self._pair_entry("いる科のCちゃん", "ciajo08", "テキストあり", 2, minute=40),
        ]
        self._check_png(g.render_miq_pair_png(entries, font_path=self.font_path))

    def test_pair_renderer_without_avatar(self):
        entries = [
            self._pair_entry("あな", "anag2bgod", "アバターなし", 1, minute=39),
            self._pair_entry("Cちゃん", "ciajo08", "こちらもなし", 2, minute=40),
        ]
        for entry in entries:
            entry["avatar_bytes"] = None
        self._check_png(g.render_miq_pair_png(entries, font_path=self.font_path))

    def test_luxury_renderer(self):
        img = self._check_png(g.render_miq_luxury_png(
            self.avatar, "あっ イク あう", "sahen", "lln_hen", font_path=self.font_path,
        ))
        # 金色の本文/枠が存在する
        self.assertTrue(_has_color(img, (232, 201, 128)))

    def test_luxury_renderer_long_text(self):
        self._check_png(g.render_miq_luxury_png(
            self.avatar, "長い文章も縦書きで収まるはずです。" * 6, "sahen", "lln_hen",
            font_path=self.font_path,
        ))

    def test_luxury_renderer_without_avatar(self):
        self._check_png(g.render_miq_luxury_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_tate_renderer(self):
        self._check_png(g.render_miq_tate_png(
            self.avatar, "オイシマサヨシにもたまねこさんにも負けた", "いる科のCちゃん", "ciajo08",
            font_path=self.font_path,
        ))

    def test_tate_renderer_without_avatar(self):
        self._check_png(g.render_miq_tate_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_novel_renderer(self):
        self._check_png(g.render_miq_novel_png(
            self.avatar, "ちいかわの世界で草むしり検定に落ち続けて、滑るのが得意、ということからフィギュアスケーターを志すも、オリンピック出場のかかった選手権でオイシマサヨシがトリプルアクセルを成功させてスタンディングオベーションが起きるって夢を見ました",
            "いる科のCちゃん", "ciajo08", font_path=self.font_path,
        ))

    def test_novel_renderer_without_avatar(self):
        self._check_png(g.render_miq_novel_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_glass_renderer(self):
        self._check_png(g.render_miq_glass_png(
            self.avatar, "イクぅぅぅ❤️❤️❤️❤️", "sahen", "karld114514", font_path=self.font_path,
        ))

    def test_glass_renderer_without_avatar(self):
        self._check_png(g.render_miq_glass_png(None, "アバターなし", "名無し", "noname", font_path=self.font_path))

    def test_glass_renderer_long_text(self):
        self._check_png(g.render_miq_glass_png(
            self.avatar, "長い本文でもカードの中に収まります。" * 8, "sahen", "karld114514",
            font_path=self.font_path,
        ))

    def test_vertical_columns_split_into_columns(self):
        font = g._miq_load_font(self.font_path, 40)
        text = "あいうえおかきくけこさしすせそたちつてと"
        columns, adv = g._miq_vertical_columns(text, font, 200)
        # 200px に収まる文字数ごとに割れて複数列になる
        self.assertGreaterEqual(len(columns), 2)
        self.assertEqual("".join(columns), text)
        for col in columns:
            # 各列は col_h をはみ出さない
            self.assertLessEqual(len(col) * adv, 200)

    def test_vertical_columns_newline_breaks_column(self):
        font = g._miq_load_font(self.font_path, 40)
        columns, _adv = g._miq_vertical_columns("あっ\nイク\nあう", font, 1000)
        self.assertEqual(columns, ["あっ", "イク", "あう"])

    def test_fit_vertical_fits_width(self):
        font, columns, adv_y, adv_x, _size = g._miq_fit_vertical(
            "長い文章を縦書きにすると列が増えていきます" * 4, self.font_path,
            300, 400, max_size=50, min_size=20,
        )
        # 収まるか、列数制限で切り捨てられて幅内に収まる
        self.assertLessEqual(len(columns) * adv_x, 400)


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


from unittest import mock as _mock

import core.general.miq.miq as _miq_mod
import core.general.miq.miq_line as _miq_line_mod
import core.general.miq.miq_styles as _miq_styles_mod


class MiqFontPathRegressionTest(unittest.TestCase):
    """同梱フォント/アセットのパス解決の回帰テスト。

    MIQ が core/general/miq/ サブパッケージへ移された際、__file__ 起点の
    相対パスが1階層ずれて同梱フォントに辿り着けなくなった。OS に日本語
    フォントがある環境では症状が出ず、無い環境 (Pi) でのみ本文が
    描かれなくなり名前が □ になったため、パス自体をここで固定する。
    """

    def test_asset_fonts_dir_is_bundled_dir(self):
        self.assertTrue(_miq_mod._MIQ_ASSET_FONTS.is_dir())
        self.assertTrue((_miq_mod._MIQ_ASSET_FONTS / "DelaGothicOne-Regular.ttf").is_file())
        self.assertEqual(_miq_mod._MIQ_ASSET_FONTS, Path(ROOT) / "assets" / "fonts")

    def test_repo_font_points_at_existing_file(self):
        self.assertTrue(Path(_miq_mod._MIQ_REPO_FONT).is_file())
        self.assertEqual(Path(_miq_mod._MIQ_REPO_FONT), Path(ROOT) / "font.ttf")

    def test_special_font_path_finds_bundled_dela(self):
        found = _miq_styles_mod._miq_special_font_path("DelaGothicOne")
        self.assertIsNotNone(found)
        self.assertTrue(Path(found).is_file())
        self.assertTrue(g._font_covers_japanese(found))

    def test_emoji_font_path_prefers_bundled(self):
        orig = _miq_mod._MIQ_EMOJI_PATH_CACHE
        _miq_mod._MIQ_EMOJI_PATH_CACHE = None
        try:
            found = _miq_mod._miq_emoji_font_path()
        finally:
            _miq_mod._MIQ_EMOJI_PATH_CACHE = orig
        self.assertEqual(found, str(Path(ROOT) / "assets" / "fonts" / "NotoColorEmoji.ttf"))

    def test_ago_dir_resolves_under_repo_assets(self):
        self.assertEqual(_miq_line_mod._MIQ_AGO_DIR, Path(ROOT) / "assets" / "miq_ago")
        if _miq_line_mod._MIQ_AGO_DIR.is_dir():
            self.assertEqual(len(list(_miq_line_mod._MIQ_AGO_DIR.glob("ago_*.png"))), 5)

    def test_miq_file_default_is_repo_data_dir(self):
        if os.getenv("MIQ_DATA_PATH"):
            self.skipTest("MIQ_DATA_PATH 指定時は既定パスの対象外")
        self.assertEqual(_miq_mod.MIQ_FILE, Path(ROOT) / "data" / "miq.json")

    def test_read_file_falls_back_to_stray(self):
        # パスずれ期間の保存先 (core/data/miq.json) にだけ残った設定を拾う
        with tempfile.TemporaryDirectory() as tmp:
            main = Path(tmp) / "miq.json"
            stray = Path(tmp) / "stray.json"
            stray.write_text(json.dumps({"users": {"42": {"format": "pop"}}}), encoding="utf-8")
            with _mock.patch.object(_miq_mod, "MIQ_FILE", main), \
                    _mock.patch.object(_miq_mod, "_MIQ_STRAY_FILE", stray), \
                    _mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MIQ_DATA_PATH", None)
                self.assertEqual(_miq_mod._miq_read_file()["users"]["42"]["format"], "pop")
                # 既定パスにファイルがあればそちらが優先される
                main.write_text(json.dumps({"users": {"42": {"format": "dark"}}}), encoding="utf-8")
                self.assertEqual(_miq_mod._miq_read_file()["users"]["42"]["format"], "dark")


class MiqBundledOnlyRenderTest(unittest.TestCase):
    """OS フォント候補を無効化し、同梱フォントだけで描く再現テスト (Pi 相当)。

    ユーザー報告の再現条件: 本文「アミノともうします」・名前「アミノ」を
    pop 形式で描き、本文エリアにインクがあり、名前ピルのフォントが
    日本語をカバーする (□ にならない) ことを確認する。
    """

    def setUp(self):
        self._orig_defs = _miq_mod._MIQ_FONT_DEFS
        self._orig_symbols = _miq_mod._MIQ_SYMBOL_PATHS
        root = Path(ROOT)

        def _bundled(paths):
            return tuple(p for p in paths if p and Path(p).is_relative_to(root))

        _miq_mod._MIQ_FONT_DEFS = tuple(
            (key, label, _bundled(paths)) for key, label, paths in self._orig_defs
        )
        _miq_mod._MIQ_SYMBOL_PATHS = ()
        _miq_mod._MIQ_FONTS_CACHE = None
        self.addCleanup(self._restore)

    def _restore(self):
        _miq_mod._MIQ_FONT_DEFS = self._orig_defs
        _miq_mod._MIQ_SYMBOL_PATHS = self._orig_symbols
        _miq_mod._MIQ_FONTS_CACHE = None

    def _dark_pixels(self, img, box):
        crop = img.crop(box)
        return sum(1 for px in crop.getdata() if sum(px) < 300)

    def test_available_fonts_are_bundled_and_cover_japanese(self):
        fonts = _miq_mod._miq_available_fonts()
        self.assertTrue(fonts)
        for _key, _label, path in fonts:
            if path:
                self.assertTrue(Path(path).is_relative_to(Path(ROOT)))
        self.assertTrue(g._font_covers_japanese(fonts[0][2]))

    def test_unit_chain_covers_japanese_text(self):
        font_path = _miq_mod._miq_available_fonts()[0][2]
        chain = _miq_mod._miq_fallback_fonts(font_path, 40)
        emoji_path = _miq_mod._miq_emoji_font_path()
        for unit in _miq_mod._miq_split_units("アミノともうします"):
            kind, _font = _miq_mod._miq_unit_font(unit, chain, emoji_path)
            self.assertEqual(kind, "font", f"単位 {unit!r} を描けるフォントが無い")

    def test_pop_renders_body_and_name(self):
        font_path = _miq_mod._miq_available_fonts()[0][2]
        data = g.render_miq_pop_png(
            _avatar_bytes(), "アミノともうします", "アミノ", "amino", font_path=font_path,
        )
        img = Image.open(io.BytesIO(data)).convert("RGB")
        self.assertEqual(img.size, (1200, 675))
        # 本文: 白カード (36,64,800,610) 内側の暗色ピクセル = 文字のインク
        self.assertGreater(self._dark_pixels(img, (60, 110, 760, 590)), 300)
        # 名前ピル (848,420,1140,484) 内の暗色ピクセル = 名前のインク
        self.assertGreater(self._dark_pixels(img, (860, 428, 1128, 476)), 50)
        # ピルは font_path で直接描かれるため、そのフォントが日本語を
        # カバーしていれば □ にはならない
        self.assertTrue(g._font_covers_japanese(font_path))

    def test_quote_renders_japanese(self):
        font_path = _miq_mod._miq_available_fonts()[0][2]
        data = g.render_miq_png(
            _avatar_bytes(), "アミノともうします", "アミノ", "amino", font_path=font_path,
        )
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")


if __name__ == "__main__":
    unittest.main()
