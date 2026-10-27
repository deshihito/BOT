"""/music グループ（PR-B）のテスト。Discord・Supabase には接続しない。

- サブコマンドが実装関数（_xxx_impl）を正しい引数で呼ぶこと
- 削除した旧コマンド（/play・!panel・/spotify_* など）が登録されていないこと
- プレイリストの scope（自分 / サーバー）が別々の保存先を使うこと
- /music play が VC に自動で参加し、別の機能が使用中なら断ること
"""

import inspect
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from discord import app_commands  # noqa: E402

from core import legacy as legacy_module  # noqa: E402
from cogs import sio_music  # noqa: E402
from tests.test_all_commands import FakeSupabase  # noqa: E402
from tests.test_voice_session import make_bot, make_world  # noqa: E402


class FakeResponse:
    def __init__(self, interaction):
        self.interaction = interaction
        self.done = False

    def is_done(self):
        return self.done

    async def defer(self, **kwargs):
        self.done = True

    async def send_message(self, content=None, **kwargs):
        self.done = True
        self.interaction.sent.append((content, kwargs))


class FakeInteraction:
    def __init__(self, world, user):
        self.guild, self.guild_id, self.user = world.guild, world.guild.id, user
        self.channel, self.channel_id, self.id = world.text, world.text.id, 4242
        self.sent = []
        self.response = FakeResponse(self)
        self.followup = types.SimpleNamespace(send=self._followup)

    async def _followup(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return types.SimpleNamespace(edit=AsyncMock())

    async def original_response(self):
        return types.SimpleNamespace(edit=AsyncMock())

    def texts(self):
        out = []
        for content, kwargs in self.sent:
            embed = kwargs.get('embed')
            out.append(str(content if content is not None else (embed.description if embed else '')))
        return '\n'.join(out)


class FakeCtx:
    def __init__(self, world, user, attachments=()):
        self.guild, self.author, self.channel, self.prefix = world.guild, user, world.text, '!'
        self.message = types.SimpleNamespace(attachments=list(attachments))
        self.sent = []

    @property
    def voice_client(self):
        return self.guild.voice_client

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return types.SimpleNamespace(edit=AsyncMock())

    def texts(self):
        out = []
        for content, kwargs in self.sent:
            embed = kwargs.get('embed')
            out.append(str(content if content is not None else (embed.description if embed else '')))
        return '\n'.join(out)


def choice(value):
    return app_commands.Choice(name=str(value), value=value)


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.bot.supabase = FakeSupabase()
        self.bot.get_guild = lambda gid: self.w.guild if gid == self.w.guild.id else None
        self.w = make_world()
        self.cog = sio_music.VoiceCog(self.bot)

    async def asyncTearDown(self):
        await self.manager.close()

    def interaction(self, user=None):
        return FakeInteraction(self.w, user or self.w.alice)

    def ctx(self, user=None, attachments=()):
        return FakeCtx(self.w, user or self.w.alice, attachments)

    async def slash(self, command, interaction, **kwargs):
        return await command.callback(self.cog, interaction, **kwargs)

    async def prefix(self, command, ctx, *args, **kwargs):
        return await command.callback(self.cog, ctx, *args, **kwargs)


class SubcommandImplementationTest(Base):
    """/music のサブコマンドが、実装関数（_xxx_impl）を正しい引数で呼ぶ。"""

    def group_command(self, name):
        return self.cog.music_group.get_command(name)

    @staticmethod
    def bound(impl, call):
        """実装関数に渡った引数を、既定値を補ったうえで（呼び出し元 = 第1引数を除いて）返す。"""
        signature = inspect.signature(getattr(sio_music.VoiceCog, impl))
        arguments = signature.bind(None, *call.args, **call.kwargs)
        arguments.apply_defaults()
        values = dict(arguments.arguments)
        values.pop('self')
        values.pop(next(iter(values)))  # interaction / Responder
        return values

    async def check(self, impl, name, kwargs, expected):
        mock = AsyncMock()
        with patch.object(self.cog, impl, mock):
            await self.slash(self.group_command(name), self.interaction(), **kwargs)
        self.assertEqual(mock.await_count, 1, impl)
        self.assertEqual(self.bound(impl, mock.await_args), expected, f'/music {name}')

    async def test_five_subcommands(self):
        names = sorted(c.name for c in self.cog.music_group.commands)
        self.assertEqual(names, sorted([
            'play', 'control', 'sound', 'library', 'panel']))

    async def test_interaction_based(self):
        await self.check('_play_impl', 'play', {'query': 'song'}, {'query': 'song', 'file': None, 'start_at': None})
        await self.check('_pause_impl', 'control', {'action': choice('pause')}, {})
        await self.check('_skip_impl', 'control', {'action': choice('skip')}, {})
        await self.check('_queue_impl', 'control', {'action': choice('queue')}, {})
        await self.check('_shuffle_impl', 'control', {'action': choice('shuffle')}, {})
        await self.check('_seek_impl', 'control', {'action': choice('seek'), 'seconds': 12.0}, {'seconds': 12.0})
        await self.check('_loop_impl', 'control', {'action': choice('loop'), 'loop_mode': choice('track')}, {'mode': 'track'})
        await self.check('_eq_impl', 'sound', {'action': choice('eq'), 'preset': 'bass'}, {'mode': 'bass'})

    async def test_responder_based(self):
        await self.check('_stop_impl', 'control', {'action': choice('stop')}, {})
        await self.check('_volume_impl', 'sound', {'action': choice('volume'), 'value': 0.5}, {'value': 0.5})
        await self.check('_speed_impl', 'sound', {'action': choice('speed'), 'value': 1.5}, {'value': 1.5})
        await self.check('_panel_impl', 'panel', {}, {})
        await self.check('_search_impl', 'library', {'action': choice('search'), 'query': 'abc'}, {'keyword': 'abc'})
        await self.check('_files_impl', 'library', {'action': choice('files'), 'limit': 20}, {'limit': 20})

    async def test_spatial(self):
        none = {'feedback': None, 'wet': None, 'resolution': None}
        await self.check('_spatial_impl', 'sound', {'action': choice('spatial')}, none)
        await self.check('_spatial_impl', 'sound', {'action': choice('spatial'), 'feedback': 0.4, 'wet': 0.5}, {**none, 'feedback': 0.4, 'wet': 0.5})
        await self.check('_spatial_impl', 'sound', {'action': choice('spatial'), 'resolution': 8}, {**none, 'resolution': 8})

    async def test_playlist(self):
        def kwargs(action, name=None, scope=None):
            return {'action': choice('playlist'), 'playlist_action': choice(action), 'name': name, 'scope': choice(scope) if scope else None}
        await self.check('_playlist_impl', 'library', kwargs('save', 'mix'),
                         {'action': 'save', 'name': 'mix', 'scope': 'me', 'file': None})
        await self.check('_playlist_impl', 'library', kwargs('list'),
                         {'action': 'list', 'name': None, 'scope': 'me', 'file': None})
        await self.check('_playlist_impl', 'library', kwargs('play', 'mix', 'server'),
                         {'action': 'play', 'name': 'mix', 'scope': 'server', 'file': None})
        await self.check('_playlist_impl', 'library', kwargs('delete', 'mix', 'server'),
                         {'action': 'delete', 'name': 'mix', 'scope': 'server', 'file': None})


# 削除した旧コマンド（移行期間を終えて PR で削除）
REMOVED_SLASH = ['join', 'leave', 'play', 'pause', 'skip', 'seek', 'loop', 'shuffle', 'queue', 'playlist', 'eq',
                 'spatial', 'speak', 'spotify_link', 'spotify_unlink', 'spotify_playlists']
REMOVED_PREFIX = ['panel', 'search', 'list', 'plist', 'save_current', 'plsave', 'pllist', 'plplay', 'volume',
                  'speed', 'stop_all', 'rval', 'rres']


class LegacyRemovedTest(Base):
    def test_old_slash_commands_are_not_registered(self):
        names = {c.name for c in self.cog.get_app_commands()}
        self.assertEqual(names & set(REMOVED_SLASH), set())
        self.assertIn('music', names)

    def test_old_prefix_commands_are_not_registered(self):
        names = {c.qualified_name for c in self.cog.walk_commands()}
        self.assertEqual(names & set(REMOVED_PREFIX), set())
        self.assertIn('ffversion', names)  # 持ち主向けの確認コマンドは残す

    def test_new_commands_have_no_notice(self):
        self.assertFalse(hasattr(legacy_module, 'legacy'))
        self.assertFalse(hasattr(legacy_module, 'NOTICES'))


class PlaylistScopeTest(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        state = self.cog.get_state(self.w.guild.id)
        state['current_track'] = ('https://cdn/x.mp3', 'upload.mp3', 10, 'ID1', False)
        await state['queue'].put(('https://youtube.com/watch?v=a', 'yt song', None, True))
        await state['queue'].put(('https://cdn/y.mp3', 'upload2.mp3', 'ID2', False))
        self.playlist = self.cog.music_group.get_command('library')

    async def run_playlist(self, action, name=None, scope=None, user=None, file=None):
        interaction = self.interaction(user)
        await self.slash(self.playlist, interaction, action=choice('playlist'), playlist_action=choice(action), name=name,
                         scope=choice(scope) if scope else None, file=file)
        return interaction

    async def test_save_scopes_use_separate_tables(self):
        await self.run_playlist('save', 'mine', 'me')
        await self.run_playlist('save', 'shared', 'server')
        tables = self.bot.supabase.tables
        personal = tables['user_music_playlists']
        self.assertEqual([(r['owner_user_id'], r['name'], len(r['tracks'])) for r in personal],
                         [(self.w.alice.id, 'mine', 3)])
        self.assertEqual(tables['playlists'][0]['name'], f'{self.w.guild.id}:shared')
        self.assertEqual(tables['playlists'][0]['ids'][:1], ['ID1'])
        self.assertEqual(tables['playlists'][0]['ids'][1]['input'], 'https://youtube.com/watch?v=a')
        self.assertTrue(tables['playlists'][0]['ids'][1]['is_youtube'])

    async def test_list_scopes(self):
        await self.run_playlist('save', 'mine', 'me')
        await self.run_playlist('save', 'shared', 'server')
        self.bot.supabase.tables['playlists'].append({'name': '999:other-guild', 'ids': ['X']})
        mine = await self.run_playlist('list', scope='me')
        server = await self.run_playlist('list', scope='server')
        bob = await self.run_playlist('list', scope='me', user=self.w.bob)
        self.assertIn('mine', mine.texts())
        self.assertNotIn('shared', mine.texts())
        self.assertIn('shared', server.texts())
        self.assertNotIn('other-guild', server.texts())
        self.assertIn('登録されていません', bob.texts())

    async def test_default_scope_is_personal(self):
        await self.run_playlist('save', 'mine')
        self.assertIn('user_music_playlists', self.bot.supabase.tables)
        self.assertNotIn('playlists', self.bot.supabase.tables)

    async def test_play_server_playlist_by_name_ids_and_json(self):
        await self.run_playlist('save', 'shared', 'server')
        loaded = AsyncMock()
        connect = AsyncMock(return_value=None)
        with patch.object(self.cog, 'start_playlist_load', loaded), \
                patch.object(self.cog, '_ensure_music_connection', connect):
            await self.run_playlist('play', 'shared', 'server')
            await self.run_playlist('play', 'AAA, BBB', 'server')
            attachment = types.SimpleNamespace(read=AsyncMock(return_value=json.dumps(['J1', 'J2']).encode()))
            await self.run_playlist('play', None, 'server', file=attachment)
        inputs = [[t['input'] for t in call.args[1]] for call in loaded.await_args_list]
        self.assertEqual(inputs, [['ID1', 'ID2'], ['AAA', 'BBB'], ['J1', 'J2']])

    async def test_play_personal_playlist(self):
        await self.run_playlist('save', 'mine', 'me')
        loaded = AsyncMock()
        with patch.object(self.cog, 'start_playlist_load', loaded), \
                patch.object(self.cog, '_ensure_music_connection', AsyncMock(return_value=None)):
            await self.run_playlist('play', 'mine', 'me')
            missing = await self.run_playlist('play', 'nothing', 'me')
        self.assertEqual(len(loaded.await_args.args[1]), 3)
        self.assertIn('見つかりません', missing.texts())

    async def test_reads_rows_saved_by_old_commands(self):
        # 旧 !save_current（playlists に "ギルドID:名前"）で保存された行も、scope:サーバー で見える
        self.bot.supabase.tables.setdefault('playlists', []).append(
            {'id': 99, 'name': f'{self.w.guild.id}:old-saved', 'ids': ['X1']})
        server = await self.run_playlist('list', scope='server')
        self.assertIn('old-saved', server.texts())

    async def test_delete_scoped_playlist(self):
        await self.run_playlist('save', 'mine', 'me')
        await self.run_playlist('save', 'shared', 'server')
        await self.run_playlist('delete', 'mine', 'me')
        self.assertFalse(self.bot.supabase.tables['user_music_playlists'])
        self.assertTrue(self.bot.supabase.tables['playlists'])
        await self.run_playlist('delete', 'shared', 'server')
        self.assertFalse(self.bot.supabase.tables['playlists'])

    async def test_direct_attachment_url_can_be_loaded_without_message_lookup(self):
        url = 'https://cdn.discordapp.com/attachments/1/2/song.mp3?x=1'
        self.assertEqual(await self.cog.get_attachment_info(url, self.w.guild.id), (url, 'song.mp3'))


class PlayAutoJoinTest(Base):
    async def test_play_auto_joins(self):
        info = {'webpage_url': 'https://youtube.com/watch?v=x', 'title': 'テスト曲'}
        with patch.object(self.cog, 'get_yt_info', AsyncMock(return_value=info)), \
                patch.object(self.cog, 'check_queue', AsyncMock()) as check_queue:
            interaction = self.interaction()
            await self.slash(self.cog.music_group.get_command('play'), interaction, query='テスト')
        self.assertEqual(self.w.voice.connect_calls, 1)
        self.assertEqual(self.manager.owner(self.w.guild.id), 'music')
        self.assertEqual(self.manager.get(self.w.guild.id).user_id, self.w.alice.id)
        self.assertEqual(self.cog.get_state(self.w.guild.id)['queue'].qsize(), 1)
        check_queue.assert_awaited()
        self.assertIn('再生を開始します', interaction.texts())

    async def test_play_refused_while_other_feature_holds_vc(self):
        await self.manager.acquire(self.w.guild, self.w.voice, 'record', self.w.alice)
        vc = self.w.guild.voice_client
        with patch.object(self.cog, 'get_yt_info', AsyncMock()) as yt:
            interaction = self.interaction(self.w.bob)
            await self.slash(self.cog.music_group.get_command('play'), interaction, query='テスト')
        self.assertIn('録音', interaction.texts())
        yt.assert_not_awaited()
        self.assertTrue(vc.is_connected())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')
        self.assertEqual(self.cog.get_state(self.w.guild.id)['queue'].qsize(), 0)

    async def test_play_needs_user_in_voice(self):
        self.w.alice.voice = None
        interaction = self.interaction()
        await self.slash(self.cog.music_group.get_command('play'), interaction, query='テスト')
        self.assertIn('ボイスチャンネルに参加', interaction.texts())
        self.assertEqual(self.w.voice.connect_calls, 0)

    async def test_panel_auto_joins(self):
        interaction = self.interaction()
        await self.slash(self.cog.music_group.get_command('panel'), interaction)
        self.assertEqual(self.manager.owner(self.w.guild.id), 'music')
        self.assertIsNotNone(self.cog.get_state(self.w.guild.id)['panel_message'])

    async def test_spatial_options_set_values(self):
        interaction = self.interaction()
        await self.slash(self.cog.music_group.get_command('sound'), interaction, action=choice('spatial'), feedback=0.4, wet=0.2, resolution=8)
        state = self.cog.get_state(self.w.guild.id)
        self.assertEqual((state['fdn_feedback'], state['fdn_wet'], state['fdn_resolution']), (0.4, 0.2, 8))
        interaction = self.interaction()
        await self.slash(self.cog.music_group.get_command('sound'), interaction, action=choice('spatial'), resolution=5)
        self.assertIn('4', interaction.texts())
        self.assertEqual(state['fdn_resolution'], 8)

    async def test_stop_clears_queue(self):
        await self.manager.acquire(self.w.guild, self.w.voice, 'music', self.w.alice)
        state = self.cog.get_state(self.w.guild.id)
        await state['queue'].put(('u', 't', None, True))
        interaction = self.interaction()
        await self.slash(self.cog.music_group.get_command('control'), interaction, action=choice('stop'))
        self.assertEqual(state['queue'].qsize(), 0)
        self.assertTrue(self.w.guild.voice_client.is_connected())


if __name__ == '__main__':
    unittest.main()
