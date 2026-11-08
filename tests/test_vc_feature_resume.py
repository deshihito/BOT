"""VC 各機能（録音・カラオケ・文字起こし・ボイスチェンジャー）の再起動後自動再開のテスト。

Discord には接続しない。

- core/vc/vc_feature_restore.py: 再開用エントリの保存・読み出し・掃除
- 各 cog の restore_after_restart: 保存→復旧で再開に必要な情報が揃うこと、
  人がいない／チャンネルが消えた場合は再開せず掃除されること、
  壊れたスナップショットでも起動が止まらないこと

再開は「同設定の新規セッション」が上限で、録音データ・歌唱履歴などの
セッション途中データは復元されない（各 cog の docstring 参照）。
"""

import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402

from core.vc import vc_feature_restore, voice_restore  # noqa: E402
from core.vc.karaoke import entry as karaoke  # noqa: E402
from core.vc.rec import entry as rec  # noqa: E402
from core.vc.transcription import entry as transcription  # noqa: E402
from core.vc.voicechanger import entry as changer  # noqa: E402


# ---------------------------------------------------------------- 偽の Discord
class FakeMember:
    def __init__(self, user_id, name, *, bot=False):
        self.id, self.name, self.display_name, self.bot = user_id, name, name, bot
        self.guild_permissions = discord.Permissions.none()
        self.voice = None
        self.guild = None


class FakeTextChannel:
    def __init__(self, guild, channel_id=500):
        self.id, self.guild = channel_id, guild
        self.name = f'text{channel_id}'
        self.sent = []
        self.webhook = types.SimpleNamespace(
            token="tok", url="https://discord.com/api/webhooks/1/tok")

    @property
    def mention(self):
        return f"<#{self.id}>"

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return types.SimpleNamespace(id=999, channel=self)

    async def webhooks(self):
        return [self.webhook]


class FakeVC:
    def __init__(self, channel):
        self.channel, self.guild = channel, channel.guild
        self.connected = True
        self.listening_sink = None
        self.played = []

    def is_connected(self):
        return self.connected

    def is_listening(self):
        return self.listening_sink is not None

    def listen(self, sink):
        self.listening_sink = sink

    def stop_listening(self):
        self.listening_sink = None

    def play(self, source, **kwargs):
        self.played.append(source)

    def stop(self):
        pass

    async def disconnect(self, force=False):
        self.connected = False
        if self.guild.voice_client is self:
            self.guild.voice_client = None

    async def move_to(self, channel):
        self.channel = channel


class FakeVoiceChannel:
    def __init__(self, guild, channel_id, members=()):
        self.id, self.guild, self.name = channel_id, guild, f'vc{channel_id}'
        self.members = list(members)
        self.connect_calls = 0

    async def connect(self, **kwargs):
        self.connect_calls += 1
        vc = FakeVC(self)
        self.guild.voice_client = vc
        return vc


class FakeGuild:
    def __init__(self, guild_id=10):
        self.id, self.name = guild_id, f'guild{guild_id}'
        self.voice_client = None
        self.channels = {}
        self.members = {}

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    def get_member(self, user_id):
        return self.members.get(user_id)


def make_bot(guilds=None, channels=None):
    guilds = guilds or {}
    channels = channels or {}
    return types.SimpleNamespace(
        user=types.SimpleNamespace(id=1),
        get_guild=lambda guild_id: guilds.get(guild_id),
        get_channel=lambda channel_id: channels.get(channel_id),
    )


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "voice_restore.json"
        self.store = voice_restore.reset_store(self.path)

    def tearDown(self):
        voice_restore.reset_store()
        self.tmp.cleanup()


def make_world(*, humans=True):
    guild = FakeGuild(10)
    alice = FakeMember(110, 'alice')
    members = [alice] if humans else [FakeMember(1, 'bot', bot=True)]
    voice = FakeVoiceChannel(guild, 910, members)
    guild.channels[voice.id] = voice
    guild.members[alice.id] = alice
    text = FakeTextChannel(guild, 510)
    target = FakeTextChannel(guild, 520)
    bot = make_bot({10: guild}, {510: text, 520: target})
    return bot, guild, alice, voice, text, target


def entry(*, settings=None, voice_channel_id=910, text_channel_id=510, user_id=110):
    return {
        "voice_channel_id": voice_channel_id,
        "text_channel_id": text_channel_id,
        "user_id": user_id,
        "user_name": "alice",
        "settings": settings or {},
    }


# ---------------------------------------------------------------- ヘルパ
class FeatureStoreTest(StoreTestCase):
    def test_save_roundtrip_per_feature(self):
        vc_feature_restore.save_feature("karaoke", 10, entry(settings={"target_lyrics": "歌詞"}))
        vc_feature_restore.save_feature("record", 10, entry())
        entries = vc_feature_restore.feature_entries("karaoke")
        self.assertEqual(entries[10]["settings"]["target_lyrics"], "歌詞")
        self.assertEqual(entries[10]["feature"], "karaoke")
        # 機能ごとに分離される
        self.assertEqual(set(vc_feature_restore.feature_entries("record")), {10})
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})

    def test_clear_and_update_settings(self):
        vc_feature_restore.save_feature("changer", 10, entry(settings={"semitones": 1.0}))
        vc_feature_restore.update_settings("changer", 10, {"semitones": 3.0})
        self.assertEqual(
            vc_feature_restore.feature_entries("changer")[10]["settings"]["semitones"], 3.0)
        vc_feature_restore.clear_feature("changer", 10)
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})
        # 無いエントリの更新・削除は冪等
        vc_feature_restore.update_settings("changer", 10, {"semitones": 0.0})
        vc_feature_restore.clear_feature("changer", 10)

    def test_malformed_keys_are_skipped(self):
        self.store.set_section("vc_features", {
            "abc:record": {"voice_channel_id": 910},
            "10:record": {"voice_channel_id": 910},
            "10:record:extra": {"voice_channel_id": 910},
        })
        entries = vc_feature_restore.feature_entries("record")
        self.assertEqual(set(entries), {10})


# ---------------------------------------------------------------- 録音
class RecordResumeTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        rec.ensure_opus()

    def make_cog(self, *, humans=True):
        bot, guild, alice, voice, text, _target = make_world(humans=humans)
        cog = rec.RecordingCog(bot)
        cog.voice_sessions.reconnect_delay = 0
        return cog, guild, alice, voice, text

    async def test_save_then_restore_resumes_new_recording(self):
        cog, guild, alice, voice, text = self.make_cog()
        cog._save_resume_snapshot(10, voice, text, alice)
        saved = vc_feature_restore.feature_entries("record")
        self.assertEqual(saved[10]["voice_channel_id"], 910)
        self.assertEqual(saved[10]["text_channel_id"], 510)

        await cog.restore_after_restart()

        session = cog.sessions.get(10)
        self.assertIsNotNone(session)
        self.assertEqual(session["channel_name"], "vc910")
        self.assertIs(session["text_channel"], text)
        manager_session = cog.voice_sessions.get(10)
        self.assertIsNotNone(manager_session)
        self.assertEqual(manager_session.feature, "record")
        # 再開通知（録音告知を兼ねる）が送られている
        self.assertTrue(any("録音を再開しました" in (content or "")
                            for content, _kw in text.sent))
        # エントリは継続保存される
        self.assertIn(10, vc_feature_restore.feature_entries("record"))
        # 後片付け: 停止するとエントリが消える
        await cog.voice_sessions.release(guild, "record", reason="stop")
        task = cog._deliveries.get(10)
        if task is not None:
            await task
        self.assertEqual(vc_feature_restore.feature_entries("record"), {})

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_cog(humans=False)
        self.store.set_entry("vc_features", "10:record", entry())
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.sessions)
        self.assertEqual(voice.connect_calls, 0)
        self.assertEqual(vc_feature_restore.feature_entries("record"), {})

    async def test_missing_channels_skip_and_clean(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:record",
                             entry(voice_channel_id=4242))
        self.store.set_entry("vc_features", "11:record",
                             entry(text_channel_id=4242))
        await cog.restore_after_restart()
        self.assertEqual(cog.sessions, {})
        self.assertEqual(vc_feature_restore.feature_entries("record"), {})

    async def test_corrupt_snapshot_does_not_break_startup(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:record",
                             {"voice_channel_id": "not-a-number", "settings": "garbage"})
        await cog.restore_after_restart()  # 例外なく終わる
        self.assertEqual(cog.sessions, {})
        self.assertEqual(vc_feature_restore.feature_entries("record"), {})


# ---------------------------------------------------------------- カラオケ
def _kwargs_text(kwargs):
    """送信 kwargs から本文テキストを取り出す（embed / Components V2 両対応）。"""
    embed = kwargs.get("embed")
    if embed is not None:
        return getattr(embed, "description", "") or ""
    texts = []
    stack = list(getattr(kwargs.get("view"), "children", []) or [])
    while stack:
        item = stack.pop()
        content = getattr(item, "content", None)
        if isinstance(content, str):
            texts.append(content)
        stack.extend(getattr(item, "children", []) or [])
    return "\n".join(texts)


class KaraokeResumeTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self._orig_ensure_model = karaoke.ensure_model

    def tearDown(self):
        karaoke.ensure_model = self._orig_ensure_model
        super().tearDown()

    def make_cog(self, *, humans=True):
        bot, guild, alice, voice, text, _target = make_world(humans=humans)
        cog = karaoke.KaraokeCog(bot)
        cog.voice_sessions.reconnect_delay = 0
        cog.vosk_model = object()  # モデルは差し替え（ensure_model をモックする）
        karaoke.ensure_model = AsyncMock(return_value=None)
        return cog, guild, alice, voice, text

    async def test_save_then_restore_resumes_with_same_lyrics(self):
        cog, guild, alice, voice, text = self.make_cog()
        cog._save_resume_snapshot(10, voice, text, alice, "お題の歌詞テスト")
        saved = vc_feature_restore.feature_entries("karaoke")
        self.assertEqual(saved[10]["settings"]["target_lyrics"], "お題の歌詞テスト")

        await cog.restore_after_restart()

        session = cog.sessions.get(10)
        self.assertIsNotNone(session)
        self.assertEqual(session["target_lyrics"], "お題の歌詞テスト")
        self.assertEqual(cog.voice_sessions.get(10).feature, "karaoke")
        descriptions = [_kwargs_text(kw) for _c, kw in text.sent]
        self.assertTrue(any("カラオケを再開しました" in d for d in descriptions))
        await cog.voice_sessions.release(guild, "karaoke", reason="stop")
        self.assertEqual(vc_feature_restore.feature_entries("karaoke"), {})

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_cog(humans=False)
        self.store.set_entry("vc_features", "10:karaoke",
                             entry(settings={"target_lyrics": "歌詞"}))
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.sessions)
        self.assertEqual(vc_feature_restore.feature_entries("karaoke"), {})

    async def test_missing_lyrics_or_corrupt_cleans(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:karaoke", entry(settings={}))
        self.store.set_entry("vc_features", "11:karaoke",
                             {"voice_channel_id": [], "settings": "garbage"})
        await cog.restore_after_restart()
        self.assertEqual(cog.sessions, {})
        self.assertEqual(vc_feature_restore.feature_entries("karaoke"), {})


# ---------------------------------------------------------------- 文字起こし
class TranscriptionResumeTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def make_cog(self, *, humans=True):
        bot, guild, alice, voice, text, target = make_world(humans=humans)
        cog = transcription.TranscriptionCog(bot)
        cog.voice_sessions.reconnect_delay = 0
        return cog, guild, alice, voice, text, target

    def setUp(self):
        super().setUp()
        self._orig_api_key = transcription.logfare.api_key
        transcription.logfare.api_key = lambda: "dummy-key"

    def tearDown(self):
        transcription.logfare.api_key = self._orig_api_key
        super().tearDown()

    async def test_save_then_restore_resumes_with_target(self):
        cog, guild, alice, voice, text, target = self.make_cog()
        cog._save_resume_snapshot(10, voice, text, alice, target)
        saved = vc_feature_restore.feature_entries("transcribe")
        self.assertEqual(saved[10]["settings"]["target_channel_id"], 520)

        await cog.restore_after_restart()

        session = cog.sessions.get(10)
        self.assertIsNotNone(session)
        self.assertEqual(session["target_channel_id"], 520)
        self.assertEqual(cog.voice_sessions.get(10).feature, "transcribe")
        # 送信先 Webhook 経由の sink が共有受信に登録されている
        vc = guild.voice_client
        self.assertIsNotNone(getattr(vc, "_shared_receive_sink", None))
        await cog.voice_sessions.release(guild, "transcribe", reason="stop")
        self.assertEqual(vc_feature_restore.feature_entries("transcribe"), {})

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, alice, voice, text, target = self.make_cog(humans=False)
        self.store.set_entry("vc_features", "10:transcribe",
                             entry(settings={"target_channel_id": 520}))
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.sessions)
        self.assertEqual(vc_feature_restore.feature_entries("transcribe"), {})

    async def test_missing_target_or_corrupt_cleans(self):
        cog, guild, alice, voice, text, target = self.make_cog()
        self.store.set_entry("vc_features", "10:transcribe",
                             entry(settings={"target_channel_id": 4242}))
        self.store.set_entry("vc_features", "11:transcribe",
                             {"voice_channel_id": 910, "settings": "garbage"})
        await cog.restore_after_restart()
        self.assertEqual(cog.sessions, {})
        self.assertEqual(vc_feature_restore.feature_entries("transcribe"), {})

    async def test_no_api_key_skips_and_cleans(self):
        transcription.logfare.api_key = lambda: None
        cog, guild, alice, voice, text, target = self.make_cog()
        self.store.set_entry("vc_features", "10:transcribe",
                             entry(settings={"target_channel_id": 520}))
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.sessions)
        self.assertEqual(vc_feature_restore.feature_entries("transcribe"), {})


# ---------------------------------------------------------------- ボイスチェンジャー
class ChangerResumeTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def make_cog(self, *, humans=True):
        bot, guild, alice, voice, text, _target = make_world(humans=humans)
        cog = changer.VoiceChangerCog(bot)
        cog.voice_sessions.reconnect_delay = 0
        return cog, guild, alice, voice, text

    async def test_save_then_restore_resumes_with_settings(self):
        cog, guild, alice, voice, text = self.make_cog()
        sink = types.SimpleNamespace(
            semitones=4.0,
            audio_source=types.SimpleNamespace(target_buffer_ms=30.0, max_buffer_ms=60.0),
        )
        cog._save_resume_snapshot(10, voice, text, alice, sink)
        saved = vc_feature_restore.feature_entries("changer")
        self.assertEqual(saved[10]["settings"]["semitones"], 4.0)

        await cog.restore_after_restart()

        session = cog.vc_sessions.get(10)
        self.assertIsNotNone(session)
        self.assertEqual(session["sink"].semitones, 4.0)
        self.assertEqual(session["sink"].audio_source.target_buffer_ms, 30.0)
        self.assertEqual(session["sink"].audio_source.max_buffer_ms, 60.0)
        self.assertEqual(cog.voice_sessions.get(10).feature, "changer")
        await cog.voice_sessions.release(guild, "changer", reason="stop")
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_cog(humans=False)
        self.store.set_entry("vc_features", "10:changer",
                             entry(settings={"semitones": 2.0}))
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.vc_sessions)
        self.assertEqual(voice.connect_calls, 0)
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})

    async def test_missing_channel_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:changer",
                             entry(voice_channel_id=4242, settings={"semitones": 2.0}))
        await cog.restore_after_restart()
        self.assertNotIn(10, cog.vc_sessions)
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})

    async def test_corrupt_pitch_falls_back_to_zero(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:changer",
                             {"voice_channel_id": 910, "text_channel_id": 510,
                              "user_id": 110, "user_name": "alice",
                              "settings": {"semitones": "abc"}})
        await cog.restore_after_restart()
        # 壊れたピッチ値は 0.0 にフォールバックして再開する（設定として無害なため）
        self.assertIn(10, cog.vc_sessions)
        self.assertEqual(cog.vc_sessions[10]["sink"].semitones, 0.0)
        await cog.voice_sessions.release(guild, "changer", reason="stop")

    async def test_corrupt_settings_type_does_not_break_startup(self):
        cog, guild, alice, voice, text = self.make_cog()
        self.store.set_entry("vc_features", "10:changer",
                             {"voice_channel_id": 910, "settings": "garbage"})
        await cog.restore_after_restart()  # 例外なく終わる
        self.assertEqual(cog.vc_sessions, {})
        self.assertEqual(vc_feature_restore.feature_entries("changer"), {})


if __name__ == "__main__":
    unittest.main()
