# -*- coding: utf-8 -*-
"""24/7 ラジオ（core/vc/radio.py）のテスト。

局リストの健全性・設定の正規化・セッション管理の自動退出免除・
パネルの構築・開始/停止の流れを、実ネットワークなし（フェイク）で検証する。
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.support import guild_settings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from core.vc import radio as radio_mod  # noqa: E402
from core.vc.radio import (  # noqa: E402
    DEFAULT_STATION, STATIONS, STATION_BY_ID, RadioCog, RadioPanelView,
    clean_radio_settings, radio_settings, save_radio_settings,
)
from core.vc.voice_session import VoiceSession, VoiceSessionManager  # noqa: E402


def use_temp_settings(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    guild_settings.set_store(guild_settings.GuildSettings(
        KVStore("guild_settings", client=None,
                path=os.path.join(tmp.name, "kv.json"))))
    test.addCleanup(guild_settings.set_store, None)


class StationListTest(unittest.TestCase):
    def test_ids_unique_and_default_exists(self):
        ids = [s.id for s in STATIONS]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn(DEFAULT_STATION, STATION_BY_ID)

    def test_urls_are_https_streams(self):
        for station in STATIONS:
            self.assertTrue(station.url.startswith("https://"), station.id)
            self.assertTrue(station.name)
            self.assertTrue(station.desc)


class CleanSettingsTest(unittest.TestCase):
    def test_defaults(self):
        cfg = clean_radio_settings(None)
        self.assertEqual(cfg, {"station": DEFAULT_STATION, "channel_id": None,
                               "always_on": False, "playing": False})
        self.assertEqual(clean_radio_settings({}), cfg)

    def test_invalid_values_fall_back(self):
        cfg = clean_radio_settings({"station": "nope", "channel_id": -5,
                                    "always_on": 1, "playing": 0})
        self.assertEqual(cfg["station"], DEFAULT_STATION)
        self.assertIsNone(cfg["channel_id"])
        self.assertTrue(cfg["always_on"])
        self.assertFalse(cfg["playing"])

    def test_valid_values_kept(self):
        cfg = clean_radio_settings({"station": "lush", "channel_id": 123,
                                    "always_on": True, "playing": True})
        self.assertEqual(cfg["station"], "lush")
        self.assertEqual(cfg["channel_id"], 123)
        self.assertTrue(cfg["always_on"])
        self.assertTrue(cfg["playing"])


class SettingsRoundtripTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)

    async def test_save_and_read(self):
        await save_radio_settings(42, station="lush", channel_id=777,
                                  always_on=True, playing=True)
        cfg = radio_settings(42)
        self.assertEqual(cfg["station"], "lush")
        self.assertEqual(cfg["channel_id"], 777)
        self.assertTrue(cfg["always_on"])
        self.assertTrue(cfg["playing"])

    async def test_other_guild_unaffected(self):
        await save_radio_settings(42, station="lush")
        self.assertEqual(radio_settings(43)["station"], DEFAULT_STATION)


class FakeChannel:
    def __init__(self, guild, channel_id=10):
        self.guild = guild
        self.id = channel_id
        self.members = []
        self.mention = "<#10>"

    async def connect(self, **kwargs):
        vc = FakeVoiceClient(self.guild, self)
        self.guild.voice_client = vc
        return vc


class FakeVoiceClient:
    def __init__(self, guild, channel):
        self.guild = guild
        self.channel = channel
        self._connected = True
        self._playing = False
        self.source = None

    def is_connected(self):
        return self._connected

    def is_playing(self):
        return self._playing

    def play(self, source, after=None):
        self.source = source
        self._playing = True

    def stop(self):
        self._playing = False

    async def disconnect(self, force=False):
        self._connected = False
        self.guild.voice_client = None

    async def move_to(self, channel):
        self.channel = channel


class FakeGuild:
    def __init__(self, guild_id=1):
        self.id = guild_id
        self.voice_client = None
        self.channel = FakeChannel(self)

    def get_channel(self, channel_id):
        return self.channel if channel_id == self.channel.id else None


class FakeUser:
    id = 99
    display_name = "テスト"
    name = "テスト"


class IdleExemptTest(unittest.IsolatedAsyncioTestCase):
    def make_manager(self):
        guild = FakeGuild()
        manager = VoiceSessionManager(mock.MagicMock(), auto_leave_seconds=60)
        session = VoiceSession(
            guild=guild, feature="radio", user_id=99, user_name="テスト",
            channel_id=guild.channel.id, started_at=time.time(),
        )
        manager._sessions[guild.id] = session
        return manager, guild, session

    async def test_idle_timer_starts_without_exempt(self):
        manager, guild, session = self.make_manager()
        manager._evaluate_idle(session)
        self.assertIsNotNone(session.idle_task)
        session.idle_task.cancel()

    async def test_idle_exempt_blocks_timer(self):
        manager, guild, session = self.make_manager()
        session.idle_exempt = True
        manager._evaluate_idle(session)
        self.assertIsNone(session.idle_task)

    async def test_set_idle_exempt_cancels_timer(self):
        manager, guild, session = self.make_manager()
        manager._evaluate_idle(session)
        self.assertIsNotNone(session.idle_task)
        manager.set_idle_exempt(guild.id, True)
        self.assertTrue(session.idle_exempt)
        self.assertIsNone(session.idle_task)


class RadioFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)

    async def test_start_and_stop(self):
        bot = mock.MagicMock()
        cog = RadioCog(bot)
        guild = FakeGuild()
        bot.get_guild = lambda gid: guild if gid == guild.id else None
        station = await cog.start_radio(guild, guild.channel, FakeUser(), "lush")
        self.assertEqual(station.id, "lush")
        session = cog.manager.get(guild.id)
        self.assertIsNotNone(session)
        self.assertEqual(session.feature, "radio")
        from core.vc.voice_media import has_audio_source
        self.assertTrue(has_audio_source(guild.voice_client, "radio"))
        cfg = radio_settings(guild.id)
        self.assertTrue(cfg["playing"])
        self.assertEqual(cfg["station"], "lush")
        released = await cog.stop_radio(guild.id)
        self.assertTrue(released)
        self.assertIsNone(cog.manager.get(guild.id))
        self.assertFalse(radio_settings(guild.id)["playing"])

    async def test_always_on_sets_idle_exempt(self):
        bot = mock.MagicMock()
        cog = RadioCog(bot)
        guild = FakeGuild()
        bot.get_guild = lambda gid: guild if gid == guild.id else None
        await save_radio_settings(guild.id, always_on=True)
        await cog.start_radio(guild, guild.channel, FakeUser(), "lush")
        session = cog.manager.get(guild.id)
        self.assertTrue(session.idle_exempt)


class PanelViewTest(unittest.TestCase):
    def test_view_has_select_and_buttons(self):
        view = RadioPanelView(mock.MagicMock(), 1, "lush")
        kinds = [type(item).__name__ for item in view.children]
        self.assertIn("Select", kinds)
        self.assertEqual(kinds.count("Button"), 3)
        select = next(i for i in view.children if type(i).__name__ == "Select")
        self.assertEqual(len(select.options), len(STATIONS))


if __name__ == "__main__":
    unittest.main()
