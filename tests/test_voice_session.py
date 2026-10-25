"""VC の持ち主管理（core/voice_session.py）と、各ボイス機能の乗り換えのテスト。Discord には接続しない。

偽の VoiceClient / ボイスチャンネル / サーバーを使って、
- 別の機能が使用中なら追い出さずに断ること（バグ10）
- 開始した本人・管理者は force で切り替えられること
- 誰もいない状態が続くと退出すること、外部から切断されたら後片付けすること
- グローバルVC の参加・退出（/voice community）が「参加中のまま」残らないこと
- 録音が上限時間で自動停止すること
を確かめる。
"""

import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402

from core import voice_session as vs  # noqa: E402
from core.legacy import Responder  # noqa: E402
from cogs import sio_globalVC as gvc  # noqa: E402
from cogs import sio_rec as rec  # noqa: E402
from cogs import sio_saito as saito  # noqa: E402

BOT_ID = 1


# ---------------------------------------------------------------- 偽の Discord
class FakeMember:
    def __init__(self, user_id, name, *, admin=False, bot=False):
        self.id, self.name, self.display_name, self.bot = user_id, name, name, bot
        self.guild_permissions = discord.Permissions.all() if admin else discord.Permissions.none()
        self.voice = None
        self.guild = None


class FakeTextChannel:
    def __init__(self, guild, channel_id=500):
        self.id, self.guild, self.sent = channel_id, guild, []
        self.mention = f'<#{channel_id}>'

    async def send(self, content=None, **kwargs):
        embed = kwargs.get('embed')
        self.sent.append(content if content is not None else (embed.description if embed else kwargs))
        return types.SimpleNamespace(edit=self._edit)

    async def _edit(self, **kwargs):
        return None

    def text(self):
        return '\n'.join(str(x) for x in self.sent)


class FakeVC:
    def __init__(self, channel):
        self.channel, self.guild = channel, channel.guild
        self.connected, self.listening, self.playing = True, False, False
        self.disconnect_calls = 0
        self.mode = 'test'

    def is_connected(self):
        return self.connected

    async def disconnect(self, force=False):
        self.disconnect_calls += 1
        self.connected = False
        if self.guild.voice_client is self:
            self.guild.voice_client = None
        if self.channel is not None and BOT_ID in [m.id for m in self.channel.members]:
            self.channel.members = [m for m in self.channel.members if m.id != BOT_ID]

    async def move_to(self, channel):
        self.channel = channel

    def listen(self, sink):
        self.listening = True
        self.sink = sink

    def is_listening(self):
        return self.listening

    def stop_listening(self):
        self.listening = False

    def play(self, source, after=None):
        self.playing = True

    def stop(self):
        self.playing = False

    def is_playing(self):
        return self.playing

    def is_paused(self):
        return False


class FakeVoiceChannel:
    def __init__(self, guild, channel_id, members=()):
        self.id, self.guild, self.name = channel_id, guild, f'vc{channel_id}'
        self.members = list(members)
        self.connect_calls = 0

    async def connect(self, *, cls=None, timeout=None, reconnect=True, self_deaf=False):
        self.connect_calls += 1
        vc = FakeVC(self)
        self.guild.voice_client = vc
        return vc


class FakeGuild:
    def __init__(self, guild_id=10):
        self.id, self.name = guild_id, f'guild{guild_id}'
        self.voice_client = None
        self.channels = {}
        self.filesize_limit = 8 * 1024 * 1024

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)


def make_world(guild_id=10):
    guild = FakeGuild(guild_id)
    alice = FakeMember(100 + guild_id, 'alice')
    bob = FakeMember(200 + guild_id, 'bob')
    admin = FakeMember(300 + guild_id, 'admin', admin=True)
    voice = FakeVoiceChannel(guild, 900 + guild_id, [alice, bob, admin])
    guild.channels[voice.id] = voice
    for member in (alice, bob, admin):
        member.voice = types.SimpleNamespace(channel=voice)
        member.guild = guild
    text = FakeTextChannel(guild, 500 + guild_id)
    return types.SimpleNamespace(guild=guild, alice=alice, bob=bob, admin=admin, voice=voice, text=text)


def make_bot():
    bot = types.SimpleNamespace(user=types.SimpleNamespace(id=BOT_ID), listeners=[])
    bot.add_listener = lambda fn, name=None: bot.listeners.append((name, fn))
    bot.loop = asyncio.get_running_loop()
    manager = vs.get_manager(bot)
    manager.reconnect_delay = 0
    manager.disconnect_grace = 0
    return bot, manager


def fake_ctx(world, author, bot):
    return types.SimpleNamespace(
        guild=world.guild, author=author, channel=world.text, prefix='!', bot=bot,
        voice_client=world.guild.voice_client, send=world.text.send,
    )


def state(channel):
    return types.SimpleNamespace(channel=channel)


class Recorder:
    def __init__(self):
        self.reasons = []

    def __call__(self, reason):
        self.reasons.append(reason)


async def settle(times=5):
    for _ in range(times):
        await asyncio.sleep(0)


# ---------------------------------------------------------------- マネージャー単体
class ManagerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.w = make_world()

    async def test_registers_single_listener(self):
        self.assertIs(vs.get_manager(self.bot), self.manager)
        self.assertEqual([name for name, _ in self.bot.listeners], ['on_voice_state_update'])

    async def test_refuses_instead_of_kicking(self):
        w, cleanup = self.w, Recorder()
        vc = await self.manager.acquire(w.guild, w.voice, 'record', w.alice, cleanup=cleanup, text_channel=w.text)
        with self.assertRaises(vs.VoiceBusy) as caught:
            await self.manager.acquire(w.guild, w.voice, 'music', w.bob, force=True)
        message = str(caught.exception)
        self.assertIn('録音', message)
        self.assertIn('alice', message)
        self.assertIn('/voice のパネルから録音停止', message)
        self.assertIn('/voice` のパネルから退出', message)
        self.assertTrue(vc.is_connected())
        self.assertEqual(vc.disconnect_calls, 0)
        self.assertEqual(cleanup.reasons, [])
        self.assertEqual(self.manager.owner(w.guild.id), 'record')

    async def test_force_needed_even_for_starter(self):
        w = self.w
        await self.manager.acquire(w.guild, w.voice, 'record', w.alice)
        with self.assertRaises(vs.VoiceBusy):
            await self.manager.acquire(w.guild, w.voice, 'music', w.alice)

    async def test_starter_can_force_takeover(self):
        w, cleanup = self.w, Recorder()
        old = await self.manager.acquire(w.guild, w.voice, 'record', w.alice, cleanup=cleanup, text_channel=w.text)
        new = await self.manager.acquire(w.guild, w.voice, 'music', w.alice, force=True)
        self.assertEqual(cleanup.reasons, ['takeover'])
        self.assertFalse(old.is_connected())
        self.assertTrue(new.is_connected())
        self.assertEqual(self.manager.owner(w.guild.id), 'music')
        self.assertIn('録音を終了しました', w.text.text())

    async def test_admin_can_force_takeover(self):
        w, cleanup = self.w, Recorder()
        await self.manager.acquire(w.guild, w.voice, 'record', w.alice, cleanup=cleanup)
        await self.manager.acquire(w.guild, w.voice, 'global', w.admin, force=True)
        self.assertEqual(cleanup.reasons, ['takeover'])
        self.assertEqual(self.manager.get(w.guild.id).user_id, w.admin.id)

    async def test_anyone_can_take_over_when_starter_left(self):
        w = self.w
        await self.manager.acquire(w.guild, w.voice, 'record', w.alice)
        w.voice.members.remove(w.alice)
        await self.manager.acquire(w.guild, w.voice, 'music', w.bob, force=True)
        self.assertEqual(self.manager.owner(w.guild.id), 'music')

    async def test_same_feature_reuses_connection_and_moves(self):
        w = self.w
        vc = await self.manager.acquire(w.guild, w.voice, 'music', w.alice)
        other = FakeVoiceChannel(w.guild, 999, [w.bob])
        again = await self.manager.acquire(w.guild, other, 'music', w.bob)
        self.assertIs(vc, again)
        self.assertIs(vc.channel, other)
        self.assertEqual(w.voice.connect_calls, 1)

    async def test_music_gvc_tts_and_transcription_share_one_connection(self):
        w = self.w
        vc = await self.manager.acquire(w.guild, w.voice, 'music', w.alice)
        for feature in ('global', 'tts', 'transcribe'):
            shared = await self.manager.acquire(w.guild, w.voice, feature, w.bob, force=True)
            self.assertIs(shared, vc)
        self.assertEqual(set(self.manager.get(w.guild.id).shared_leases), {'global', 'tts', 'transcribe'})
        self.assertTrue(vc.is_connected())
        self.assertEqual(vc.disconnect_calls, 0)

    async def test_shared_feature_stop_only_releases_its_lease(self):
        w = self.w
        vc = await self.manager.acquire(w.guild, w.voice, 'music', w.alice)
        await self.manager.acquire(w.guild, w.voice, 'global', w.bob, force=True)
        self.assertTrue(await self.manager.release(w.guild.id, 'global'))
        self.assertTrue(vc.is_connected())
        self.assertEqual(vc.disconnect_calls, 0)
        self.assertEqual(self.manager.owner(w.guild.id), 'music')
        self.assertNotIn('global', self.manager.get(w.guild.id).shared_leases)

    async def test_releasing_primary_promotes_shared_feature_without_disconnect(self):
        w = self.w
        vc = await self.manager.acquire(w.guild, w.voice, 'music', w.alice)
        await self.manager.acquire(w.guild, w.voice, 'transcribe', w.bob)
        self.assertTrue(await self.manager.release(w.guild.id, 'music'))
        self.assertIs(self.manager.get(w.guild.id).vc, vc)
        self.assertEqual(self.manager.owner(w.guild.id), 'transcribe')
        self.assertTrue(vc.is_connected())
        self.assertEqual(vc.disconnect_calls, 0)

    async def test_shared_features_refuse_to_move_the_common_voice_client(self):
        w = self.w
        vc = await self.manager.acquire(w.guild, w.voice, 'global', w.alice)
        other = FakeVoiceChannel(w.guild, 999, [w.bob])
        with self.assertRaises(vs.VoiceBusy):
            await self.manager.acquire(w.guild, other, 'music', w.bob, force=True)
        self.assertIs(w.guild.voice_client, vc)
        self.assertIs(vc.channel, w.voice)
        self.assertTrue(vc.is_connected())
        self.assertEqual(vc.disconnect_calls, 0)

    async def test_release_runs_cleanup_then_disconnects(self):
        w = self.w
        order = []
        vc = await self.manager.acquire(
            w.guild, w.voice, 'karaoke', w.alice, cleanup=lambda reason: order.append(('cleanup', vc_state(vc))))

        def vc_state(v):
            return v.is_connected()
        self.assertFalse(await self.manager.release(w.guild.id, 'music'))  # 持ち主が違うと何もしない
        self.assertTrue(await self.manager.release(w.guild.id, 'karaoke'))
        self.assertEqual(order, [('cleanup', True)])  # 切断より前に後片付け
        self.assertFalse(vc.is_connected())
        self.assertIsNone(self.manager.get(w.guild.id))

    async def test_cleanup_error_does_not_block_disconnect(self):
        w = self.w

        def broken(reason):
            raise RuntimeError('boom')
        vc = await self.manager.acquire(w.guild, w.voice, 'changer', w.alice, cleanup=broken)
        with self.assertLogs('core.voice_session', level='ERROR'):
            await self.manager.release(w.guild.id)
        self.assertFalse(vc.is_connected())

    async def test_auto_leave_when_empty(self):
        w, cleanup = self.w, Recorder()
        self.manager.auto_leave_seconds = 0.05
        w.voice.members = []  # だれもいない
        vc = await self.manager.acquire(w.guild, w.voice, 'echo', w.alice, cleanup=cleanup, text_channel=w.text)
        await asyncio.sleep(0.15)
        self.assertEqual(cleanup.reasons, ['idle'])
        self.assertFalse(vc.is_connected())
        self.assertIsNone(self.manager.get(w.guild.id))
        self.assertIn('誰もいない', w.text.text())

    async def test_auto_leave_cancelled_when_someone_returns(self):
        w, cleanup = self.w, Recorder()
        self.manager.auto_leave_seconds = 0.1
        await self.manager.acquire(w.guild, w.voice, 'music', w.alice, cleanup=cleanup)
        # 全員が抜ける -> タイマー開始
        members = list(w.voice.members)
        w.voice.members = []
        await self.manager.on_voice_state_update(w.alice, state(w.voice), state(None))
        self.assertIsNotNone(self.manager.get(w.guild.id).idle_task)
        await asyncio.sleep(0.03)
        # 戻ってくる -> 取り消し
        w.voice.members = members
        await self.manager.on_voice_state_update(w.alice, state(None), state(w.voice))
        await asyncio.sleep(0.15)
        self.assertEqual(cleanup.reasons, [])
        self.assertEqual(self.manager.owner(w.guild.id), 'music')

    async def test_auto_leave_applies_to_every_feature(self):
        self.manager.auto_leave_seconds = 0.02
        for index, feature in enumerate(vs.FEATURES):
            w = make_world(50 + index)
            w.voice.members = []
            await self.manager.acquire(w.guild, w.voice, feature, w.alice)
            await asyncio.sleep(0.06)
            with self.subTest(feature=feature):
                self.assertIsNone(self.manager.get(w.guild.id))
                self.assertIsNone(w.guild.voice_client)

    async def test_external_disconnect_cleans_up(self):
        w, cleanup = self.w, Recorder()
        vc = await self.manager.acquire(w.guild, w.voice, 'global', w.alice, cleanup=cleanup, text_channel=w.text)
        # サーバー側でキックされた
        vc.connected = False
        w.guild.voice_client = None
        me = FakeMember(BOT_ID, 'bot', bot=True)
        me.guild = w.guild
        await self.manager.on_voice_state_update(me, state(w.voice), state(None))
        await settle()
        self.assertEqual(cleanup.reasons, ['disconnected'])
        self.assertIsNone(self.manager.get(w.guild.id))
        self.assertIn('切断されたため', w.text.text())

    async def test_reconnected_client_is_kept(self):
        w, cleanup = self.w, Recorder()
        await self.manager.acquire(w.guild, w.voice, 'music', w.alice, cleanup=cleanup)
        me = FakeMember(BOT_ID, 'bot', bot=True)
        me.guild = w.guild
        await self.manager.on_voice_state_update(me, state(w.voice), state(None))  # 接続は生きている
        await settle()
        self.assertEqual(cleanup.reasons, [])
        self.assertEqual(self.manager.owner(w.guild.id), 'music')

    async def test_own_release_event_does_not_touch_new_session(self):
        w = self.w
        await self.manager.acquire(w.guild, w.voice, 'record', w.alice)
        await self.manager.acquire(w.guild, w.voice, 'music', w.alice, force=True)
        session = self.manager.get(w.guild.id)
        me = FakeMember(BOT_ID, 'bot', bot=True)
        me.guild = w.guild
        # 乗り換え時の切断イベントが遅れて届いても、新しい接続は生きているので残す
        await self.manager.on_voice_state_update(me, state(w.voice), state(None))
        await settle()
        self.assertIs(self.manager.get(w.guild.id), session)

    async def test_can_leave(self):
        w = self.w
        await self.manager.acquire(w.guild, w.voice, 'music', w.alice)
        self.assertTrue(self.manager.can_leave(self.manager.get(w.guild.id), w.bob))  # 音楽は誰でも
        await self.manager.release(w.guild.id)
        await self.manager.acquire(w.guild, w.voice, 'record', w.alice)
        session = self.manager.get(w.guild.id)
        self.assertFalse(self.manager.can_leave(session, w.bob))
        self.assertTrue(self.manager.can_leave(session, w.alice))
        self.assertTrue(self.manager.can_leave(session, w.admin))


# ---------------------------------------------------------------- 各 cog の乗り換え
class CogTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.w = make_world()
        self.saved = (dict(gvc.ROOMS), dict(gvc.GLOBAL_ROOMS))
        gvc.ROOMS.clear()
        gvc.GLOBAL_ROOMS.clear()
        gvc.ROOMS['lobby'] = gvc.RoomConfig(name='lobby', owner_id=self.w.alice.id, owner_guild_id=self.w.guild.id)
        self.opus = patch.object(rec.discord.opus, 'is_loaded', return_value=True)
        self.opus.start()
        self.rec = rec.RecordingCog(self.bot)
        self.gvc = gvc.GlobalVCCog(self.bot)

    async def asyncTearDown(self):
        self.opus.stop()
        await self.manager.close()
        gvc.ROOMS.clear()
        gvc.GLOBAL_ROOMS.clear()
        gvc.ROOMS.update(self.saved[0])
        gvc.GLOBAL_ROOMS.update(self.saved[1])

    def ctx(self, author):
        return fake_ctx(self.w, author, self.bot)

    async def gvc_join(self, author):
        await self.gvc._global_impl(Responder(self.ctx(author)), 'join', 'lobby')

    async def gvc_leave(self, author):
        await self.gvc._global_impl(Responder(self.ctx(author)), 'leave')

    async def test_gvc_join_does_not_kick_recording(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        vc = self.w.guild.voice_client
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')
        await self.gvc_join(self.w.bob)
        self.assertIn('録音', self.w.text.sent[-1])
        self.assertTrue(vc.is_connected())
        self.assertTrue(vc.is_listening())
        self.assertIn(self.w.guild.id, self.rec.sessions)
        self.assertEqual(gvc.GLOBAL_ROOMS, {})

    async def test_recording_does_not_kick_gvc(self):
        await self.gvc_join(self.w.alice)
        await self.rec.start_command(Responder(self.ctx(self.w.bob)))
        self.assertIn('グローバルVC', self.w.text.sent[-1])
        self.assertNotIn(self.w.guild.id, self.rec.sessions)
        self.assertEqual(len(gvc.GLOBAL_ROOMS['lobby']), 1)

    async def test_echo_refused_while_recording(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        await self.rec._echo_impl(Responder(self.ctx(self.w.bob)), 'start', 2.0)
        self.assertNotIn(self.w.guild.id, self.rec.echo_sessions)
        self.assertIn('録音', self.w.text.sent[-1])

    async def test_gvc_join_leave_is_not_stuck(self):
        await self.gvc_join(self.w.alice)
        self.assertEqual(self.manager.owner(self.w.guild.id), 'global')
        self.assertEqual(len(gvc.GLOBAL_ROOMS['lobby']), 1)
        await self.gvc_leave(self.w.alice)
        self.assertEqual(gvc.GLOBAL_ROOMS, {})
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIsNone(self.w.guild.voice_client)
        # もう一度入れる（「すでに参加しています」にならない）
        await self.gvc_join(self.w.alice)
        self.assertIn('参加しました', self.w.text.sent[-1])
        self.assertEqual(len(gvc.GLOBAL_ROOMS['lobby']), 1)

    async def test_gvc_external_disconnect_is_not_stuck(self):
        await self.gvc_join(self.w.alice)
        vc = self.w.guild.voice_client
        vc.connected = False
        self.w.guild.voice_client = None
        me = FakeMember(BOT_ID, 'bot', bot=True)
        me.guild = self.w.guild
        await self.manager.on_voice_state_update(me, state(self.w.voice), state(None))
        await settle()
        self.assertEqual(gvc.GLOBAL_ROOMS, {})
        self.assertIsNone(self.manager.get(self.w.guild.id))
        await self.gvc_join(self.w.alice)
        self.assertIn('参加しました', self.w.text.sent[-1])

    async def test_gvc_leave_does_not_stop_other_features(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        await self.gvc_leave(self.w.bob)
        self.assertIn('参加していません', self.w.text.sent[-1])
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')

    async def test_gvc_delete_releases_sessions(self):
        await self.gvc_join(self.w.alice)
        await self.gvc.gvc_delete.callback(self.gvc, self.ctx(self.w.alice), 'lobby')
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIsNone(self.w.guild.voice_client)
        self.assertEqual(gvc.GLOBAL_ROOMS, {})

    async def test_rec_stop_delivers_and_disconnects(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        vc = self.w.guild.voice_client
        await self.rec.stop_command(Responder(self.ctx(self.w.alice)))
        self.assertFalse(vc.is_connected())
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIn('録音を停止しました', self.w.text.text())

    async def test_record_time_limit(self):
        with patch.object(rec, 'RECORD_LIMIT_SECONDS', 0.05):
            await self.rec.start_command(Responder(self.ctx(self.w.alice)))
            vc = self.w.guild.voice_client
            self.assertTrue(vc.is_listening())
            await asyncio.sleep(0.2)
            task = self.rec._deliveries.get(self.w.guild.id)
            if task is not None:
                await task
        self.assertNotIn(self.w.guild.id, self.rec.sessions)
        self.assertFalse(vc.is_listening())
        self.assertFalse(vc.is_connected())
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIn('上限', self.w.text.text())

    async def test_record_limit_task_cancelled_on_stop(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        task = self.rec.sessions[self.w.guild.id]['limit_task']
        await self.rec.stop_command(Responder(self.ctx(self.w.alice)))
        await settle()
        self.assertTrue(task.cancelled() or task.done())

    async def test_record_limit_is_thirty_minutes(self):
        self.assertEqual(rec.RECORD_LIMIT_SECONDS, 30 * 60)

    async def test_starter_switches_from_recording_to_gvc(self):
        await self.rec.start_command(Responder(self.ctx(self.w.alice)))
        await self.gvc_join(self.w.alice)
        task = self.rec._deliveries.get(self.w.guild.id)
        if task is not None:
            await task
        self.assertEqual(self.manager.owner(self.w.guild.id), 'global')
        self.assertNotIn(self.w.guild.id, self.rec.sessions)
        self.assertIn('別の機能に切り替わったため録音を停止しました', self.w.text.text())

    async def test_saito_stop_ends_both_sides(self):
        cog = saito.SaitoRelay(self.bot)
        other = make_world(20)
        with patch.object(saito.discord, 'FFmpegPCMAudio', lambda *a, **k: object()):
            await cog._match_impl(Responder(self.ctx(self.w.alice)), 'start')
            await cog._match_impl(Responder(fake_ctx(other, other.alice, self.bot)), 'start')
        self.assertEqual(self.manager.owner(self.w.guild.id), 'match')
        self.assertEqual(self.manager.owner(other.guild.id), 'match')
        await cog._match_impl(Responder(self.ctx(self.w.alice)), 'stop')
        await settle(10)
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIsNone(self.manager.get(other.guild.id))
        self.assertIsNone(other.guild.voice_client)
        self.assertIn('相手のサーバーが通話を終了しました', other.text.text())


class MusicTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from cogs import sio_music
        self.bot, self.manager = make_bot()
        self.bot.supabase = None
        self.w = make_world()
        self.music = sio_music.VoiceCog(self.bot)
        self.opus = patch.object(rec.discord.opus, 'is_loaded', return_value=True)
        self.opus.start()
        self.rec = rec.RecordingCog(self.bot)

    async def asyncTearDown(self):
        self.opus.stop()
        await self.manager.close()

    def interaction(self, user):
        sent = []

        async def send(content=None, **kwargs):
            sent.append((content, kwargs))

        done = []

        async def send_message(content=None, **kwargs):
            done.append(True)
            await send(content, **kwargs)

        async def defer(**kwargs):
            done.append(True)
        response = types.SimpleNamespace(send_message=send_message, defer=defer, is_done=lambda: bool(done))
        return types.SimpleNamespace(
            user=user, guild=self.w.guild, guild_id=self.w.guild.id, channel=self.w.text,
            response=response, followup=types.SimpleNamespace(send=send)), sent

    @staticmethod
    def sent_text(sent):
        content, kwargs = sent[-1]
        if content is not None:
            return content
        embed = kwargs.get('embed')
        return getattr(embed, 'description', '') or ''

    async def test_join_refused_while_recording(self):
        await self.rec.start_command(Responder(fake_ctx(self.w, self.w.alice, self.bot)))
        vc = self.w.guild.voice_client
        interaction, sent = self.interaction(self.w.bob)
        await self.music._join_impl(Responder(interaction))
        self.assertIn('録音', self.sent_text(sent))
        self.assertTrue(vc.is_connected())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')

    async def test_join_and_leave(self):
        interaction, sent = self.interaction(self.w.alice)
        await self.music._join_impl(Responder(interaction))
        self.assertEqual(self.manager.owner(self.w.guild.id), 'music')
        interaction, sent = self.interaction(self.w.bob)  # 音楽は誰でも /voice connection action:退出 できる
        await self.music._leave_impl(Responder(interaction))
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIsNone(self.w.guild.voice_client)

    async def test_leave_protects_others_recording(self):
        await self.rec.start_command(Responder(fake_ctx(self.w, self.w.alice, self.bot)))
        interaction, sent = self.interaction(self.w.bob)
        await self.music._leave_impl(Responder(interaction))
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')
        self.assertIn('開始した人か管理者', self.sent_text(sent))
        interaction, sent = self.interaction(self.w.admin)
        await self.music._leave_impl(Responder(interaction))
        task = self.rec._deliveries.get(self.w.guild.id)
        if task is not None:
            await task
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIn('/voice のパネルからVC退出 で退出したため録音を停止しました', self.w.text.text())

    async def test_join_hints_point_to_slash_join(self):
        source = (ROOT / 'cogs' / 'sio_music.py').read_text(encoding='utf-8')
        self.assertNotIn('!join', source)


if __name__ == '__main__':
    unittest.main()
