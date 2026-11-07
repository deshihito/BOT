"""全コマンド（スラッシュ・プレフィックス）を実際に実行してみるテスト。Discord・外部には接続しない。

- DB API は呼び出し形をまねたメモリ上の偽クライアントに差し替える
  （``config.db_api`` / ``bot.db_api`` の両方）。
- ソケット接続とサブプロセスの起動（``sudo systemctl`` やシェル）を禁止する。Gemini・Groq・
  YouTube・D1 などの外部サービスには届かないので、「つながらなくても落ちずに返信する」ことを確かめる。
- 偽の ``Interaction`` / ``Context`` で全コマンドを代表的な引数で呼び出し、
  (1) 例外が外に出ないこと、(2) 何か返信があること（埋め込み・本文の文字数上限も確認）を確かめる。
- ファイルの書き出しは一時フォルダに向け、リポジトリを書き換えない（Assets などは読み込み用にリンク）。

cog の中身は変更しない。コマンドを足したら ``SLASH_ARGUMENTS`` / ``PREFIX_ARGUMENTS`` に代表的な
引数を足すこと（足し忘れると ``test_every_command_has_arguments`` が知らせる）。
"""

import asyncio
import contextlib
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key',
                      'GROQ_API_KEY': 'dummy-key', 'GEMINI_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord
from discord import app_commands
from discord.ext import commands

COMMAND_TIMEOUT = 15  # 参加者募集などで待ち続けるゲームは、ここで打ち切る（返信済みなら合格）
USER_ID = 4242

# ラズパイにだけ入っているライブラリを使う cog（tests/test_cog_loading.py と同じ扱い）。
OPTIONAL_COGS = {'judgement': 'needle'}

SLASH_ARGUMENTS = {
    'giveaway': {'prize': 'テスト賞品', 'winners': 1, 'minutes': 5},
    'setup': {},
    'support': {},
    'game': {},
    'help': {},
    'fujo': {'action': 'register'},
    'music': {},
    'voice': {},
    'user_status': {},
    'pay': {'receiver': 'OTHER', 'amount': 1},
    'leaderboard': {},
    'nation join': {}, 'nation found': {}, 'nation status': {},
    'judgement': None,  # needle3 が無い環境では読み込まれない（下で除外）
}

PREFIX_ARGUMENTS = {
    'all_stats': {}, 'mood': {}, 'doubt': {}, 'terminal': {}, 'guild': {}, 'd1ping': {}, 'check_api': {}, 'dungeon_reset': {},
    'ggrks': {'keyword': 'discord'},
    'mimic': {'prompt': 'こんにちは'}, 'mimic_toggle': {},
    'coin': {'amount': 1},
    'ffversion': {},
    'gvc': {}, 'gvc info': {'room_name': 'room'},
    'gvc create': {'room_name': 'room'}, 'gvc chat': {},
    'gvc chat disconnect': {}, 'gvc chat connect': {'room_name': 'room'},
    'gvc list': {}, 'gvc delete': {'room_name': 'room'},
}

# このテストで見つかった既知の問題。直したら消すこと（消し忘れは test_known_issues_are_still_present が知らせる）。
KNOWN_ISSUES: dict[str, str] = {}

# 条件を満たさないときは、あえて何も返さないコマンド（返信がなくても合格にする）。
SILENT_BY_DESIGN = {
    '!terminal': '許可されたユーザー以外には反応しない（存在を知らせないため）',
    '!d1ping': '許可されたユーザー以外には反応しない（tests/test_admin_prefix.py）',
    '!check_api': '許可されたユーザー以外には反応しない（tests/test_admin_prefix.py）',
    '!dungeon_reset': '許可されたユーザー以外には反応しない（tests/test_admin_prefix.py）',
    '!guild': '許可されたユーザー以外には反応しない（tests/test_guild_list.py で両方を確認）',
}

# discord.py 標準のヘルプコマンドは対象外（cog のコマンドではない）。
BUILTIN_PREFIX = {'help'}


# ---------------------------------------------------------------- 偽の Supabase（メモリ上）
class FakeResponse:
    def __init__(self, data, count=None):
        self.data, self.count = data, count if count is not None else len(data or [])


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.action, self.payload, self.on_conflict = 'select', None, None
        self.filters, self.negate, self._order, self._limit, self._single = [], False, None, None, False

    # --- 操作
    def select(self, *args, **kwargs):
        self.action = 'select' if self.action == 'select' else self.action
        return self

    def insert(self, payload, **kwargs):
        self.action, self.payload = 'insert', payload
        return self

    def upsert(self, payload, on_conflict=None, **kwargs):
        self.action, self.payload, self.on_conflict = 'upsert', payload, on_conflict
        return self

    def update(self, payload, **kwargs):
        self.action, self.payload = 'update', payload
        return self

    def delete(self, **kwargs):
        self.action = 'delete'
        return self

    # --- 条件
    def _add(self, column, test):
        negate, self.negate = self.negate, False
        self.filters.append((column, (lambda v: not test(v)) if negate else test))
        return self

    def eq(self, c, v): return self._add(c, lambda x: x == v)
    def neq(self, c, v): return self._add(c, lambda x: x != v)
    def gt(self, c, v): return self._add(c, lambda x: x is not None and x > v)
    def gte(self, c, v): return self._add(c, lambda x: x is not None and x >= v)
    def lt(self, c, v): return self._add(c, lambda x: x is not None and x < v)
    def lte(self, c, v): return self._add(c, lambda x: x is not None and x <= v)
    def in_(self, c, values): return self._add(c, lambda x: x in values)
    def is_(self, c, v): return self._add(c, lambda x: x is None if str(v).lower() == 'null' else x == v)
    def like(self, c, v): return self._add(c, lambda x: True)
    ilike = like

    @property
    def not_(self):
        self.negate = True
        return self

    def order(self, column, desc=False, **kwargs):
        self._order = (column, desc)
        return self

    def limit(self, n, **kwargs):
        self._limit = n
        return self

    def range(self, start, end, **kwargs):
        return self

    def single(self):
        self._single = True
        return self

    maybe_single = single

    def _match(self, row):
        return all(test(row.get(column)) for column, test in self.filters)

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        if self.action in ('insert', 'upsert'):
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            out = []
            keys = (self.on_conflict or '').split(',') if self.on_conflict else None
            for payload in payloads:
                existing = None
                if self.action == 'upsert':
                    match_keys = keys or [k for k in ('id', 'user_id', 'guild_id', 'name') if k in payload][:1]
                    existing = next((r for r in rows if match_keys and all(r.get(k) == payload.get(k) for k in match_keys)), None)
                if existing is not None:
                    existing.update(payload)
                    out.append(dict(existing))
                else:
                    row = {'id': len(rows) + 1, **payload}
                    rows.append(row)
                    out.append(dict(row))
            return FakeResponse(out)
        matched = [r for r in rows if self._match(r)]
        if self.action == 'update':
            for row in matched:
                row.update(self.payload)
            return FakeResponse([dict(r) for r in matched])
        if self.action == 'delete':
            for row in matched:
                rows.remove(row)
            return FakeResponse([dict(r) for r in matched])
        if self._order:
            column, desc = self._order
            matched = sorted(matched, key=lambda r: (r.get(column) is None, r.get(column) or 0), reverse=desc)
        if self._limit is not None:
            matched = matched[:self._limit]
        data = [dict(r) for r in matched]
        if self._single:
            return FakeResponse(data[0] if data else None, len(data))
        return FakeResponse(data)


def _spiral_coords(radius: int):
    """docs/sql/nation_found.sql と同じ順に、原点から近い順の座標を返す（テスト用フェイク）。"""
    yield 0, 0
    for r in range(1, radius + 1):
        for x in range(-r, r + 1):
            yield x, -r
            yield x, r
        for y in range(-r + 1, r):
            yield -r, y
            yield r, y


class FakeDBAPI:
    def __init__(self):
        self.tables: dict[str, list] = {}

    def table(self, name):
        return FakeQuery(self, name)

    from_ = table

    def rpc(self, name, params=None, **kwargs):
        if name == 'nation_found':
            return types.SimpleNamespace(execute=lambda: self._nation_found(params['p_guild_id'], params['p_user_id']))
        return types.SimpleNamespace(execute=lambda: FakeResponse(None))

    def _nation_found(self, gid, uid):
        """docs/sql/nation_found.sql と同じ手順の再現（1 回の呼び出しで全部作るか、何も作らない）。"""
        t = self.tables
        if any(g.get('guild_id') == gid for g in t.get('nation_guilds', [])):
            raise RuntimeError('NATION_EXISTS: guild already has a nation')
        if any(p.get('user_id') == uid and p.get('guild_id') for p in t.get('nation_players', [])):
            raise RuntimeError('ALREADY_IN_NATION: user already belongs to a nation')
        used = {(r.get('x'), r.get('y')) for r in t.get('nation_tiles', [])}
        spot = next((c for c in _spiral_coords(50) if c not in used), None)
        if spot is None:
            raise RuntimeError('NO_FREE_TILE: no free tile')
        x, y = spot
        t.setdefault('nation_tiles', []).append(
            {'x': x, 'y': y, 'owner_guild_id': gid, 'tile_type': 'capital', 'connected': True})
        t.setdefault('nation_guilds', []).append({'guild_id': gid, 'capital_x': x, 'capital_y': y})
        players = t.setdefault('nation_players', [])
        players[:] = [p for p in players if p.get('user_id') != uid]
        players.append({'user_id': uid, 'guild_id': gid, 'role': 'king', 'hunger': 100})
        return FakeResponse([{'capital_x': x, 'capital_y': y}])


# ---------------------------------------------------------------- 偽の Discord
class Recorder:
    def __init__(self):
        self.replies = []

    def method(self, name):
        async def call(*args, **kwargs):
            self.replies.append(name)
            embeds = list(kwargs.get('embeds') or []) + ([kwargs['embed']] if kwargs.get('embed') else [])
            for embed in embeds:
                if isinstance(embed, discord.Embed):
                    assert len(embed) <= 6000, f'{name}: embed is longer than 6000 characters'
                    assert len(embed.fields) <= 25, f'{name}: more than 25 fields'
            content = kwargs.get('content', args[0] if args else None)
            if isinstance(content, str):
                assert len(content) <= 2000, f'{name}: message is longer than 2000 characters'
            return fake_message(self)
        return call


def fake_message(recorder):
    message = MagicMock(spec=discord.Message)
    message.id = 999
    message.edit = recorder.method('message.edit')
    message.reply = recorder.method('message.reply')
    message.delete = AsyncMock()
    message.add_reaction = AsyncMock()
    message.attachments = []
    message.content = ''
    return message


async def _no_history(*args, **kwargs):
    if False:
        yield None


def fake_member(user_id, guild, recorder, name='tester'):
    member = MagicMock(spec=discord.Member)
    member.id = user_id
    member.name = member.display_name = member.global_name = name
    member.mention = f'<@{user_id}>'
    member.bot = False
    member.display_avatar = MagicMock(url='https://example.invalid/a.png')
    member.avatar = member.display_avatar
    member.guild_permissions = discord.Permissions.all()
    member.roles = []
    member.voice = None
    member.guild = guild
    member.send = recorder.method('user.send')
    member.add_roles = AsyncMock()
    member.remove_roles = AsyncMock()
    member.timeout = AsyncMock()
    member.edit = AsyncMock()
    member.created_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    member.joined_at = datetime(2021, 1, 1, tzinfo=timezone.utc)
    return member


def fake_env(bot):
    recorder = Recorder()
    guild = MagicMock(spec=discord.Guild)
    guild.id = 55
    guild.name = 'guild'
    guild.voice_client = None
    guild.members = []
    guild.roles = []
    guild.text_channels = []
    guild.channels = []
    guild.categories = []
    guild.me = MagicMock(guild_permissions=discord.Permissions.all(), id=1)
    guild.create_text_channel = AsyncMock()
    guild.create_role = AsyncMock()
    guild.fetch_member = AsyncMock()
    user = fake_member(USER_ID, guild, recorder)
    other = fake_member(USER_ID + 1, guild, recorder, 'other')
    guild.get_member = lambda i: {USER_ID: user, USER_ID + 1: other}.get(i)
    guild.members = [user, other]

    channel = MagicMock(spec=discord.TextChannel)
    channel.id = 77
    channel.name = 'test'
    channel.mention = '<#77>'
    channel.guild = guild
    channel.send = recorder.method('channel.send')
    channel.history = _no_history
    channel.typing = MagicMock(return_value=contextlib.nullcontext())
    channel.purge = AsyncMock(return_value=[])
    channel.set_permissions = AsyncMock()
    channel.create_thread = AsyncMock(return_value=channel)
    channel.permissions_for = lambda *a: discord.Permissions.all()
    guild.get_channel = lambda i: channel
    guild.text_channels = [channel]
    category = MagicMock(spec=discord.CategoryChannel)
    category.id = 88
    category.name = 'cat'
    category.channels = [channel]
    category.set_permissions = AsyncMock()
    role = MagicMock(spec=discord.Role)
    role.id = 99
    role.name = 'role'
    role.mention = '<@&99>'
    return recorder, guild, user, other, channel, category, role


class AsyncCM:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def fake_interaction(bot):
    recorder, guild, user, other, channel, category, role = fake_env(bot)
    done = {'value': False}

    def mark(name):
        method = recorder.method(name)

        async def call(*args, **kwargs):
            done['value'] = True
            return await method(*args, **kwargs)
        return call

    async def defer(*args, **kwargs):
        done['value'] = True

    response = types.SimpleNamespace(
        defer=defer, send_message=mark('response.send_message'), edit_message=mark('response.edit_message'),
        send_modal=mark('response.send_modal'), is_done=lambda: done['value'])
    interaction = types.SimpleNamespace(
        id=123456789, user=user, author=user, guild=guild, guild_id=guild.id, channel=channel, channel_id=channel.id,
        client=bot, response=response, followup=types.SimpleNamespace(send=recorder.method('followup.send')),
        edit_original_response=recorder.method('edit_original_response'),
        original_response=AsyncMock(return_value=fake_message(recorder)), delete_original_response=AsyncMock(),
        created_at=datetime.now(timezone.utc), message=None, locale=discord.Locale.japanese, data={},
        namespace=types.SimpleNamespace(), permissions=discord.Permissions.all(),
        app_permissions=discord.Permissions.all(), command=None, extras={})
    objects = {'USER': user, 'OTHER': other, 'CHANNEL': channel, 'CATEGORY': category, 'ROLE': role}
    return interaction, recorder, objects


def fake_context(bot, command):
    recorder, guild, user, other, channel, category, role = fake_env(bot)
    message = fake_message(recorder)
    message.author, message.channel, message.guild = user, channel, guild
    message.content = f'!{command.qualified_name}'
    ctx = MagicMock(spec=commands.Context)
    ctx.bot, ctx.author, ctx.guild, ctx.channel, ctx.message = bot, user, guild, channel, message
    ctx.prefix, ctx.command, ctx.invoked_with = '!', command, command.name
    ctx.invoked_subcommand, ctx.subcommand_passed, ctx.voice_client = None, None, None
    ctx.cog = command.cog
    ctx.send = recorder.method('ctx.send')
    ctx.reply = recorder.method('ctx.reply')
    ctx.send_help = recorder.method('ctx.send_help')
    ctx.typing = MagicMock(return_value=AsyncCM())
    ctx.me = guild.me
    objects = {'USER': user, 'OTHER': other, 'CHANNEL': channel, 'CATEGORY': category, 'ROLE': role}
    return ctx, recorder, objects


def _blocked(*args, **kwargs):
    raise OSError('network and subprocesses are disabled in tests')


class _FailedProcess:
    returncode = 1
    pid = 0
    stdout = stderr = stdin = None

    async def communicate(self, *args, **kwargs):
        return b'', b'subprocesses are disabled in tests'

    async def wait(self):
        return 1

    def kill(self):
        pass

    terminate = kill


async def _failed_process(*args, **kwargs):
    # 外部コマンドは実行せず、「失敗して終わった」プロセスとして返す。
    return _FailedProcess()


# ---------------------------------------------------------------- テスト本体
class AllCommandsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._cwd = os.getcwd()
        cls.preexisting = {p.name for p in ROOT.iterdir()}
        cls.tmp = tempfile.TemporaryDirectory()
        work = Path(cls.tmp.name)
        for name in ('Assets', 'assets', 'font.ttf', 'model'):
            if (ROOT / name).exists():
                (work / name).symlink_to(ROOT / name, target_is_directory=(ROOT / name).is_dir())
        for name in ('global_channels.json',):  # 書き換えられ得るファイルはコピー
            if (ROOT / name).exists():
                shutil.copy(ROOT / name, work / name)
        os.chdir(work)
        cls.db_api = FakeDBAPI()
        import config
        from core.support import api_client
        cls.patches = [
            patch.object(api_client, 'get_client', lambda: cls.db_api),
            patch.object(config, 'db_api', cls.db_api),
            patch.object(socket.socket, 'connect', _blocked),
            patch.object(socket, 'create_connection', _blocked),
            patch.object(socket, 'getaddrinfo', _blocked),
            # Popen 自体は差し替えず（yt_dlp が継承している）、プロセスの起動だけを止める。
            patch.object(subprocess.Popen, '_execute_child', _blocked),
            patch.object(asyncio, 'create_subprocess_exec', _failed_process),
            patch.object(asyncio, 'create_subprocess_shell', _failed_process),
            # 未接続の Bot は latency が NaN になるので、接続中と同じく有限の値にする。
            patch.object(commands.Bot, 'latency', new=0.05),
        ]
        for item in cls.patches:
            item.start()
        cls.loop = asyncio.new_event_loop()
        cls.slash_results, cls.prefix_results = {}, {}
        try:
            cls.loop.run_until_complete(cls._run_all())
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'loop', None) and not cls.loop.is_closed():
            for task in asyncio.all_tasks(cls.loop):
                task.cancel()
            with contextlib.suppress(Exception):
                cls.loop.run_until_complete(asyncio.sleep(0))
            cls.loop.close()
        for item in reversed(getattr(cls, 'patches', [])):
            with contextlib.suppress(RuntimeError):
                item.stop()
        cls.patches = []
        os.chdir(cls._cwd)
        cls.tmp.cleanup()

    @classmethod
    async def _run_all(cls):
        cls.bot = commands.Bot(command_prefix='!', intents=discord.Intents.none())
        cls.bot.db_api = cls.db_api
        cls.bot.wait_until_ready = AsyncMock(side_effect=asyncio.CancelledError)
        cls.bot.loop = asyncio.get_running_loop()  # ログイン後と同じく bot.loop を使えるようにする
        cls.skipped = {}
        for name in sorted(os.listdir(ROOT / 'cogs')):
            if not name.endswith('.py') or name.startswith('__'):
                continue
            module = name[:-3]
            try:
                await cls.bot.load_extension(f'cogs.{module}')
            except commands.ExtensionFailed as error:
                optional = OPTIONAL_COGS.get(module)
                if optional and isinstance(error.original, ModuleNotFoundError) and optional in str(error.original):
                    cls.skipped[module] = optional
                    continue
                raise
        cls.slash = {c.qualified_name: c for c in cls.bot.tree.walk_commands()
                     if not isinstance(c, app_commands.Group)}
        cls.prefix = {c.qualified_name: c for c in cls.bot.walk_commands()
                      if c.qualified_name not in BUILTIN_PREFIX}
        for name, command in sorted(cls.slash.items()):
            cls.slash_results[name] = await cls._invoke_slash(name, command)
        for name, command in sorted(cls.prefix.items()):
            cls.prefix_results[name] = await cls._invoke_prefix(name, command)

    @staticmethod
    def _resolve(arguments, objects):
        return {k: objects.get(v, v) if isinstance(v, str) else v for k, v in (arguments or {}).items()}

    @classmethod
    async def _run(cls, coro, recorder):
        try:
            await asyncio.wait_for(coro, COMMAND_TIMEOUT)
            error = None
        except TimeoutError:
            # 募集・入力待ちで止まっている。何か返信していれば正常（待っているだけ）。
            error = None if recorder.replies else 'TimeoutError: 返信しないまま止まりました'
        except Exception as caught:  # noqa: BLE001 - 結果として記録してテストで報告する
            error = f'{type(caught).__name__}: {caught}'
        await asyncio.sleep(0)
        return {'error': error, 'replies': list(recorder.replies)}

    @classmethod
    async def _invoke_slash(cls, name, command):
        interaction, recorder, objects = fake_interaction(cls.bot)
        kwargs = cls._resolve(SLASH_ARGUMENTS.get(name), objects)
        # app_commands.Choice[...] で受け取る引数には、選択肢の Choice をそのまま渡す。
        for parameter in command.parameters:
            if parameter.name in kwargs and parameter.choices:
                annotation = command.callback.__annotations__.get(parameter.name)
                if 'Choice' in str(annotation):
                    kwargs[parameter.name] = next(c for c in parameter.choices if c.value == kwargs[parameter.name])
        return await cls._run(command.callback(command.binding, interaction, **kwargs), recorder)

    @classmethod
    async def _invoke_prefix(cls, name, command):
        ctx, recorder, objects = fake_context(cls.bot, command)
        kwargs = cls._resolve(PREFIX_ARGUMENTS.get(name), objects)
        if command.cog is not None:
            coro = command.callback(command.cog, ctx, **kwargs)
        else:
            coro = command.callback(ctx, **kwargs)
        return await cls._run(coro, recorder)

    def runs(self):
        for name, result in sorted(self.slash_results.items()):
            yield f'/{name}', name, result
        for name, result in sorted(self.prefix_results.items()):
            yield f'!{name}', name, result

    def test_every_command_has_arguments(self):
        known_slash = {k for k, v in SLASH_ARGUMENTS.items() if v is not None}
        self.assertEqual(sorted(set(self.slash) - known_slash), [], 'SLASH_ARGUMENTS に追加してください')
        self.assertEqual(sorted(set(self.prefix) - set(PREFIX_ARGUMENTS)), [], 'PREFIX_ARGUMENTS に追加してください')
        loaded_or_optional = set(self.slash) | {k for k, v in SLASH_ARGUMENTS.items() if v is None}
        self.assertEqual(sorted(set(SLASH_ARGUMENTS) - loaded_or_optional), [], '存在しないスラッシュコマンドが残っています')
        self.assertEqual(sorted(set(PREFIX_ARGUMENTS) - set(self.prefix)), [], '存在しないプレフィックスコマンドが残っています')

    def test_commands_do_not_raise(self):
        for label, name, result in self.runs():
            if label in KNOWN_ISSUES:
                continue
            with self.subTest(command=label):
                self.assertIsNone(result['error'])

    def test_commands_reply(self):
        for label, name, result in self.runs():
            if label in KNOWN_ISSUES or label in SILENT_BY_DESIGN:
                continue
            with self.subTest(command=label):
                self.assertTrue(result['replies'], '返信がありません（defer のままか、何も送っていません）')

    def test_known_issues_are_still_present(self):
        results = {label: result for label, _, result in self.runs()}
        for label, reason in sorted(KNOWN_ISSUES.items()):
            with self.subTest(command=label, reason=reason):
                result = results[label]
                self.assertTrue(result['error'] or not result['replies'],
                                '直ったようなので KNOWN_ISSUES から消してください')

    def test_nothing_is_written_into_the_repository(self):
        created = sorted(p.name for p in ROOT.iterdir()
                         if p.name not in self.preexisting and p.name != '__pycache__')
        self.assertEqual(created, [])


if __name__ == '__main__':
    unittest.main()
