"""Tests for embed builder extensions: image/fields/templates (feature gap #7)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist.features import embedbuilder
from tests.fake_kv_supabase import FakeKVSupabase


class ParseExtraTest(unittest.TestCase):
    def test_parse_image_thumbnail_fields(self):
        extra = embedbuilder.parse_extra_lines(
            "画像: https://example.com/a.png\n"
            "サムネ: https://example.com/b.png\n"
            "F: 見出し | 内容\n"
            "F: 横 | 並び | inline\n"
            "関係ない行"
        )
        self.assertEqual(extra["image_url"], "https://example.com/a.png")
        self.assertEqual(extra["thumbnail_url"], "https://example.com/b.png")
        self.assertEqual(len(extra["fields"]), 2)
        self.assertFalse(extra["fields"][0]["inline"])
        self.assertTrue(extra["fields"][1]["inline"])

    def test_fields_capped(self):
        text = "\n".join(f"F: h{i} | v{i}" for i in range(30))
        self.assertEqual(len(embedbuilder.parse_extra_lines(text)["fields"]), embedbuilder.MAX_FIELDS)


class BuildEmbedTest(unittest.TestCase):
    def test_build_with_image_and_fields(self):
        spec = {
            "title": "t", "description": "d", "color": 0x123456, "footer": "f",
            "image_url": "https://example.com/a.png",
            "thumbnail_url": "https://example.com/b.png",
            "fields": [{"name": "n", "value": "v", "inline": True}],
        }
        embed = embedbuilder.build_embed_from_spec(spec)
        self.assertEqual(embed.image.url, "https://example.com/a.png")
        self.assertEqual(embed.thumbnail.url, "https://example.com/b.png")
        self.assertEqual(len(embed.fields), 1)
        self.assertEqual(embed.fields[0].name, "n")

    def test_build_rejects_bad_url(self):
        spec = {"title": "t", "description": "d", "image_url": "javascript:alert(1)"}
        with self.assertRaises(ValueError):
            embedbuilder.build_embed_from_spec(spec)

    def test_build_rejects_overlong(self):
        spec = {"title": "t" * 256, "description": "d" * 4000, "footer": "f" * 2048}
        with self.assertRaises(ValueError):
            embedbuilder.build_embed_from_spec(spec)


class TemplateSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_templates_default_empty(self):
        self.assertEqual(embedbuilder.settings(1)["templates"], {})

    async def test_template_round_trip(self):
        spec = {
            "title": "お知らせ", "description": "本文", "color": 123,
            "image_url": "https://example.com/a.png",
            "fields": [{"name": "n", "value": "v", "inline": False}],
        }
        await embedbuilder.update_settings(1, embedbuilder.KEY, templates={"告知": spec})
        templates = embedbuilder.settings(1)["templates"]
        self.assertIn("告知", templates)
        self.assertEqual(templates["告知"]["title"], "お知らせ")
        self.assertEqual(templates["告知"]["fields"][0]["name"], "n")

    async def test_template_sanitized(self):
        bad = {"title": "", "description": "", "image_url": "ftp://x"}
        await embedbuilder.update_settings(1, embedbuilder.KEY, templates={"bad": bad})
        self.assertEqual(embedbuilder.settings(1)["templates"], {})


if __name__ == "__main__":
    unittest.main()
