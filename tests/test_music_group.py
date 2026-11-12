"""/music グループ（PR-B）のテスト。Discord・Supabase には接続しない。

現行構造（メソッド＋パネル方式）への対応メモ:
- 旧 /music グループ（app_commands.Group）は廃止され、入口は /vc パネル
  （VoiceHub.dispatch_voice_action）と音楽パネル／モーダルに移った。
  そのため「サブコマンドが実装関数を正しい引数で呼ぶ」検証は、現行の
  振り分け層（dispatch_voice_action・MusicSearchModal・PlaylistNameModal・
  PlaylistLibraryView）が各 _xxx_impl を正しい引数で呼ぶことで確認する。
- 一時停止・スキップ・ループ・シャッフル・停止は、現行では音楽パネルの
  ボタンが状態を直接操作し、impl への引数変換層が存在しない。変換層の
  検証は意味を失ったため削除し、停止の実挙動は PlayAutoJoinTest で、
  立体音響の値設定は _spatial_impl の実挙動で確認する。
- _play_impl / _seek_impl / _eq_impl / _volume_impl / _speed_impl は
  現行の振り分け層からは呼ばれない（impl 自体の挙動は _play_impl の
  自動参加テストで確認する）。

- 削除した旧コマンド（/play・!panel・/spotify_* など）が登録されていないこと
- プレイリストの scope（自分 / サーバー）が別々の保存先を使うこと
- 再生が VC に自動で参加し、別の機能が使用中なら断ること
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

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from discord import app_commands  # noqa: E402

from core.support import legacy as legacy_module  # noqa: E402
from core.support.legacy import Responder  # noqa: E402
from core.support.panel_v2 import embed_text  # noqa: E402
from core.vc import voice_entry as sio_voice  # noqa: E402
from core.vc.common import VOICE_ACTIONS_BY_GENRE  # noqa: E402
from core.vc.music import entry as sio_music  # noqa: E402
from tests.test_all_commands import FakeDBAPI  # noqa: E402
from tests.test_voice_session import make_bot, make_world  # noqa: E402


def _view_text(view):
    """Components V2 ビューから TextDisplay のテキストを集める（テスト用）。"""
    out = []

    def walk(item):
        content = getattr(item, 'content', None)
        if isinstance(content, str):
            out.append(content)
        for child in getattr(item, 'children', None) or []:
            walk(child)

    for top in getattr(view, 'children', []):
        walk(top)
    return '\n'.join(out)


def sent_text(content, kwargs):
    """送信1件分の本文テキスト（content / embed / V2 ビューを統一して読む）。"""
    parts = []
    if content is not None:
        parts.append(str(content))
    embed = kwargs.get('embed')
    if embed is not None:
        parts.append(embed_text(embed))
    view = kwargs.get('view')
    if view is not None:
        parts.append(_view_text(view))
    return '\n'.join(parts)


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

    async def send_modal(self, modal):
        self.done = True
        self.interaction.modals.append(modal)


class FakeInteraction:
    def __init__(self, world, user):
        self.guild, self.guild_id, self.user = world.guild, world.guild.id, user
        self.channel, self.channel_id, self.id = world.text, world.text.id, 4242
        self.sent = []
        self.modals = []
        self.response = FakeResponse(self)
        self.followup = types.SimpleNamespace(send=self._followup)

    async def _followup(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return types.SimpleNamespace(edit=AsyncMock())

    async def original_response(self):
        return types.SimpleNamespace(edit=AsyncMock())

    def texts(self):
        return '\n'.join(sent_text(content, kwargs) for content, kwargs in self.sent)


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
        return '\n'.join(sent_text(content, kwargs) for content, kwargs in self.sent)


def choice(value):
    return app_commands.Choice(name=str(value), value=value)


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.bot.db_api = FakeDBAPI()
        self.bot.get_guild = lambda gid: self.w.guild if gid == self.w.guild.id else None
        self.w = make_world()
        self.cog = sio_music.VoiceCog(self.bot)
        # VoiceHub._cog は bot.get_cog(クラス名) で引く（core/vc/common.py COGS）
        self.bot.get_cog = lambda name: self.cog if name == 'VoiceCog' else None
        self.hub = sio_voice.VoiceHub(self.bot)

    async def asyncTearDown(self):
        await self.manager.close()

    def interaction(self, user=None):
        return FakeInteraction(self.w, user or self.w.alice)

    def ctx(self, user=None, attachments=()):
        return FakeCtx(self.w, user or self.w.alice, attachments)

    async def dispatch(self, value, interaction=None, **kwargs):
        """現行の入口（/vc パネル・/quick 共通の振り分け）を叩く。"""
        interaction = interaction or self.interaction()
        await self.hub.dispatch_voice_action(interaction, value, **kwargs)
        return interaction


class SubcommandImplementationTest(Base):
    """現行の振り分け層が、実装関数（_xxx_impl）を正しい引数で呼ぶ。"""

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

    async def check_dispatch(self, impl, value, expected, **dispatch_kwargs):
        mock = AsyncMock()
        with patch.object(self.cog, impl, mock):
            interaction = await self.dispatch(value, **dispatch_kwargs)
        self.assertEqual(mock.await_count, 1, impl)
        self.assertEqual(self.bound(impl, mock.await_args), expected, f'dispatch {value}')
        return interaction, mock

    def test_music_actions_are_declared(self):
        # /vc パネルの音楽ジャンルに出る入口はこの7件（core/vc/common.py）
        values = [value for _label, value in VOICE_ACTIONS_BY_GENRE['music']]
        self.assertEqual(values, ['music_panel', 'music_playlist', 'music_spatial',
                                  'music_autoplay', 'music_queue', 'music_search', 'music_files'])
        # 音楽 cog 側の操作一覧（MUSIC_ACTIONS）も現行の操作集合と一致する
        names = sorted(c.value for c in sio_music.VoiceCog.MUSIC_ACTIONS)
        self.assertEqual(names, sorted([
            'play', 'panel', 'pause', 'skip', 'stop', 'seek', 'queue', 'loop', 'shuffle',
            'volume', 'speed', 'eq', 'spatial', 'search', 'playlist', 'files']))

    async def test_dispatch_panel_library_queue_files(self):
        # 音楽操作パネル → _panel_impl(Responder)
        interaction, mock = await self.check_dispatch('_panel_impl', 'music_panel', {})
        responder = mock.await_args.args[0]
        self.assertIsInstance(responder, Responder)
        self.assertIs(responder.source, interaction)
        # プレイリスト管理 → ライブラリ View を開く _playlist_library_impl(Responder)
        interaction, mock = await self.check_dispatch('_playlist_library_impl', 'music_playlist', {})
        self.assertIs(mock.await_args.args[0].source, interaction)
        # キュー表示 → _queue_impl(interaction)（Responder ではなく interaction 自体）
        interaction, mock = await self.check_dispatch('_queue_impl', 'music_queue', {})
        self.assertIs(mock.await_args.args[0], interaction)
        # 音声ファイルID一覧 → _files_impl(Responder)（limit は impl 既定値 20）
        interaction, mock = await self.check_dispatch('_files_impl', 'music_files', {'limit': 20})
        self.assertIs(mock.await_args.args[0].source, interaction)

    async def test_dispatch_spatial_opens_panel_without_values(self):
        # 入口からは値なしで呼ばれ、_spatial_impl が立体音響パネルを開く
        none = {'feedback': None, 'wet': None, 'resolution': None}
        await self.check_dispatch('_spatial_impl', 'music_spatial', none)

    async def test_search_modal_passes_keyword(self):
        # 楽曲検索はキーワードが要るためモーダルで聞いてから _search_impl へ渡す
        mock = AsyncMock()
        with patch.object(self.cog, '_search_impl', mock):
            interaction = await self.dispatch('music_search')
            self.assertEqual(len(interaction.modals), 1)
            modal = interaction.modals[0]
            modal.keyword._value = 'abc'
            submit = self.interaction()
            await modal.on_submit(submit)
        self.assertEqual(mock.await_count, 1)
        self.assertIs(mock.await_args.args[0].source, submit)
        self.assertEqual(self.bound('_search_impl', mock.await_args), {'keyword': 'abc'})

    async def test_playlist_modal_passes_action_name_scope(self):
        # 保存・再生・削除は PlaylistNameModal が名前を聞いて _playlist_impl へ渡す
        for action, name, scope in (('save', 'mix', 'me'), ('play', 'mix', 'server'),
                                    ('delete', 'mix', 'server')):
            mock = AsyncMock()
            with patch.object(self.cog, '_playlist_impl', mock):
                modal = sio_music.PlaylistNameModal(self.cog, action, scope)
                modal.name._value = name
                await modal.on_submit(self.interaction())
            self.assertEqual(mock.await_count, 1, action)
            self.assertEqual(self.bound('_playlist_impl', mock.await_args),
                             {'action': action, 'name': name, 'scope': scope, 'file': None}, action)

    async def test_playlist_library_list_button(self):
        # 一覧は PlaylistLibraryView のボタンが scope 付きで _playlist_impl を呼ぶ
        for scope in ('me', 'server'):
            mock = AsyncMock()
            with patch.object(self.cog, '_playlist_impl', mock):
                view = sio_music.PlaylistLibraryView(self.cog)
                view.scope = scope
                await view.list_button.callback(self.interaction())
            self.assertEqual(mock.await_count, 1, scope)
            self.assertEqual(self.bound('_playlist_impl', mock.await_args),
                             {'action': 'list', 'name': None, 'scope': scope, 'file': None}, scope)


# 削除した旧コマンド（移行期間を終えて PR で削除）
REMOVED_SLASH = ['join', 'leave', 'play', 'pause', 'skip', 'seek', 'loop', 'shuffle', 'queue', 'playlist', 'eq',
                 'spatial', 'speak', 'spotify_link', 'spotify_unlink', 'spotify_playlists']
REMOVED_PREFIX = ['panel', 'search', 'list', 'plist', 'save_current', 'plsave', 'pllist', 'plplay', 'volume',
                  'speed', 'stop_all', 'rval', 'rres']


class LegacyRemovedTest(Base):
    def test_old_slash_commands_are_not_registered(self):
        names = {c.name for c in self.cog.get_app_commands()}
        self.assertEqual(names & set(REMOVED_SLASH), set())
        # 現行では音楽 cog 自体はスラッシュコマンドを持たない（入口は VoiceHub の /vc）
        self.assertEqual(names, set())
        hub_names = {c.name for c in self.hub.get_app_commands()}
        self.assertEqual(hub_names, {'vc'})

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

    async def run_playlist(self, action, name=None, scope=None, user=None, file=None):
        interaction = self.interaction(user)
        scope = scope or 'me'
        if file is not None:
            # 添付ファイル（JSON / ID一覧）の入力は現行 UI に導線がないため impl を直接呼ぶ
            await self.cog._playlist_impl(Responder(interaction), action, name, scope, file=file)
        elif action == 'list':
            view = sio_music.PlaylistLibraryView(self.cog)
            view.scope = scope
            await view.list_button.callback(interaction)
        else:
            modal = sio_music.PlaylistNameModal(self.cog, action, scope)
            modal.name._value = name or ''
            await modal.on_submit(interaction)
        return interaction

    async def test_save_scopes_use_separate_tables(self):
        await self.run_playlist('save', 'mine', 'me')
        await self.run_playlist('save', 'shared', 'server')
        tables = self.bot.db_api.tables
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
        self.bot.db_api.tables['playlists'].append({'name': '999:other-guild', 'ids': ['X']})
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
        self.assertIn('user_music_playlists', self.bot.db_api.tables)
        self.assertNotIn('playlists', self.bot.db_api.tables)

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
        # サーバー保存では YouTube 曲も辞書で保存される（test_save_scopes_use_separate_tables）
        # ため、再生でも URL として往復する
        self.assertEqual(inputs, [['ID1', 'https://youtube.com/watch?v=a', 'ID2'],
                                  ['AAA', 'BBB'], ['J1', 'J2']])

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
        self.bot.db_api.tables.setdefault('playlists', []).append(
            {'id': 99, 'name': f'{self.w.guild.id}:old-saved', 'ids': ['X1']})
        server = await self.run_playlist('list', scope='server')
        self.assertIn('old-saved', server.texts())

    async def test_delete_scoped_playlist(self):
        await self.run_playlist('save', 'mine', 'me')
        await self.run_playlist('save', 'shared', 'server')
        await self.run_playlist('delete', 'mine', 'me')
        self.assertFalse(self.bot.db_api.tables['user_music_playlists'])
        self.assertTrue(self.bot.db_api.tables['playlists'])
        await self.run_playlist('delete', 'shared', 'server')
        self.assertFalse(self.bot.db_api.tables['playlists'])

    async def test_direct_attachment_url_can_be_loaded_without_message_lookup(self):
        url = 'https://cdn.discordapp.com/attachments/1/2/song.mp3?x=1'
        self.assertEqual(await self.cog.get_attachment_info(url, self.w.guild.id), (url, 'song.mp3'))


class PlayAutoJoinTest(Base):
    # 再生系の入口は現行では音楽パネル／検索だが、VC 自動参加の実挙動は
    # _play_impl / _panel_impl 自体が持つため、impl を直接呼んで確認する。
    async def test_play_auto_joins(self):
        info = {'webpage_url': 'https://youtube.com/watch?v=x', 'title': 'テスト曲'}
        with patch.object(self.cog, 'get_yt_info', AsyncMock(return_value=info)), \
                patch.object(self.cog, 'check_queue', AsyncMock()) as check_queue:
            interaction = self.interaction()
            await self.cog._play_impl(interaction, query='テスト')
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
            await self.cog._play_impl(interaction, query='テスト')
        self.assertIn('録音', interaction.texts())
        yt.assert_not_awaited()
        self.assertTrue(vc.is_connected())
        self.assertEqual(self.manager.owner(self.w.guild.id), 'record')
        self.assertEqual(self.cog.get_state(self.w.guild.id)['queue'].qsize(), 0)

    async def test_play_needs_user_in_voice(self):
        self.w.alice.voice = None
        interaction = self.interaction()
        await self.cog._play_impl(interaction, query='テスト')
        self.assertIn('ボイスチャンネルに参加', interaction.texts())
        self.assertEqual(self.w.voice.connect_calls, 0)

    async def test_panel_auto_joins(self):
        interaction = self.interaction()
        await self.cog._panel_impl(Responder(interaction))
        self.assertEqual(self.manager.owner(self.w.guild.id), 'music')
        self.assertIsNotNone(self.cog.get_state(self.w.guild.id)['panel_message'])

    async def test_spatial_options_set_values(self):
        interaction = self.interaction()
        await self.cog._spatial_impl(Responder(interaction), feedback=0.4, wet=0.2, resolution=8)
        state = self.cog.get_state(self.w.guild.id)
        self.assertEqual((state['fdn_feedback'], state['fdn_wet'], state['fdn_resolution']), (0.4, 0.2, 8))
        interaction = self.interaction()
        await self.cog._spatial_impl(Responder(interaction), resolution=5)
        self.assertIn('4', interaction.texts())
        self.assertEqual(state['fdn_resolution'], 8)

    async def test_stop_clears_queue(self):
        await self.manager.acquire(self.w.guild, self.w.voice, 'music', self.w.alice)
        state = self.cog.get_state(self.w.guild.id)
        await state['queue'].put(('u', 't', None, True))
        interaction = self.interaction()
        await self.cog._stop_impl(Responder(interaction))
        self.assertEqual(state['queue'].qsize(), 0)
        self.assertTrue(self.w.guild.voice_client.is_connected())


if __name__ == '__main__':
    unittest.main()
