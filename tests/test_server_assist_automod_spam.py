"""Tests for the AutoMod spam (flood/duplicate) filter (feature gap #5)."""
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
from core.support.server_assist.features import automod
from tests.fake_kv_supabase import FakeKVSupabase


class SpamSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_spam_default_off(self):
        self.assertEqual(automod.settings(1)["spam_count"], 0)

    async def test_spam_round_trip_and_validation(self):
        await automod.update_settings(1, automod.KEY, spam_count=5)
        self.assertEqual(automod.settings(1)["spam_count"], 5)
        await automod.update_settings(1, automod.KEY, spam_count=4)
        self.assertEqual(automod.settings(1)["spam_count"], 0)


class DetectSpamTest(unittest.TestCase):
    def setUp(self):
        automod._spam_events.clear()
        self.addCleanup(automod._spam_events.clear)
        self.current = {"spam_count": 5}

    def test_disabled_never_triggers(self):
        for i in range(10):
            self.assertIsNone(automod.detect_spam("x", {"spam_count": 0}, 1, 7, now=100.0 + i * 0.1))

    def test_flood_triggers_at_limit(self):
        for i in range(4):
            self.assertIsNone(automod.detect_spam(f"msg{i}", self.current, 1, 7, now=100.0 + i))
        reason = automod.detect_spam("msg4", self.current, 1, 7, now=104.0)
        self.assertIsNotNone(reason)
        self.assertIn("連投", reason)

    def test_flood_window_expires(self):
        for i in range(4):
            automod.detect_spam(f"msg{i}", self.current, 1, 7, now=100.0 + i)
        # 11秒後には窓の外
        self.assertIsNone(automod.detect_spam("msg", self.current, 1, 7, now=111.0))

    def test_duplicate_triggers(self):
        self.assertIsNone(automod.detect_spam("同じ文", self.current, 1, 7, now=100.0))
        self.assertIsNone(automod.detect_spam("同じ文", self.current, 1, 7, now=120.0))
        reason = automod.detect_spam("同じ文", self.current, 1, 7, now=140.0)
        self.assertIsNotNone(reason)
        self.assertIn("重複", reason)

    def test_users_and_guilds_are_isolated(self):
        for i in range(4):
            automod.detect_spam(f"m{i}", self.current, 1, 7, now=100.0 + i)
        self.assertIsNone(automod.detect_spam("m", self.current, 1, 8, now=104.0))
        self.assertIsNone(automod.detect_spam("m", self.current, 2, 7, now=104.0))

    def test_empty_content_not_duplicate(self):
        for i in range(4):
            self.assertIsNone(automod.detect_spam("", self.current, 1, 7, now=100.0 + i * 20))


if __name__ == "__main__":
    unittest.main()
