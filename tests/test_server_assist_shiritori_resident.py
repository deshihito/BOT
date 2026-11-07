"""Tests for the resident (always-on) shiritori server-assist feature."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support import guild_settings
from core.support.storage import KVStore
from core.support.server_assist import discover_features
from core.support.server_assist.features import shiritori_resident as resident
from tests.fake_kv_supabase import FakeKVSupabase


class ApplyWordTest(unittest.TestCase):
    def setUp(self):
        self.state = resident._empty_state()

    def test_non_kana_is_ignored(self):
        for text in ("hello", "今日は暑いですね", "あ", "", "123"):
            kind, _, _ = resident.apply_word(self.state, text, 1)
            self.assertEqual(kind, "ignore", text)
        self.assertEqual(self.state["chain"], 0)

    def test_chain_start_and_continue(self):
        self.assertEqual(resident.apply_word(self.state, "りんご", 1), ("start", "", 1))
        self.assertEqual(resident.apply_word(self.state, "ごりら", 2), ("accept", "", 2))
        self.assertEqual(resident.apply_word(self.state, "らくだ", 1), ("accept", "", 3))
        self.assertEqual(self.state["best"], 3)
        self.assertEqual(self.state["players"], {"1": 2, "2": 1})

    def test_wrong_start_breaks_chain(self):
        resident.apply_word(self.state, "りんご", 1)
        kind, reason, achieved = resident.apply_word(self.state, "すし", 2)
        self.assertEqual(kind, "break")
        self.assertEqual(achieved, 1)
        self.assertIn("こ", reason)  # 判定は濁点を外した「こ」を案内する（セッション型と同一）
        self.assertEqual(self.state["chain"], 0)
        self.assertIsNone(self.state["last_word"])

    def test_n_ending_breaks_chain(self):
        resident.apply_word(self.state, "りんご", 1)
        resident.apply_word(self.state, "ごりら", 1)
        kind, reason, achieved = resident.apply_word(self.state, "らっぱん", 1)
        self.assertEqual(kind, "break")
        self.assertEqual(achieved, 2)
        self.assertIn("ん", reason)
        self.assertEqual(self.state["best"], 2)

    def test_duplicate_breaks_chain(self):
        for word in ("あいす", "すいか", "かめら", "らくだ", "だんご", "ごりら"):
            kind, _, _ = resident.apply_word(self.state, word, 1)
            self.assertEqual(kind, "accept" if word != "あいす" else "start", word)
        # 「ら」から始まり接続は正しいが、既出の「らくだ」は重複で切れる
        kind, reason, achieved = resident.apply_word(self.state, "らくだ", 1)
        self.assertEqual(kind, "break")
        self.assertIn("同じ言葉", reason)
        self.assertEqual(achieved, 6)

    def test_n_word_cannot_start(self):
        kind, reason, achieved = resident.apply_word(self.state, "らいおん", 1)
        self.assertEqual(kind, "break")
        self.assertEqual(achieved, 0)
        self.assertEqual(self.state["chain"], 0)
        self.assertEqual(self.state["breaks"], 1)

    def test_break_then_new_chain_starts_fresh(self):
        resident.apply_word(self.state, "りんご", 1)
        resident.apply_word(self.state, "すし", 1)  # break
        self.assertEqual(resident.apply_word(self.state, "しか", 2), ("start", "", 1))
        self.assertEqual(self.state["used"], ["しか"])


class FakeAuthor:
    def __init__(self, user_id=2, bot=False):
        self.id = user_id
        self.bot = bot
        self.webhook_id = None


class FakeChannel:
    def __init__(self, channel_id=10):
        self.id = channel_id
        self.send = AsyncMock()


class FakeGuild:
    def __init__(self):
        self.id = 1


class FakeMessage:
    def __init__(self, content, channel_id=10, author=None):
        self.content = content
        self.guild = FakeGuild()
        self.channel = FakeChannel(channel_id)
        self.author = author or FakeAuthor()


class ResidentSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_feature_is_discovered(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertIn("shiritori_resident", keys)

    async def _enable(self):
        state = resident._empty_state()
        await resident.update_settings(
            1, resident.KEY, enabled=True, channels={"10": state},
        )

    async def test_settings_round_trip(self):
        await self._enable()
        current = resident.settings(1)
        self.assertTrue(current["enabled"])
        self.assertIn(10, current["channels"])

    async def test_messages_flow_silently_until_break(self):
        await self._enable()
        message = FakeMessage("りんご")
        await resident.on_message(None, message)
        message.channel.send.assert_not_awaited()
        message2 = FakeMessage("ごりら")
        message2.channel = message.channel
        await resident.on_message(None, message2)
        message.channel.send.assert_not_awaited()
        saved = resident.settings(1)["channels"][10]
        self.assertEqual(saved["chain"], 2)
        self.assertEqual(saved["last_word"], "ごりら")

        breaker = FakeMessage("すし")
        breaker.channel = message.channel
        await resident.on_message(None, breaker)
        message.channel.send.assert_awaited_once()
        saved = resident.settings(1)["channels"][10]
        self.assertEqual(saved["chain"], 0)
        self.assertEqual(saved["best"], 2)

    async def test_non_kana_and_other_channels_ignored(self):
        await self._enable()
        await resident.on_message(None, FakeMessage("こんにちは、今日はいい天気ですね"))
        await resident.on_message(None, FakeMessage("りんご", channel_id=99))
        saved = resident.settings(1)["channels"][10]
        self.assertEqual(saved["chain"], 0)

    async def test_disabled_and_bot_ignored(self):
        state = resident._empty_state()
        await resident.update_settings(1, resident.KEY, enabled=False, channels={"10": state})
        await resident.on_message(None, FakeMessage("りんご"))
        self.assertEqual(resident.settings(1)["channels"][10]["chain"], 0)
        await self._enable()
        await resident.on_message(None, FakeMessage("りんご", author=FakeAuthor(bot=True)))
        self.assertEqual(resident.settings(1)["channels"][10]["chain"], 0)


if __name__ == "__main__":
    unittest.main()
