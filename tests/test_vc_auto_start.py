"""VC参加時の自動開始（core/vc/auto_start.py）のテスト。Discord には接続しない。

- 設定の保存/読込と既定 OFF
- 発動判定（新規参加のみ・復旧時なし・既存有効時は冪等・人がいないと開始しない）
- 失敗分離（1機能の失敗が他機能と参加を巻き込まない）
- VoiceSessionManager の新規セッションでのみフックが呼ばれること
"""
import asyncio
import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {"BOT_API_BASE_URL": "http://127.0.0.1:8787", "BOT_API_KEY": "dummy-key"}.items():
    os.environ.setdefault(_name, _value)

from core.support import guild_settings  # noqa: E402
from core.vc import auto_start  # noqa: E402
from core.vc.auto_start import (  # noqa: E402
    VC_AUTO_START_SECTION,
    get_vc_auto_start_settings,
    plan_auto_start,
)


class FakeKV:
    def __init__(self):
        self.data = {}

    def load_local(self):
        return {}

    async def load_all(self):
        return self.data

    async def set(self, key, value, wait=True):
        self.data[key] = value

    async def delete(self, key, wait=True):
        self.data.pop(key, None)


def make_store():
    return guild_settings.GuildSettings(FakeKV())


class SettingsTest(unittest.IsolatedAsyncioTestCase):
    async def test_defaults_all_off(self):
        store = make_store()
        settings = get_vc_auto_start_settings(store, 42)
        self.assertEqual(
            settings,
            {"tts": False, "transcribe": False, "music_panel": False,
             "global": False, "global_room": None, "global_password": None},
        )

    async def test_save_and_load_roundtrip(self):
        store = make_store()
        await store.update(42, VC_AUTO_START_SECTION, tts=True, global_room="room1")
        settings = get_vc_auto_start_settings(store, 42)
        self.assertTrue(settings["tts"])
        self.assertFalse(settings["transcribe"])
        self.assertEqual(settings["global_room"], "room1")

    async def test_non_bool_values_fall_back_to_off(self):
        store = make_store()
        await store.update(42, VC_AUTO_START_SECTION, tts="yes", global_room="  ")
        settings = get_vc_auto_start_settings(store, 42)
        self.assertFalse(settings["tts"])
        self.assertIsNone(settings["global_room"])


class PlanTest(unittest.TestCase):
    def base(self, **overrides):
        settings = {"tts": False, "transcribe": False, "music_panel": False,
                    "global": False, "global_room": None, "global_password": None}
        settings.update(overrides)
        return settings

    def test_all_off_plans_nothing(self):
        start, skipped = plan_auto_start(self.base(), {"music"})
        self.assertEqual(start, [])
        self.assertEqual(skipped, [])

    def test_active_feature_is_skipped_idempotently(self):
        start, skipped = plan_auto_start(self.base(tts=True), {"tts"})
        self.assertEqual(start, [])
        self.assertEqual(skipped, [])

    def test_music_panel_planned_even_when_music_is_owner(self):
        start, _ = plan_auto_start(self.base(music_panel=True), {"music"})
        self.assertEqual(start, ["music_panel"])

    def test_global_without_room_is_reported_not_started(self):
        start, skipped = plan_auto_start(self.base(**{"global": True}), {"music"})
        self.assertEqual(start, [])
        self.assertEqual(skipped, [("global", "ルーム名が未設定")])

    def test_global_with_room_is_planned(self):
        start, skipped = plan_auto_start(self.base(**{"global": True}, global_room="r"), {"music"})
        self.assertEqual(start, ["global"])
        self.assertEqual(skipped, [])


# ---------------------------------------------------------------- 偽の Discord
class FakeMember:
    def __init__(self, user_id=7, *, bot=False):
        self.id = user_id
        self.bot = bot
        self.name = self.display_name = "ユーザー"
        self.voice = None


class FakeVoiceChannel:
    def __init__(self, guild, channel_id=900):
        self.id = channel_id
        self.guild = guild
        self.name = "vc"
        self.members = [FakeMember(7)]


class FakeTextChannel:
    def __init__(self, guild, channel_id=500):
        self.id = channel_id
        self.guild = guild
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append(content if content is not None else kwargs)
        return types.SimpleNamespace(id=12345)

    def text(self):
        return "\n".join(str(x) for x in self.sent)


class FakeGuild:
    def __init__(self, guild_id=42):
        self.id = guild_id
        self.voice_client = None
        self.vc_channel = FakeVoiceChannel(self)
        self.text_channel = FakeTextChannel(self)

    def get_channel(self, channel_id):
        return self.vc_channel if channel_id == self.vc_channel.id else None


class FakeSession:
    def __init__(self, guild, feature="music"):
        self.guild = guild
        self.guild_id = guild.id
        self.feature = feature
        self.shared_leases = {}
        self.channel_id = guild.vc_channel.id


class FakeTTSCog:
    def __init__(self, *, fail=False):
        self.read_channels = {}
        self.calls = 0
        self.fail = fail

    async def _start_impl(self, r, channel=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError("tts boom")
        self.read_channels[r.guild.id] = r.channel.id


class FakeTranscriptionCog:
    def __init__(self):
        self.sessions = {}
        self.calls = 0

    async def _transcribe_impl(self, r, action, channel=None):
        self.calls += 1
        self.sessions[r.guild.id] = {"action": action}


class FakeMusicCog:
    def __init__(self):
        self.state = {}
        self.calls = 0

    def get_state(self, guild_id):
        return self.state

    async def _panel_impl(self, r):
        self.calls += 1
        self.state["panel_message"] = object()


class FakeGlobalCog:
    def __init__(self, manager):
        self.manager = manager
        self.calls = []

    async def _global_impl(self, r, action, room=None, password=None):
        self.calls.append((action, room))
        session = self.manager.get(r.guild.id)
        if session is not None:
            session.shared_leases["global"] = object()


class FakeManager:
    def __init__(self, session):
        self._session = session

    def get(self, guild_id):
        return self._session


class FakeBot:
    def __init__(self, cogs, manager):
        self._cogs = cogs
        self.voice_sessions = manager

    def get_cog(self, name):
        return self._cogs.get(name)


class RunnerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auto_start._SELF_STARTED.clear()
        self.store = make_store()
        guild_settings.set_store(self.store)
        self.guild = FakeGuild()
        self.session = FakeSession(self.guild)
        self.manager = FakeManager(self.session)
        self.tts = FakeTTSCog()
        self.transcribe = FakeTranscriptionCog()
        self.music = FakeMusicCog()
        self.global_cog = FakeGlobalCog(self.manager)
        self.bot = FakeBot(
            {"TTSCog": self.tts, "TranscriptionCog": self.transcribe,
             "VoiceCog": self.music, "GlobalVCCog": self.global_cog},
            self.manager,
        )
        self.user = FakeMember(7)

    async def asyncTearDown(self):
        guild_settings.set_store(None)

    async def enable(self, **values):
        await self.store.update(42, VC_AUTO_START_SECTION, **values)

    async def run_hook(self):
        await auto_start.on_fresh_session(
            self.bot, self.session, self.user, self.guild.text_channel
        )

    async def test_nothing_enabled_does_nothing(self):
        await self.run_hook()
        self.assertEqual(self.tts.calls, 0)
        self.assertEqual(self.guild.text_channel.sent, [])

    async def test_starts_enabled_features_and_reports(self):
        await self.enable(tts=True, transcribe=True)
        await self.run_hook()
        self.assertEqual(self.tts.calls, 1)
        self.assertEqual(self.transcribe.calls, 1)
        self.assertIn("自動開始: 読み上げ、文字起こし", self.guild.text_channel.text())

    async def test_failure_is_isolated(self):
        self.tts.fail = True
        await self.enable(tts=True, transcribe=True)
        await self.run_hook()  # 例外で落ちないこと
        self.assertEqual(self.transcribe.calls, 1)
        text = self.guild.text_channel.text()
        self.assertIn("文字起こし", text)
        self.assertIn("読み上げ（tts boom）", text)

    async def test_already_active_feature_not_restarted(self):
        self.session.feature = "tts"
        await self.enable(tts=True, transcribe=True)
        await self.run_hook()
        self.assertEqual(self.tts.calls, 0)
        self.assertEqual(self.transcribe.calls, 1)

    async def test_no_humans_in_vc_skips(self):
        self.guild.vc_channel.members = [FakeMember(1, bot=True)]
        await self.enable(tts=True)
        await self.run_hook()
        self.assertEqual(self.tts.calls, 0)

    async def test_exclusive_session_skips(self):
        self.session.feature = "record"
        await self.enable(tts=True)
        await self.run_hook()
        self.assertEqual(self.tts.calls, 0)

    async def test_restore_suppression(self):
        await self.enable(tts=True)
        with auto_start.restore_suppression():
            await self.run_hook()
        self.assertEqual(self.tts.calls, 0)

    async def test_global_without_room_reports_reason(self):
        await self.enable(**{"global": True})
        await self.run_hook()
        self.assertEqual(self.global_cog.calls, [])
        self.assertIn("グローバルVC（ルーム名が未設定）", self.guild.text_channel.text())

    async def test_global_with_room_starts(self):
        await self.enable(**{"global": True}, global_room="room1")
        await self.run_hook()
        self.assertEqual(self.global_cog.calls, [("join", "room1")])
        self.assertIn("グローバルVC", self.guild.text_channel.text())

    async def test_music_panel_self_started_is_not_duplicated(self):
        auto_start.note_self_started(42, "music_panel")
        await self.enable(music_panel=True)
        await self.run_hook()
        self.assertEqual(self.music.calls, 0)  # 自前表示で代替済み

    async def test_music_panel_posts_via_channel(self):
        await self.enable(music_panel=True)
        await self.run_hook()
        self.assertEqual(self.music.calls, 1)


class AcquireHookTest(unittest.IsolatedAsyncioTestCase):
    async def test_hook_fires_only_on_fresh_session(self):
        from core.vc.voice_session import VoiceSessionManager

        calls = []

        async def hook(bot, session, user, text_channel):
            calls.append(session.feature)

        guild = FakeGuild()
        human = FakeMember(7)
        human.voice = types.SimpleNamespace(channel=guild.vc_channel)

        vc = types.SimpleNamespace(channel=guild.vc_channel, guild=guild)

        def is_connected():
            return True

        vc.is_connected = is_connected

        async def connect(**kwargs):
            guild.voice_client = vc
            return vc

        guild.vc_channel.connect = connect
        manager = VoiceSessionManager(types.SimpleNamespace(), reconnect_delay=0)
        manager.fresh_session_hook = hook

        await manager.acquire(guild, guild.vc_channel, "music", human, text_channel=guild.text_channel)
        await asyncio.gather(*list(manager._tasks), return_exceptions=True)
        self.assertEqual(calls, ["music"])

        # 共有リース追加（既存セッションへの合流）では発火しない
        await manager.acquire(guild, guild.vc_channel, "tts", human, text_channel=guild.text_channel)
        await asyncio.gather(*list(manager._tasks), return_exceptions=True)
        self.assertEqual(calls, ["music"])


if __name__ == "__main__":
    unittest.main()
