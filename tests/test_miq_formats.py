"""MIQ の新フォーマット (漫画風/音楽再生風/LINE風) のテスト。

Discord に接続せず、生成したテスト用アバターで各レンダラが 1200x675 の
PNG を返すこと、prefs の format の扱い、LINE の返信チェーン収集
(最大4件・時系列順・循環防止) を確認する。
"""
import asyncio
import io
import json
import os
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

    def test_default_format_is_quote(self):
        prefs = g.miq_get_prefs(111)
        self.assertEqual(prefs["format"], "quote")

    def test_invalid_format_falls_back_to_quote(self):
        g.MIQ_FILE.write_text(
            json.dumps({"users": {"222": {"format": "bogus-format"}}}), encoding="utf-8",
        )
        g._MIQ_DATA = None
        self.assertEqual(g.miq_get_prefs(222)["format"], "quote")

    def test_format_roundtrip(self):
        prefs = g.miq_get_prefs(333)
        prefs["format"] = "line"
        self.assertTrue(asyncio.run(g.miq_save_prefs(333, prefs)))
        g._MIQ_DATA = None  # ファイルから読み直す
        self.assertEqual(g.miq_get_prefs(333)["format"], "line")

    def test_each_format_roundtrips(self):
        for i, fmt in enumerate(("quote", "manga", "music", "line")):
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
        self.assertEqual(set(g.MIQ_FORMATS), {"quote", "manga", "music", "line"})
        for label, emoji in g.MIQ_FORMATS.values():
            self.assertTrue(label)
            self.assertTrue(emoji)


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
