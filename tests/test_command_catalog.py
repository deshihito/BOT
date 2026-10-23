"""コマンドカタログ（core/command_catalog.py・core/command_meta.py）と /help・!help のテスト。

全 cog を tools/export_commands.py と同じ方法でオフラインに読み込み（Discord・Supabase には接続しない）、
- 登録されているコマンドすべてに command_meta のカテゴリがあること
- 書き出した JSON が合意した形式どおりであること
- /help がどのカテゴリも Discord の上限内で表示でき、候補の補完が動くこと
を確かめる。
"""

import asyncio
import contextlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools import export_commands  # noqa: E402

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

from core import command_catalog, command_meta  # noqa: E402
from core.command_catalog import build_catalog, command_key, registered_commands, validate_catalog  # noqa: E402

LIMITS = {'title': 256, 'description': 4096, 'field_name': 256, 'field_value': 1024, 'fields': 25, 'total': 6000,
          'footer': 2048}


def assert_embed_ok(test, embed, label):
    test.assertLessEqual(len(embed.title or ''), LIMITS['title'], f'{label}: タイトルが長すぎます')
    test.assertLessEqual(len(embed.description or ''), LIMITS['description'], f'{label}: 説明が長すぎます')
    test.assertLessEqual(len(embed.fields), LIMITS['fields'], f'{label}: フィールドが多すぎます')
    for field in embed.fields:
        test.assertTrue(field.name and field.value, f'{label}: 空のフィールドがあります')
        test.assertLessEqual(len(field.name), LIMITS['field_name'], f'{label}: {field.name}')
        test.assertLessEqual(len(field.value), LIMITS['field_value'], f'{label}: {field.name}')
    test.assertLessEqual(len(embed), LIMITS['total'], f'{label}: 埋め込み全体が長すぎます')


def assert_view_ok(test, view, label):
    test.assertLessEqual(len(view.children), 25, label)
    for item in view.children:
        if isinstance(item, discord.ui.Select):
            test.assertTrue(1 <= len(item.options) <= 25, f'{label}: 選択肢の数 {len(item.options)}')
            for option in item.options:
                test.assertLessEqual(len(option.label), 100, f'{label}: {option.label}')
                test.assertLessEqual(len(option.value), 100, f'{label}: {option.value}')
                test.assertLessEqual(len(option.description or ''), 100, f'{label}: {option.label}')


class FakeResponse:
    def __init__(self):
        self.calls = []

    async def send_message(self, content=None, **kwargs):
        self.calls.append(('send_message', content, kwargs))

    async def edit_message(self, **kwargs):
        self.calls.append(('edit_message', None, kwargs))


def fake_interaction(bot):
    return types.SimpleNamespace(client=bot, user=MagicMock(id=1), response=FakeResponse())


class CommandCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = export_commands.offline_environment()
        cls.environment.__enter__()
        cls.loop = asyncio.new_event_loop()
        try:
            cls.bot, cls.skipped = cls.loop.run_until_complete(export_commands.load_offline_bot())
            cls.catalog = build_catalog(cls.bot)
            cls.cog = cls.bot.get_cog('HelpCog')
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if not cls.loop.is_closed():
            for task in asyncio.all_tasks(cls.loop):
                task.cancel()
            with contextlib.suppress(Exception):
                cls.loop.run_until_complete(asyncio.sleep(0))
            cls.loop.close()
        cls.environment.__exit__(None, None, None)

    def run_async(self, coro):
        return self.loop.run_until_complete(coro)

    # ------------------------------------------------------------ メタデータ
    def test_every_registered_command_has_metadata(self):
        missing = sorted(set(registered_commands(self.bot)) - set(command_meta.COMMAND_META))
        self.assertEqual(missing, [], 'core/command_meta.py の COMMAND_META に、これらのコマンドの '
                                      'category（と必要なら summary・hidden など）を追加してください')

    def test_metadata_refers_to_existing_commands(self):
        stale = sorted(set(command_meta.COMMAND_META) - set(registered_commands(self.bot))
                       - set(command_meta.OPTIONAL_COMMANDS))
        self.assertEqual(stale, [], 'COMMAND_META に、もう存在しないコマンドが残っています（消すか OPTIONAL_COMMANDS へ）')

    def test_removed_legacy_voice_commands_are_gone(self):
        """移行期間を終えて削除した旧ボイス・音楽コマンドが、登録にも COMMAND_META にも残っていない。"""
        removed = [
            '/join', '/leave', '/play', '/pause', '/skip', '/seek', '/loop', '/shuffle', '/queue', '/playlist',
            '/voice join', '/voice leave', '/voice status', '/voice record', '/voice echo', '/voice transcribe',
            '/voice karaoke', '/voice changer', '/voice match', '/voice global', '/bumprta best', '/bumprta ranking',
            '/bumprta notifications', '/bumprta status', '/bumprta leaderboard',
            '/eq', '/spatial', '/speak', '/spotify_link', '/spotify_unlink', '/spotify_playlists',
            '!panel', '!search', '!list', '!plist', '!save_current', '!plsave', '!pllist', '!plplay', '!volume',
            '!speed', '!stop_all', '!rval', '!rres', '!rec', '!echo', '!stt', '!karaoke', '!vc', '!saito',
            '!saito_stop', '!gvc join', '!gvc leave',
            '/muted', '/whisper', '/clear', '/bumprta',
        ]
        registered = set(registered_commands(self.bot))
        for key in removed:
            with self.subTest(command=key):
                self.assertNotIn(key, registered)
                self.assertNotIn(key, command_meta.COMMAND_META)
                self.assertIsNone(command_catalog.find_command(self.catalog, key, include_hidden=True))
        self.assertFalse([k for k in registered if k.split(' ')[0] in ('!rec', '!echo', '!stt', '!karaoke', '!vc')])
        for key in ('/music', '/voice', '/support', '!gvc create', '!gvc chat connect', '!ffversion'):
            with self.subTest(kept=key):
                self.assertIn(key, registered)

    def test_consolidated_support_commands_are_gone(self):
        """/setup に入れたサポート系コマンドが、登録にも COMMAND_META にもサイトの一覧にも残っていない。"""
        registered = set(registered_commands(self.bot))
        site = self.site_command_keys()
        for key in ('/send_panel', '/sync_category_perms', '/chat'):
            with self.subTest(command=key):
                self.assertNotIn(key, registered)
                self.assertNotIn(key, command_meta.COMMAND_META)
                self.assertNotIn(key, site)
        self.assertNotIn('/setup', registered)
        self.assertNotIn('/setup', command_meta.COMMAND_META)

    @staticmethod
    def site_command_keys():
        data = json.loads((ROOT / 'web' / 'data' / 'commands.sample.json').read_text(encoding='utf-8'))
        return {command_key(c['kind'], c['name']) for c in data['commands']}

    def test_site_sample_catalog_matches_code(self):
        """サイト（web/lib/catalog.ts が読む web/data/commands.sample.json）に、コードに無いコマンドが載っていない。"""
        stale = sorted(self.site_command_keys() - set(registered_commands(self.bot)))
        self.assertEqual(stale, [], 'web/data/commands.sample.json に、もう存在しないコマンドがあります')

    def test_game_hub_duplicates_are_gone(self):
        """/game で代わりになるので外したゲームの / コマンドが、登録・COMMAND_META・案内文・サイトのデータに残っていない。"""
        from core.game_guides import GAME_GUIDES
        removed = ['/jinrou_help', '/wordwolf', '/uno_start', '/jinrou', '/uno_end', '/kill',
                   '/jinrou_rating', '/jinrou_ranking', '/guess', '/flash']
        registered = set(registered_commands(self.bot))
        guides = json.dumps(GAME_GUIDES, ensure_ascii=False)
        for key in removed:
            with self.subTest(command=key):
                self.assertNotIn(key, registered)
                self.assertNotIn(key, command_meta.COMMAND_META)
                self.assertIsNone(command_catalog.find_command(self.catalog, key, include_hidden=True))
                self.assertNotIn(f'`{key}`', guides)
                self.assertNotIn(f'"{key}"', guides)
        for key in ('/game',):
            with self.subTest(kept=key):
                self.assertIn(key, registered)

    def test_web_sample_catalog_has_no_removed_commands(self):
        """サイト（web/lib/catalog.ts が読む web/data）のコマンドに、外したコマンドが入っていない。"""
        data_dir = Path(__file__).resolve().parent.parent / 'web' / 'data'
        removed = {'jinrou_help', 'wordwolf', 'uno_start', 'jinrou', 'uno_end', 'kill', 'jinrou_rating', 'jinrou_ranking', 'guess', 'flash'}
        for file in sorted(data_dir.glob('commands*.json')):
            names = {c['name'] for c in json.loads(file.read_text(encoding='utf-8'))['commands'] if c['kind'] == 'slash'}
            with self.subTest(file=file.name):
                self.assertFalse(names & removed)

    def test_categories_are_valid(self):
        ids = [c['id'] for c in command_meta.CATEGORIES]
        self.assertEqual(ids, ['support', 'economy', 'game', 'voice', 'fun', 'admin'])
        for category in command_meta.CATEGORIES:
            self.assertTrue(category['label'] and category['description'], category['id'])
        for key, meta in command_meta.COMMAND_META.items():
            with self.subTest(command=key):
                self.assertIn(meta.get('category'), ids, 'category は CATEGORIES の id にしてください')
        self.assertNotIn('other', [c['id'] for c in self.catalog['categories']], '「その他」に入ったコマンドがあります')

    def test_every_category_has_visible_commands(self):
        for category in command_meta.CATEGORIES:
            with self.subTest(category=category['id']):
                self.assertTrue(command_catalog.visible_commands(self.catalog, category['id']))

    def test_visible_commands_have_summary_and_usage(self):
        for entry in command_catalog.visible_commands(self.catalog):
            with self.subTest(command=command_key(entry['kind'], entry['name'])):
                self.assertTrue(entry['summary'].strip(), 'summary が空です（command_meta で補ってください）')
                self.assertTrue(entry['usage'].startswith('/' if entry['kind'] == 'slash' else '!'))

    def test_debug_and_owner_commands_are_hidden(self):
        for key in ('!terminal', '!guild', '!all_stats', '!d1ping', '!check_api', '!dungeon_reset', '!coin'):
            with self.subTest(command=key):
                entry = command_catalog.find_command(self.catalog, key, include_hidden=True)
                self.assertTrue(entry['hidden'])
                self.assertIsNone(command_catalog.find_command(self.catalog, key))

    def test_nation_prefix_commands_are_hidden_from_help(self):
        for key in ('!nation', '!nation found', '!nation join', '!nation status'):
            with self.subTest(command=key):
                self.assertIsNone(command_catalog.find_command(self.catalog, key))
                self.assertTrue(command_catalog.find_command(self.catalog, key, include_hidden=True)['hidden'])

    def test_all_prefix_commands_are_hidden_from_help(self):
        for entry in self.catalog['commands']:
            if entry['kind'] == 'prefix':
                with self.subTest(command=command_key(entry['kind'], entry['name'])):
                    self.assertTrue(entry['hidden'])
                    self.assertIsNone(command_catalog.find_command(self.catalog, command_key(entry['kind'], entry['name'])))

    def test_permissions_and_guild_only_are_discovered(self):
        def get(key):
            return command_catalog.find_command(self.catalog, key, include_hidden=True)
        self.assertTrue(get('/support')['guild_only'])
        self.assertEqual(get('/support')['options'], [])
        self.assertTrue(get('!nation found')['guild_only'])
        self.assertIn('administrator', get('!nation found')['permissions'])
        self.assertIn('manage_channels', get('!mimic_toggle')['permissions'])
        self.assertTrue(get('/music')['guild_only'])
        self.assertEqual(get('/music')['options'], [])
        self.assertEqual(get('/voice')['options'], [])
        self.assertEqual(get('!all_stats')['aliases'], ['stats', 'spec'])

    def test_guide_key_reads_game_guides_when_available(self):
        fake = {'doubt': {'guide': '## 遊び方\nカードを出します。'}}
        with patch.object(command_meta, 'game_guides', return_value=fake):
            catalog = build_catalog(self.bot)
        doubt = command_catalog.find_command(catalog, '!doubt', include_hidden=True)
        self.assertEqual(doubt['guide'], fake['doubt']['guide'])
        with patch.object(command_meta, 'game_guides', return_value={}):
            catalog = build_catalog(self.bot)
        self.assertIsNone(command_catalog.find_command(catalog, '!doubt', include_hidden=True)['guide'])

    def test_guide_keys_exist_in_game_guides(self):
        guides = command_meta.game_guides()
        if not guides:
            self.skipTest('core/game_guides.py がまだありません')
        for key, meta in command_meta.COMMAND_META.items():
            if meta.get('guide_key'):
                with self.subTest(command=key):
                    self.assertIn(meta['guide_key'], guides)

    # ------------------------------------------------------------ 書き出し
    def test_catalog_matches_schema(self):
        self.assertEqual(validate_catalog(self.catalog), [])

    def test_export_writes_valid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'commands.json'
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(export_commands.main(['-o', str(path)]), 0)
            text = path.read_text(encoding='utf-8')
        catalog = json.loads(text)
        self.assertEqual(validate_catalog(catalog), [])
        self.assertEqual(len(catalog['commands']), len(self.catalog['commands']))
        self.assertIn('パーティーゲーム', text, '日本語はそのまま（\\u エスケープせずに）書き出すはず')

    def test_export_to_stdout_prints_only_json(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            export_commands.main([])
        self.assertEqual(validate_catalog(json.loads(out.getvalue())), [])

    # ------------------------------------------------------------ /help
    def test_help_renders_every_category_within_limits(self):
        from cogs import help as help_module

        async def check():
            overview = help_module.HelpView(self.catalog)
            self.assertIn("今北産業", overview.embed().description)
            assert_embed_ok(self, overview.embed(), 'overview')
            assert_view_ok(self, overview, 'overview')
            for category in self.catalog['categories']:
                pages = help_module.category_pages(self.catalog, category['id'])
                text = '\n'.join(page.description for page in pages)
                for number, page in enumerate(pages):
                    assert_embed_ok(self, page, f"{category['id']} p{number + 1}")
                    view = help_module.HelpView(self.catalog, category['id'], number)
                    assert_view_ok(self, view, f"{category['id']} p{number + 1}")
                for entry in command_catalog.visible_commands(self.catalog, category['id']):
                    self.assertIn(f"`{entry['usage'][:150]}", text, f"{entry['name']} が一覧に出ていません")
                if category['guide']:
                    assert_embed_ok(self, help_module.guide_embed(category['label'], category['guide']), category['id'])
        self.run_async(check())

    def test_every_command_detail_and_guide_within_limits(self):
        from cogs import help as help_module

        async def check():
            for entry in self.catalog['commands']:
                label = command_key(entry['kind'], entry['name'])
                assert_embed_ok(self, help_module.command_embed(entry, self.catalog), label)
                assert_view_ok(self, help_module.CommandView(self.catalog, entry), label)
                if entry['guide']:
                    assert_embed_ok(self, help_module.guide_embed(label, entry['guide']), label + ' guide')
        self.run_async(check())

    def test_long_guide_and_many_commands_are_clipped(self):
        from cogs import help as help_module
        entry = dict(command_catalog.find_command(self.catalog, '/user_status'), guide='## 見出し\n' + 'あ' * 9000)
        embed = help_module.guide_embed('/user_status', entry['guide'])
        self.assertLessEqual(len(embed.description), 4096)
        self.assertTrue(embed.description.startswith('**見出し**'))
        many = dict(self.catalog, commands=[dict(entry, name=f'cmd{i}', category='economy', guide=None)
                                            for i in range(300)])
        pages = help_module.category_pages(many, 'economy')
        self.assertGreater(len(pages), 1)
        for page in pages:
            assert_embed_ok(self, page, 'many')

    def test_autocomplete(self):
        complete = self.cog.help_command_autocomplete
        interaction = fake_interaction(self.bot)
        choices = self.run_async(complete(interaction, 'user'))
        self.assertEqual(choices[0].value, '/user_status')
        everything = self.run_async(complete(interaction, ''))
        self.assertEqual(len(everything), 25)
        for choice in everything:
            self.assertLessEqual(len(choice.name), 100)
            self.assertLessEqual(len(choice.value), 100)
        self.assertEqual(self.run_async(complete(interaction, '!gvc cr')), [])
        self.assertIn('/pay', [c.value for c in self.run_async(complete(interaction, '送金'))])
        self.assertEqual(self.run_async(complete(interaction, 'terminal')), [])

    def test_help_command_overview_detail_and_unknown(self):
        callback = self.cog.help.callback
        interaction = fake_interaction(self.bot)
        self.run_async(callback(self.cog, interaction))
        name, content, kwargs = interaction.response.calls[-1]
        self.assertTrue(kwargs['ephemeral'])
        self.assertEqual(kwargs['embed'].title, 'コマンド一覧')
        self.assertIsNotNone(kwargs['view'])

        self.run_async(callback(self.cog, interaction, command='/user_status'))
        self.assertEqual(interaction.response.calls[-1][2]['embed'].title, '/user_status')
        self.run_async(callback(self.cog, interaction, command='gvc create'))
        self.assertIn('見つかりませんでした', interaction.response.calls[-1][1])
        self.run_async(callback(self.cog, interaction, command='存在しない'))
        self.assertIn('見つかりませんでした', interaction.response.calls[-1][1])
        self.run_async(callback(self.cog, interaction, command='!terminal'))
        self.assertIn('見つかりませんでした', interaction.response.calls[-1][1])

    def test_help_view_navigation(self):
        from cogs import help as help_module

        async def run():
            interaction = fake_interaction(self.bot)
            view = help_module.HelpView(self.catalog)
            await view.show(interaction, 'voice', 0)
            embed, voice_view = interaction.response.calls[-1][2]['embed'], interaction.response.calls[-1][2]['view']
            self.assertTrue(embed.title.startswith('ボイス・音楽'))
            if len(voice_view.pages) > 1:
                await voice_view.next_page.callback(interaction)
                self.assertEqual(interaction.response.calls[-1][2]['view'].page, 1)
            await voice_view.back_to_top.callback(interaction)
            self.assertEqual(interaction.response.calls[-1][2]['embed'].title, 'コマンド一覧')
            game_view = help_module.HelpView(self.catalog, 'game')
            guide_select = next((i for i in game_view.children if isinstance(i, help_module.GuideSelect)), None)
            self.assertIsNotNone(guide_select, 'パーティーゲームのカテゴリ説明が選べるはず')
            guide_select._values = [help_module.CATEGORY_GUIDE]
            await guide_select.callback(interaction)
            self.assertIn('パーティーゲーム', interaction.response.calls[-1][2]['embed'].title)
        self.run_async(run())

    # ------------------------------------------------------------ !help
    def test_prefix_help_uses_catalog(self):
        help_command = self.bot.help_command.copy()
        sent = []
        channel = MagicMock()

        async def send(content=None, **kwargs):
            sent.append((content, kwargs))
        channel.send = send
        ctx = MagicMock(spec=commands.Context)
        ctx.bot, ctx.channel, ctx.send, ctx.clean_prefix = self.bot, channel, send, '!'
        help_command.context = ctx
        self.run_async(help_command.send_bot_help({}))
        self.assertIn('/help', sent[-1][1]['embed'].description)
        self.run_async(help_command.command_callback(ctx, command='user_status'))
        self.assertEqual(sent[-1][1]['embed'].title, '/user_status')
        self.assertIn('見つかりませんでした', help_command.command_not_found('xyz'))
        self.assertEqual(self.bot.get_command('help').name, 'help')


if __name__ == '__main__':
    unittest.main()
