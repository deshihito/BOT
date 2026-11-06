"""Tests for the AutoMod cross-channel / raid (copypasta) detections."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import guild_settings
from core.storage import KVStore
from core.support.server_assist.features import automod
from tests.fake_kv_supabase import FakeKVSupabase

TEXT = "raid copypasta text"


class CrossSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_defaults_off(self):
        current = automod.settings(1)
        self.assertEqual(current["cross_count"], 0)
        self.assertEqual(current["raid_users"], 0)

    async def test_round_trip_and_validation(self):
        await automod.update_settings(1, automod.KEY, cross_count=5, raid_users=10)
        current = automod.settings(1)
        self.assertEqual(current["cross_count"], 5)
        self.assertEqual(current["raid_users"], 10)
        await automod.update_settings(1, automod.KEY, cross_count=4, raid_users=7)
        current = automod.settings(1)
        self.assertEqual(current["cross_count"], 0)
        self.assertEqual(current["raid_users"], 0)


class DetectCrossSpamTest(unittest.TestCase):
    def setUp(self):
        automod._cross_events.clear()
        self.addCleanup(automod._cross_events.clear)
        self.current = {"cross_count": 3, "raid_users": 0}

    def test_disabled_never_triggers(self):
        off = {"cross_count": 0, "raid_users": 0}
        for i in range(6):
            self.assertIsNone(automod.detect_cross_spam(TEXT, off, 1, 7, 100 + i % 3, now=100.0 + i))

    def test_same_channel_only_does_not_trigger_cross(self):
        for i in range(3):
            reason = automod.detect_cross_spam(TEXT, self.current, 1, 7, 100, now=100.0 + i)
        self.assertIsNone(reason)

    def test_cross_channel_triggers_at_limit(self):
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 7, 100, now=100.0))
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 7, 200, now=101.0))
        reason = automod.detect_cross_spam(TEXT, self.current, 1, 7, 300, now=102.0)
        self.assertIsNotNone(reason)
        self.assertIn("横断連投", reason)

    def test_short_text_ignored(self):
        for i, ch in enumerate((100, 200, 300, 400)):
            self.assertIsNone(automod.detect_cross_spam("spam", self.current, 1, 7, ch, now=100.0 + i))

    def test_window_expires(self):
        automod.detect_cross_spam(TEXT, self.current, 1, 7, 100, now=100.0)
        automod.detect_cross_spam(TEXT, self.current, 1, 7, 200, now=101.0)
        # 61秒後: 窓の外なので3件に届かない
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 7, 300, now=162.0))

    def test_normalization_unifies_variants(self):
        self.assertIsNone(automod.detect_cross_spam("Raid   Copypasta TEXT", self.current, 1, 7, 100, now=100.0))
        self.assertIsNone(automod.detect_cross_spam("raid copypasta text", self.current, 1, 7, 200, now=101.0))
        self.assertIsNotNone(automod.detect_cross_spam("RAID COPYPASTA TEXT", self.current, 1, 7, 300, now=102.0))

    def test_trigger_clears_state(self):
        for i, ch in enumerate((100, 200, 300)):
            automod.detect_cross_spam(TEXT, self.current, 1, 7, ch, now=100.0 + i)
        # 発火後はクリアされるので、次の1件では発火しない
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 7, 100, now=103.0))

    def test_guilds_are_isolated(self):
        # 両ギルドで2件ずつ投稿しても合算されず、どちらも発火しない
        for guild in (1, 2):
            self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, guild, 7, 100, now=100.0))
            self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, guild, 7, 200, now=101.0))
        # ギルド1の3件目 (3チャンネル目) で初めて発火する
        self.assertIsNotNone(automod.detect_cross_spam(TEXT, self.current, 1, 7, 300, now=102.0))


class DetectRaidTest(unittest.TestCase):
    def setUp(self):
        automod._cross_events.clear()
        self.addCleanup(automod._cross_events.clear)
        self.current = {"cross_count": 0, "raid_users": 3}

    def test_distinct_users_trigger(self):
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 11, 100, now=100.0))
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 12, 100, now=101.0))
        reason = automod.detect_cross_spam(TEXT, self.current, 1, 13, 200, now=102.0)
        self.assertIsNotNone(reason)
        self.assertIn("コピペ荒らし", reason)

    def test_same_user_repeats_do_not_count_as_raid(self):
        for i in range(4):
            self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 11, 100, now=100.0 + i))

    def test_different_texts_do_not_combine(self):
        automod.detect_cross_spam(TEXT, self.current, 1, 11, 100, now=100.0)
        automod.detect_cross_spam("another copypasta here", self.current, 1, 12, 100, now=101.0)
        self.assertIsNone(automod.detect_cross_spam(TEXT, self.current, 1, 13, 100, now=102.0))


if __name__ == "__main__":
    unittest.main()
