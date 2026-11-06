"""再起動復旧（切れても死なない）のテスト。Discord には接続しない。

- core/voice/voice_restore.py: スナップショットの serialize/deserialize 往復、壊れた JSON の吸収
- core/voice/voice_session.py: acquire/release に連動したセッションスナップショットの保存・削除
- cogs/sio_music.py: 再生状態のシリアライズ、復旧可否判定（人がいる/いない・チャンネル欠落）、
  再生再開と一時停止のままの復旧、音楽パネルの取り直し
- cogs/sio_globalVC.py: ROOMS（ルーム定義）の永続化往復、参加状態の復旧可否判定
"""

import asyncio
import json
import os
import sys
import tempfile
import time
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

from core.voice import voice_restore  # noqa: E402
from core.voice import voice_session as vs  # noqa: E402
from cogs import sio_globalVC as gvc  # noqa: E402
from cogs import sio_music as music  # noqa: E402


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
        self.fetched_message = None

    async def send(self, content=None, **kwargs):
        return types.SimpleNamespace(id=999, channel=self)

    async def fetch_message(self, message_id):
        if self.fetched_message is None or self.fetched_message.id != message_id:
            raise RuntimeError("message not found")
        return self.fetched_message


class FakeVC:
    def __init__(self, channel):
        self.channel, self.guild = channel, channel.guild
        self.connected = True

    def is_connected(self):
        return self.connected

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


# ---------------------------------------------------------------- ストア
class VoiceRestoreStoreTest(StoreTestCase):
    def test_roundtrip_all_sections(self):
        payload = {
            "sessions": {"10": {"feature": "music", "channel_id": 910}},
            "music": {"10": {"queue": [["https://youtu.be/x", "曲", None, True]], "current": None}},
            "gvc_rooms": {"room": {"name": "room", "owner_id": 5}},
            "gvc_joins": {"10": {"room_name": "room"}},
        }
        for section, entries in payload.items():
            for key, value in entries.items():
                self.store.set_entry(section, key, value)
        self.store.flush()

        reloaded = voice_restore.VoiceRestoreStore(self.path)
        for section, entries in payload.items():
            self.assertEqual(reloaded.section(section), entries)
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(set(raw), set(voice_restore.SECTIONS))

    def test_set_entry_none_deletes(self):
        self.store.set_entry("music", "10", {"queue": []})
        self.store.set_entry("music", "10", None)
        self.assertIsNone(self.store.get_entry("music", "10"))
        # 無いキーの削除は冪等
        self.store.set_entry("music", "10", None)

    def test_set_section_replaces_and_filters(self):
        self.store.set_section("gvc_rooms", {"a": {"name": "a"}, "bad": "not-a-dict"})
        self.assertEqual(self.store.section("gvc_rooms"), {"a": {"name": "a"}})

    def test_unknown_section_raises(self):
        with self.assertRaises(ValueError):
            self.store.set_entry("nope", "1", {})

    def test_corrupt_json_falls_back_to_empty(self):
        self.path.write_text("{ this is not json", encoding="utf-8")
        store = voice_restore.VoiceRestoreStore(self.path)
        self.assertEqual(store.section("music"), {})
        # 壊れたファイルは退避され、元パスは次の flush で作り直せる
        self.assertTrue(list(Path(self.tmp.name).glob("voice_restore.json.broken-*")))
        store.set_entry("music", "1", {"queue": []})
        store.flush()
        self.assertEqual(
            voice_restore.VoiceRestoreStore(self.path).get_entry("music", "1"), {"queue": []}
        )


# ---------------------------------------------------------------- セッション永続化
class SessionPersistenceTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def make_manager(self):
        bot = types.SimpleNamespace(user=types.SimpleNamespace(id=1))
        manager = vs.VoiceSessionManager(bot)
        manager.reconnect_delay = 0
        manager.disconnect_grace = 0
        return manager

    def make_world(self):
        guild = FakeGuild(10)
        alice = FakeMember(110, 'alice')
        voice = FakeVoiceChannel(guild, 910, [alice])
        guild.channels[voice.id] = voice
        text = FakeTextChannel(guild, 510)
        return guild, alice, voice, text

    async def test_acquire_persists_and_release_clears(self):
        manager = self.make_manager()
        guild, alice, voice, text = self.make_world()
        await manager.acquire(guild, voice, "music", alice, text_channel=text)
        entry = self.store.get_entry("sessions", "10")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["feature"], "music")
        self.assertEqual(entry["channel_id"], 910)
        self.assertEqual(entry["user_id"], 110)
        self.assertEqual(entry["text_channel_id"], 510)
        self.assertEqual(entry["shared_leases"], [])

        await manager.release(guild, reason="stop")
        self.assertIsNone(self.store.get_entry("sessions", "10"))

    async def test_shared_lease_is_persisted(self):
        manager = self.make_manager()
        guild, alice, voice, text = self.make_world()
        await manager.acquire(guild, voice, "music", alice, text_channel=text)
        await manager.acquire(guild, voice, "global", alice, text_channel=text)
        entry = self.store.get_entry("sessions", "10")
        self.assertEqual(entry["shared_leases"], ["global"])

        await manager.release(guild, "global", reason="stop")
        entry = self.store.get_entry("sessions", "10")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["shared_leases"], [])


# ---------------------------------------------------------------- 音楽
class MusicSnapshotTest(StoreTestCase):
    def make_cog(self, guilds=None, channels=None):
        return music.VoiceCog(make_bot(guilds, channels))

    def test_serialize_yt_current_omits_stream_url_and_fixes_elapsed(self):
        cog = self.make_cog()
        state = cog.get_state(10)
        state['queue'].put_nowait(("https://youtube.com/watch?v=q", "次の曲", None, True))
        state['current_track'] = ("https://stream.example/expiring", "再生中", 200, None, True)
        state['current_yt_page_url'] = "https://youtube.com/watch?v=now"
        state['elapsed_offset'] = 10.0
        state['start_time'] = time.time() - 30
        data = cog._serialize_music_state(10)
        self.assertIsNotNone(data)
        current = data["current"]
        self.assertIsNone(current["stream_url"])  # 失効する URL は保存しない
        self.assertEqual(current["page_url"], "https://youtube.com/watch?v=now")
        self.assertTrue(35 <= current["elapsed"] <= 45)  # 10 + 再生中30秒
        self.assertEqual(data["queue"], [["https://youtube.com/watch?v=q", "次の曲", None, True]])
        json.dumps(data)  # JSON 化できること

    def test_serialize_file_current_keeps_stream_url(self):
        cog = self.make_cog()
        state = cog.get_state(10)
        state['current_track'] = ("https://cdn.example/a.mp3", "ファイル曲", 120, "abc123", False)
        state['is_paused'] = True
        data = cog._serialize_music_state(10)
        self.assertEqual(data["current"]["stream_url"], "https://cdn.example/a.mp3")
        self.assertEqual(data["current"]["elapsed"], 0.0)

    def test_serialize_empty_is_none_and_save_clears(self):
        cog = self.make_cog()
        self.assertIsNone(cog._serialize_music_state(10))
        self.store.set_entry("music", "10", {"queue": [["x", "y", None, False]]})
        cog._save_music_snapshot(10)
        self.assertIsNone(self.store.get_entry("music", "10"))


class MusicRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def make_world(self, *, humans=True):
        guild = FakeGuild(10)
        alice = FakeMember(110, 'alice')
        members = [alice] if humans else [FakeMember(1, 'bot', bot=True)]
        voice = FakeVoiceChannel(guild, 910, members)
        guild.channels[voice.id] = voice
        guild.members[alice.id] = alice
        text = FakeTextChannel(guild, 510)
        bot = make_bot({10: guild}, {510: text})
        cog = music.VoiceCog(bot)
        cog.voice_sessions.reconnect_delay = 0
        return cog, guild, alice, voice, text

    def snapshot(self, **overrides):
        base = {
            "voice_channel_id": 910, "text_channel_id": 510,
            "user_id": 110, "user_name": "alice",
            "queue": [["https://youtube.com/watch?v=q", "次の曲", None, True]],
            "current": {"filename": "再生中", "duration": 200, "b62_id": None,
                        "is_yt": True, "page_url": "https://youtube.com/watch?v=now",
                        "stream_url": None, "elapsed": 42.0},
            "is_paused": False, "volume": 1.5, "speed": 1.0, "eq": "flat",
            "custom_eq_filter": None, "loop_mode": "off", "shuffle_enabled": False,
            "panel": {"channel_id": 510, "message_id": 999},
        }
        base.update(overrides)
        return base

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_world(humans=False)
        self.store.set_entry("music", "10", self.snapshot())
        await cog.restore_after_restart()
        self.assertIsNone(self.store.get_entry("music", "10"))
        self.assertEqual(voice.connect_calls, 0)
        self.assertIsNone(cog.voice_sessions.get(10))

    async def test_missing_channel_skips_and_cleans(self):
        cog, guild, alice, voice, text = self.make_world()
        self.store.set_entry("music", "10", self.snapshot(voice_channel_id=4242))
        await cog.restore_after_restart()
        self.assertIsNone(self.store.get_entry("music", "10"))
        self.assertIsNone(cog.voice_sessions.get(10))

    async def test_restore_resumes_playing_from_queue_head(self):
        cog, guild, alice, voice, text = self.make_world()
        panel_message = types.SimpleNamespace(id=999, channel=text)
        text.fetched_message = panel_message
        cog.check_queue = AsyncMock()
        self.store.set_entry("music", "10", self.snapshot())
        await cog.restore_after_restart()

        session = cog.voice_sessions.get(10)
        self.assertIsNotNone(session)
        self.assertEqual(session.feature, "music")
        state = cog.get_state(10)
        # 再生中だった曲がキューの先頭へ戻り、保存位置から check_queue で再開される
        self.assertEqual(state['queue']._queue[0],
                         ("https://youtube.com/watch?v=now", "再生中", None, True))
        self.assertEqual(state['queue']._queue[1],
                         ("https://youtube.com/watch?v=q", "次の曲", None, True))
        self.assertEqual(state['elapsed_offset'], 42.0)
        self.assertEqual(state['volume'], 1.5)
        self.assertFalse(state['is_paused'])
        cog.check_queue.assert_awaited_once_with(10)
        # パネルは保存済みメッセージを取り直して付け直す
        self.assertIs(state['panel_message'], panel_message)
        # スナップショットは復旧後も残る（継続保存される）
        self.assertIsNotNone(self.store.get_entry("music", "10"))

    async def test_restore_paused_rebuilds_current_track(self):
        cog, guild, alice, voice, text = self.make_world()
        cog.check_queue = AsyncMock()
        cog.get_yt_info = AsyncMock(return_value={
            'stream_url': 'https://stream.example/fresh', 'title': '再生中',
            'duration': 200, 'webpage_url': 'https://youtube.com/watch?v=now',
            'http_headers': {},
        })
        self.store.set_entry("music", "10", self.snapshot(is_paused=True))
        await cog.restore_after_restart()

        state = cog.get_state(10)
        self.assertTrue(state['is_paused'])
        self.assertEqual(state['current_track'],
                         ('https://stream.example/fresh', '再生中', 200, None, True))
        self.assertEqual(state['elapsed_offset'], 42.0)
        cog.check_queue.assert_not_awaited()  # 止めたまま復旧する


# ---------------------------------------------------------------- グローバルVC
class GvcRoomsTest(StoreTestCase):
    def setUp(self):
        super().setUp()
        self.saved_rooms = dict(gvc.ROOMS)

    def tearDown(self):
        gvc.ROOMS.clear()
        gvc.ROOMS.update(self.saved_rooms)
        super().tearDown()

    def test_room_dict_roundtrip_all_fields(self):
        room = gvc.RoomConfig(
            name="room1", owner_id=11, owner_guild_id=22, max_servers=3,
            private=True, password="secret", description="説明", created_at=1234567.0,
        )
        restored = gvc._room_from_dict(gvc._room_to_dict(room))
        self.assertEqual(restored, room)

    def test_room_from_dict_rejects_garbage(self):
        self.assertIsNone(gvc._room_from_dict(None))
        self.assertIsNone(gvc._room_from_dict({"name": ""}))
        self.assertIsNone(gvc._room_from_dict({"name": 123}))

    def test_persist_and_load_rooms(self):
        gvc.ROOMS.clear()
        gvc.ROOMS["persisted"] = gvc.RoomConfig(
            name="persisted", owner_id=1, owner_guild_id=2, password="pw", private=True,
        )
        gvc._persist_rooms()
        gvc.ROOMS.clear()
        self.assertEqual(gvc.ROOMS, {})
        gvc._load_rooms()
        self.assertIn("persisted", gvc.ROOMS)
        self.assertEqual(gvc.ROOMS["persisted"].password, "pw")
        self.assertTrue(gvc.ROOMS["persisted"].private)


class GvcRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.saved_rooms = dict(gvc.ROOMS)
        gvc.ROOMS["room1"] = gvc.RoomConfig(name="room1", owner_id=110, owner_guild_id=10)

    def tearDown(self):
        gvc.ROOMS.clear()
        gvc.ROOMS.update(self.saved_rooms)
        super().tearDown()

    def make_cog(self, *, humans=True):
        guild = FakeGuild(10)
        alice = FakeMember(110, 'alice')
        members = [alice] if humans else []
        voice = FakeVoiceChannel(guild, 910, members)
        guild.channels[voice.id] = voice
        guild.members[alice.id] = alice
        bot = make_bot({10: guild}, {})
        cog = gvc.GlobalVCCog(bot)
        return cog, guild, voice

    def join_info(self):
        return {"room_name": "room1", "voice_channel_id": 910, "text_channel_id": 510,
                "user_id": 110, "user_name": "alice"}

    async def test_no_humans_skips_and_cleans(self):
        cog, guild, voice = self.make_cog(humans=False)
        cog._connect_room = AsyncMock()
        self.store.set_entry("gvc_joins", "10", self.join_info())
        await cog.restore_after_restart()
        cog._connect_room.assert_not_awaited()
        self.assertIsNone(self.store.get_entry("gvc_joins", "10"))

    async def test_missing_room_skips_and_cleans(self):
        cog, guild, voice = self.make_cog()
        cog._connect_room = AsyncMock()
        info = self.join_info()
        info["room_name"] = "gone"
        self.store.set_entry("gvc_joins", "10", info)
        await cog.restore_after_restart()
        cog._connect_room.assert_not_awaited()
        self.assertIsNone(self.store.get_entry("gvc_joins", "10"))

    async def test_restore_rejoins_room(self):
        cog, guild, voice = self.make_cog()
        cog._connect_room = AsyncMock()
        self.store.set_entry("gvc_joins", "10", self.join_info())
        await cog.restore_after_restart()
        cog._connect_room.assert_awaited_once()
        args = cog._connect_room.await_args.args
        self.assertEqual(args[0], guild)
        self.assertEqual(args[1], voice)
        self.assertEqual(args[4], "room1")
        # 復旧できたら参加スナップショットは残る（_connect_room が保存し直す前提）
        self.assertIsNotNone(self.store.get_entry("gvc_joins", "10"))


if __name__ == "__main__":
    unittest.main()
