"""統合した/voiceグループ（PR-C）のテスト。Discord には接続しない。

- 4 個の統合サブコマンドが、各機能の実装関数を正しい引数で呼ぶこと
- 旧コマンド（/join・!rec・!stt・!saito・!gvc join など）が登録されていないこと
- /voice connection action:状態 が、VC を使っている機能と開始した人を表示すること
- Logfareキーが無いとき文字起こし、Voskモデルが無いときカラオケは VC に入らずに断ること
- /voice studio feature:録音 action:音程解析が NameError にならず音階を返すこと
- 録音を始めると、テキストチャンネルに全員に見えるお知らせが出ること
"""

import inspect
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402
import numpy as np  # noqa: E402

from core import vosk_model  # noqa: E402
from core.legacy import Responder  # noqa: E402
from cogs import (  # noqa: E402
    sio_globalVC, sio_karaoke, sio_music, sio_rec, sio_saito, sio_transcription, sio_voice, sio_voicechanger,
)
from tests.test_all_commands import FakeSupabase  # noqa: E402
from tests.test_music_group import FakeCtx, FakeInteraction, choice  # noqa: E402
from tests.test_voice_session import make_bot, make_world  # noqa: E402


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.bot.supabase = FakeSupabase()
        self.w = make_world()
        self.opus = patch.object(sio_rec.discord.opus, 'is_loaded', return_value=True)
        self.opus.start()
        self.addCleanup(self.opus.stop)
        self.music = sio_music.VoiceCog(self.bot)
        self.rec = sio_rec.RecordingCog(self.bot)
        self.stt = sio_transcription.TranscriptionCog(self.bot)
        self.karaoke = sio_karaoke.KaraokeCog(self.bot)
        self.changer = sio_voicechanger.VoiceChangerCog(self.bot)
        self.saito = sio_saito.SaitoRelay(self.bot)
        self.gvc = sio_globalVC.GlobalVCCog(self.bot)
        cogs = {type(c).__name__: c for c in (self.music, self.rec, self.stt, self.karaoke, self.changer,
                                              self.saito, self.gvc)}
        self.bot.get_cog = cogs.get
        self.hub = sio_voice.VoiceHub(self.bot)

    async def asyncTearDown(self):
        await self.manager.close()

    def interaction(self, user=None):
        return FakeInteraction(self.w, user or self.w.alice)

    def ctx(self, user=None):
        return FakeCtx(self.w, user or self.w.alice)

    async def voice(self, name, interaction=None, **kwargs):
        # Keep readable legacy test cases, but invoke only the new consolidated slash commands.
        if name in ('join', 'leave', 'status'):
            old_name = name
            name = 'connection'
            kwargs['action'] = choice({'join': 'join', 'leave': 'leave', 'status': 'status'}[old_name])
        elif name in ('record', 'echo', 'transcribe', 'karaoke'):
            feature = name
            name = 'studio'
            kwargs['feature'] = choice(feature)
        elif name == 'changer':
            name = 'effects'
        elif name in ('match', 'global'):
            network = name
            name = 'community'
            kwargs['network'] = choice(network)
            if network == 'global' and 'action' in kwargs:
                kwargs['action'] = choice({'join': 'start', 'leave': 'stop'}.get(kwargs['action'].value, kwargs['action'].value))
        command = self.hub.voice_group.get_command(name)
        interaction = interaction or self.interaction()
        await command.callback(self.hub, interaction, **kwargs)
        return interaction


class SubcommandImplementationTest(Base):
    """/voice のサブコマンドが、各機能の実装関数を正しい引数で呼ぶ。"""

    @staticmethod
    def bound(signature, call):
        arguments = signature.bind(None, *call.args, **call.kwargs)
        arguments.apply_defaults()
        values = dict(arguments.arguments)
        values.pop('self')
        responder = values.pop(next(iter(values)))
        return responder, values

    async def check(self, cog, impl, new_name, new_kwargs, expected):
        cls = type(cog)
        signature = inspect.signature(getattr(cls, impl))
        with patch.object(cls, impl, AsyncMock()) as mock:
            interaction = await self.voice(new_name, **new_kwargs)
            self.assertEqual(mock.await_count, 1, f'/voice {new_name}')
            responder, values = self.bound(signature, mock.await_args)
        self.assertIsInstance(responder, Responder)
        self.assertIs(responder.source, interaction)
        self.assertEqual(values, expected, f'/voice {new_name}')
        return values

    async def test_join_leave(self):
        await self.check(self.music, '_join_impl', 'join', {}, {})
        await self.check(self.music, '_leave_impl', 'leave', {}, {})

    async def test_record(self):
        for value in ('start', 'stop', 'status', 'pitch'):
            await self.check(self.rec, '_record_impl', 'record', {'action': choice(value)}, {'action': value})

    async def test_echo(self):
        await self.check(self.rec, '_echo_impl', 'echo', {'action': choice('start'), 'delay': 3.0},
                         {'action': 'start', 'delay': 3.0})
        await self.check(self.rec, '_echo_impl', 'echo', {'action': choice('start')}, {'action': 'start', 'delay': None})
        await self.check(self.rec, '_echo_impl', 'echo', {'action': choice('delay'), 'delay': 1.5},
                         {'action': 'delay', 'delay': 1.5})
        await self.check(self.rec, '_echo_impl', 'echo', {'action': choice('stop')}, {'action': 'stop', 'delay': None})

    async def test_transcribe(self):
        target = self.w.text
        await self.check(self.stt, '_transcribe_impl', 'transcribe', {'action': choice('start'), 'channel': target},
                         {'action': 'start', 'target_channel': target})
        await self.check(self.stt, '_transcribe_impl', 'transcribe', {'action': choice('start')},
                         {'action': 'start', 'target_channel': None})
        await self.check(self.stt, '_transcribe_impl', 'transcribe', {'action': choice('stop')},
                         {'action': 'stop', 'target_channel': None})

    async def test_karaoke(self):
        await self.check(self.karaoke, '_karaoke_impl', 'karaoke', {'action': choice('start'), 'lyrics': 'かえるのうた'},
                         {'action': 'start', 'target_lyrics': 'かえるのうた'})
        await self.check(self.karaoke, '_karaoke_impl', 'karaoke', {'action': choice('score')},
                         {'action': 'score', 'target_lyrics': None})
        await self.check(self.karaoke, '_karaoke_impl', 'karaoke', {'action': choice('stop')},
                         {'action': 'stop', 'target_lyrics': None})

    async def test_changer(self):
        c = self.changer
        none = {'pitch': None, 'buffer_ms': None, 'max_ms': None}
        await self.check(c, '_changer_impl', 'changer', {'action': choice('start'), 'pitch': 3.0},
                         {**none, 'action': 'start', 'pitch': 3.0})
        await self.check(c, '_changer_impl', 'changer', {'action': choice('start')}, {**none, 'action': 'start'})
        await self.check(c, '_changer_impl', 'changer', {'action': choice('status')}, {**none, 'action': 'status'})
        await self.check(c, '_changer_impl', 'changer', {'action': choice('status'), 'buffer_ms': 40.0, 'max_ms': 80.0},
                         {'action': 'status', 'pitch': None, 'buffer_ms': 40.0, 'max_ms': 80.0})
        await self.check(c, '_changer_impl', 'changer', {'action': choice('stop')}, {**none, 'action': 'stop'})

    async def test_match(self):
        await self.check(self.saito, '_match_impl', 'match', {'action': choice('start')}, {'action': 'start'})
        await self.check(self.saito, '_match_impl', 'match', {'action': choice('stop')}, {'action': 'stop'})

    async def test_global(self):
        await self.check(self.gvc, '_global_impl', 'global', {'action': choice('join'), 'room': 'lobby', 'password': 'pw'},
                         {'action': 'join', 'room_name': 'lobby', 'password': 'pw'})
        await self.check(self.gvc, '_global_impl', 'global', {'action': choice('leave')},
                         {'action': 'leave', 'room_name': None, 'password': None})

    def test_four_consolidated_subcommands(self):
        names = sorted(c.name for c in self.hub.voice_group.commands)
        self.assertEqual(names, sorted(['connection', 'studio', 'effects', 'community']))


class LegacyRemovedTest(Base):
    """旧コマンド（!rec・!echo・!stt・!karaoke・!vc・!saito・!gvc join/leave）は残っていない。"""

    def test_old_prefix_commands_are_gone(self):
        from discord.ext import commands
        for cog in (self.rec, self.stt, self.karaoke, self.changer, self.saito, self.music):
            names = {c.qualified_name for c in cog.walk_commands()}
            with self.subTest(cog=type(cog).__name__):
                self.assertEqual(names & {'rec', 'echo', 'stt', 'karaoke', 'vc', 'saito', 'saito_stop'}, set())
        gvc = {c.qualified_name for c in self.gvc.walk_commands() if isinstance(c, commands.Command)}
        self.assertNotIn('gvc join', gvc)
        self.assertNotIn('gvc leave', gvc)
        self.assertTrue({'gvc create', 'gvc list', 'gvc info', 'gvc delete', 'gvc chat'} <= gvc)

    def test_old_slash_join_leave_are_gone(self):
        names = {c.name for c in self.music.get_app_commands()}
        self.assertNotIn('join', names)
        self.assertNotIn('leave', names)

    def test_old_methods_are_gone(self):
        for cog, attrs in ((self.rec, ('rec_group', 'rec_start', 'rec_pitch', 'echo_group', 'echo_start')),
                           (self.stt, ('stt_group', 'stt_start')), (self.karaoke, ('karaoke_group',)),
                           (self.changer, ('vc_group', 'vc_start')), (self.saito, ('saito', 'saito_stop')),
                           (self.gvc, ('gvc_join', 'gvc_leave')), (self.music, ('join_cmd', 'leave_cmd'))):
            for attr in attrs:
                with self.subTest(attr=attr):
                    self.assertFalse(hasattr(cog, attr))


class StatusTest(Base):
    async def test_nobody(self):
        interaction = await self.voice('status')
        content, kwargs = interaction.sent[-1]
        self.assertTrue(kwargs['ephemeral'])
        self.assertIn('どの機能も使っていません', kwargs['embed'].description)

    async def test_shows_feature_user_and_stop_hint(self):
        await self.rec._record_impl(Responder(self.ctx(self.w.alice)), 'start')
        interaction = await self.voice('status', self.interaction(self.w.bob))
        embed = interaction.sent[-1][1]['embed']
        fields = {f.name: f.value for f in embed.fields}
        self.assertEqual(fields['機能'], '録音')
        self.assertEqual(fields['開始した人'], 'alice')
        self.assertIn('/voice studio feature:録音 action:停止', fields['終了するには'])
        self.assertIn('秒', fields['経過時間'])

    async def test_busy_message_points_to_voice_commands(self):
        await self.rec._record_impl(Responder(self.ctx(self.w.alice)), 'start')
        interaction = await self.voice('join', self.interaction(self.w.bob))
        self.assertIn('/voice studio feature:録音 action:停止', interaction.texts())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')


class ModelMissingTest(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.missing = os.path.join(tempfile.gettempdir(), 'no-such-vosk-model-dir')
        self.assertFalse(os.path.exists(self.missing))

    def assert_not_touched(self):
        self.assertIsNone(self.manager.get(self.w.guild.id))
        self.assertIsNone(self.w.guild.voice_client)

    async def test_transcribe_refuses_without_logfare_key(self):
        with patch.object(sio_transcription.logfare, 'api_key', return_value=None):
            interaction = await self.voice('transcribe', action=choice('start'))
        self.assertIn('LOGFARE_API_KEY', interaction.texts())
        self.assertTrue(interaction.sent[-1][1]['ephemeral'])
        self.assert_not_touched()

    async def test_transcribe_does_not_take_over_an_active_voice_feature(self):
        await self.rec._record_impl(Responder(self.ctx(self.w.alice)), 'start')
        active_vc = self.w.guild.voice_client
        with patch.object(sio_transcription.logfare, 'api_key', return_value='configured'):
            interaction = await self.voice('transcribe', action=choice('start'))
        self.assertIn('録音', interaction.texts())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')
        self.assertIs(self.w.guild.voice_client, active_vc)
        self.assertTrue(active_vc.is_connected())

    async def test_karaoke_refuses_without_model(self):
        with patch.object(sio_karaoke, 'MODEL_PATH', self.missing):
            interaction = await self.voice('karaoke', action=choice('start'), lyrics='かえるのうた')
        self.assertIn('音声認識モデルが入っていません', interaction.texts())
        self.assert_not_touched()

    async def test_model_loaded_lazily_when_folder_appears(self):
        with tempfile.TemporaryDirectory() as folder:
            holder = type('Holder', (), {'vosk_model': None})()
            loaded = []

            def fake_model(path):
                loaded.append(path)
                return 'MODEL'
            self.assertIsNone(await vosk_model.ensure_model(holder, fake_model, folder))
            self.assertEqual((holder.vosk_model, loaded), ('MODEL', [folder]))
            self.assertEqual(await vosk_model.ensure_model(holder, None, folder), None)  # 読み込み済みならそのまま
            holder.vosk_model = None
            self.assertEqual(await vosk_model.ensure_model(holder, None, folder), vosk_model.VOSK_MISSING_MESSAGE)


class RecordingTest(Base):
    async def test_start_posts_visible_notice(self):
        interaction = await self.voice('record', action=choice('start'))
        notices = [m for m in self.w.text.sent if isinstance(m, str) and '録音を開始しました' in m]
        self.assertEqual(len(notices), 1)
        self.assertIn('alice', notices[0])
        self.assertIn(self.w.voice.name, notices[0])
        # 返信（状態表示）は interaction に返り、お知らせは ephemeral ではなくチャンネルに出る
        self.assertIn('録音を開始しました', interaction.texts())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')

    async def test_no_notice_when_refused(self):
        await self.voice('join', self.interaction(self.w.bob))
        before = list(self.w.text.sent)
        await self.voice('record', action=choice('start'))
        self.assertEqual([m for m in self.w.text.sent[len(before):] if '録音を開始しました' in str(m)], [])

    async def test_pitch_returns_notes(self):
        await self.rec._record_impl(Responder(self.ctx()), 'start')
        t = np.arange(24000) / 48000
        mono = (np.sin(2 * np.pi * 440 * t) * 12000).astype(np.int16)
        pcm = np.column_stack((mono, mono)).flatten().tobytes()
        sink = self.rec.sessions[self.w.guild.id]['sink']
        with patch.object(sink, 'snapshot', return_value={'alice': pcm}):
            interaction = await self.voice('record', action=choice('pitch'))  # 以前は NameError（detected_notes）
        embed = next(kwargs['embed'] for _, kwargs in interaction.sent if kwargs.get('embed') is not None
                     and kwargs['embed'].title and '音階' in kwargs['embed'].title)
        self.assertEqual(embed.fields[0].name, '🎙️ alice')
        self.assertIn('A4', embed.fields[0].value)

    def test_format_notes(self):
        self.assertEqual(sio_rec.format_notes([('A4', 'A4', 69), ('C#4', 'Db4', 61)]), ['A4', 'C#4/Db4'])


class ChangerOptionsTest(Base):
    async def test_options_change_running_changer(self):
        sink = type('Sink', (), {})()
        sink.set_semitones = lambda value: setattr(sink, 'semitones', value)
        src = type('Src', (), {'target_buffer_ms': 60.0})()
        src.update_settings = lambda **kw: setattr(src, 'settings', kw)
        sink.audio_source = src
        self.changer.vc_sessions[self.w.guild.id] = {'sink': sink, 'vc': None}
        interaction = await self.voice('changer', action=choice('status'), pitch=4.0, buffer_ms=40.0)
        self.assertEqual(sink.semitones, 4.0)
        self.assertEqual(src.settings, {'target_buffer_ms': 40.0, 'max_buffer_ms': 80.0})
        self.assertIn('設定を変更しました', interaction.texts())

        interaction = await self.voice('changer', action=choice('status'), max_ms=10.0)
        self.assertIn('上限バッファは目標バッファ以上', interaction.texts())

    async def test_options_without_changer(self):
        interaction = await self.voice('changer', action=choice('status'), pitch=4.0)
        self.assertIn('開始されていません', interaction.texts())


if __name__ == '__main__':
    unittest.main()
