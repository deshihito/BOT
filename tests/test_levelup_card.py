"""Tests for level-up card customization (feature gap #2)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.general.exp import levelup_card
from core.support.storage import KVStore
from tests.fake_kv_supabase import FakeKVSupabase


class LevelupCardThemeTest(unittest.TestCase):
    def test_palette_fallback(self):
        self.assertIs(levelup_card.palette("bogus"), levelup_card.THEMES["default"])
        self.assertIs(levelup_card.palette(None), levelup_card.THEMES["default"])

    def test_next_theme_cycles_through_all(self):
        seen = []
        current = levelup_card.DEFAULT_THEME
        for _ in range(len(levelup_card.THEMES)):
            current = levelup_card.next_theme(current)
            seen.append(current)
        self.assertEqual(seen[-1], levelup_card.DEFAULT_THEME)
        self.assertEqual(len(set(seen)), len(levelup_card.THEMES))


class LevelupCardPrefsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = KVStore(
            "levelup_card_prefs", client=FakeKVSupabase(),
            path=os.path.join(self.tmp.name, "bot_kv.json"),
        )
        levelup_card.set_store_for_tests(self.store)
        self.addCleanup(levelup_card.set_store_for_tests, KVStore("levelup_card_prefs"))

    async def test_default_theme_without_prefs(self):
        self.assertEqual(levelup_card.get_theme(123), "default")

    async def test_set_and_get_theme_round_trip(self):
        await levelup_card.set_theme(123, "sakura")
        self.assertEqual(levelup_card.get_theme(123), "sakura")
        await levelup_card.set_theme(123, "bogus")
        self.assertEqual(levelup_card.get_theme(123), "default")

    async def test_themes_are_per_user(self):
        await levelup_card.set_theme(1, "midnight")
        await levelup_card.set_theme(2, "ocean")
        self.assertEqual(levelup_card.get_theme(1), "midnight")
        self.assertEqual(levelup_card.get_theme(2), "ocean")
        self.assertEqual(levelup_card.get_theme(3), "default")


class LevelupCardRenderThemeTest(unittest.TestCase):
    def test_render_uses_theme_palette(self):
        from cogs.general import render_levelup_card

        default_png = render_levelup_card(None, "aoi", 4, 5, 1, theme="default")
        midnight_png = render_levelup_card(None, "aoi", 4, 5, 1, theme="midnight")
        self.assertTrue(default_png.startswith(b"\x89PNG"))
        self.assertTrue(midnight_png.startswith(b"\x89PNG"))
        self.assertNotEqual(default_png, midnight_png)

    def test_render_unknown_theme_matches_default(self):
        from cogs.general import render_levelup_card

        self.assertEqual(
            render_levelup_card(None, "aoi", 4, 5, 1, theme="bogus"),
            render_levelup_card(None, "aoi", 4, 5, 1, theme="default"),
        )


if __name__ == "__main__":
    unittest.main()
