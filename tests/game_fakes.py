"""ゲーム系 cog（ダウト・UNO・人狼）の流れをテストするための偽の Discord 部品。Discord には接続しない。

- ``fast_time()``: ``asyncio.sleep`` を 1/1000 の速さにする（60 秒の募集待ちが 0.06 秒で終わる）。
  テスト側で実時間だけ待ちたいときは ``real_sleep`` を使う。
- ``FakeGuild`` / ``FakeMember`` / ``FakeChannel`` / ``FakeInteraction``: cog が使う属性だけを持つ軽い偽物。
  送ったメッセージは ``FakeChannel.sent`` に、インタラクションへの返信は ``FakeInteraction.response.sent`` に残る。
- ``press(view, name, interaction)``: View のボタン（デコレータで付けたメソッド名）を押す。
- ``choose(select, value, interaction)``: セレクトメニューで値を選ぶ。
"""

import asyncio
import contextlib
import itertools
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402

from core.game import party_ranking  # noqa: E402

# テストでは Supabase に接続しない（勝利数はメモリだけ）
party_ranking._shared = party_ranking.PartyRanking(client=None)

real_sleep = asyncio.sleep
_ids = itertools.count(10_000)


@contextlib.contextmanager
def fast_time(scale=0.001):
    async def sleep(delay, *args, **kwargs):
        await real_sleep(min(delay, 3600) * scale, *args, **kwargs)
    with patch.object(asyncio, 'sleep', sleep):
        yield


class FakeMessage:
    def __init__(self, channel, content=None, embed=None, embeds=None, view=None):
        self.id = next(_ids)
        self.channel = channel
        self.content = content
        self.embeds = list(embeds or []) + ([embed] if embed else [])
        self.view = view
        self.deleted = False
        self.edits = []

    @property
    def embed(self):
        return self.embeds[0] if self.embeds else None

    def text(self):
        parts = [self.content or '']
        for e in self.embeds:
            parts += [e.title or '', e.description or ''] + [f'{f.name} {f.value}' for f in e.fields]
        parts += _view_texts(self.view)
        return ' '.join(p for p in parts if p)

    async def delete(self, *args, **kwargs):
        self.deleted = True

    async def edit(self, **kwargs):
        self.edits.append(kwargs)
        if 'view' in kwargs:
            self.view = kwargs['view']
        if 'content' in kwargs:
            self.content = kwargs['content']
        if 'embed' in kwargs:
            self.embeds = [kwargs['embed']] if kwargs['embed'] else []
        return self


def _view_texts(view):
    """Components V2 ビュー内の TextDisplay の本文を集める（実クライアントでの見え方に合わせる）。"""
    if view is None:
        return []
    texts = []
    try:
        for item in view.walk_children():
            if isinstance(item, discord.ui.TextDisplay):
                texts.append(item.content or '')
    except Exception:
        return []
    return texts


class FakeRole:
    def __init__(self, role_id, name):
        self.id, self.name, self.mention = role_id, name, f'<@&{role_id}>'


class FakeGuild:
    def __init__(self, guild_id=1):
        self.id = guild_id
        self.name = f'guild{guild_id}'
        self._members = {}
        self.roles = []
        self.default_role = FakeRole(guild_id, '@everyone')

    @property
    def members(self):
        return list(self._members.values())

    def get_member(self, user_id):
        return self._members.get(user_id)

    def get_role(self, role_id):
        return next((r for r in self.roles if r.id == role_id), None)

    async def create_role(self, name=None, **kwargs):
        role = FakeRole(next(_ids), name)
        self.roles.append(role)
        return role


class FakeMember:
    def __init__(self, user_id, guild, name=None):
        self.id = user_id
        self.name = self.display_name = self.global_name = name or f'P{user_id}'
        self.mention = f'<@{user_id}>'
        self.bot = False
        self.guild = guild
        self.roles = []
        self.dms = []
        self.guild_permissions = discord.Permissions.none()
        guild._members[user_id] = self

    async def send(self, content=None, **kwargs):
        message = FakeMessage(self, content, kwargs.get('embed'), kwargs.get('embeds'), kwargs.get('view'))
        self.dms.append(message)
        return message

    async def add_roles(self, *roles, **kwargs):
        self.roles += [r for r in roles if r not in self.roles]

    async def remove_roles(self, *roles, **kwargs):
        self.roles = [r for r in self.roles if r not in roles]

    def __eq__(self, other):
        return getattr(other, 'id', None) == self.id

    def __hash__(self):
        return hash(self.id)


class FakeChannel:
    def __init__(self, channel_id, guild, name='game'):
        self.id = channel_id
        self.guild = guild
        self.name = name
        self.mention = f'<#{channel_id}>'
        self.sent = []
        self.overwrites = {}

    async def send(self, content=None, **kwargs):
        message = FakeMessage(self, content, kwargs.get('embed'), kwargs.get('embeds'), kwargs.get('view'))
        self.sent.append(message)
        return message

    async def set_permissions(self, target, overwrite=None, **kwargs):
        self.overwrites[target] = overwrite if overwrite is not None else kwargs

    def texts(self):
        return [m.text() for m in self.sent]


class FakeResponse:
    def __init__(self, interaction):
        self.interaction = interaction
        self.sent = []
        self._done = False

    def _mark(self):
        if self._done:
            raise discord.InteractionResponded(self.interaction)
        self._done = True

    async def send_message(self, content=None, **kwargs):
        self._mark()
        message = FakeMessage(self.interaction.channel, content, kwargs.get('embed'), kwargs.get('embeds'), kwargs.get('view'))
        self.sent.append(message)
        return message

    async def edit_message(self, **kwargs):
        self._mark()
        if self.interaction.message is not None:
            await self.interaction.message.edit(**kwargs)

    async def defer(self, *args, **kwargs):
        self._mark()

    async def send_modal(self, modal):
        self._mark()
        self.modal = modal

    def is_done(self):
        return self._done


class FakeFollowup:
    def __init__(self, channel):
        self.channel = channel
        self.sent = []

    async def send(self, content=None, **kwargs):
        message = FakeMessage(self.channel, content, kwargs.get('embed'), kwargs.get('embeds'), kwargs.get('view'))
        self.sent.append(message)
        return message


class FakeInteraction:
    def __init__(self, user, channel, message=None, client=None):
        self.user = user
        self.channel = channel
        self.channel_id = channel.id
        self.guild = channel.guild
        self.guild_id = channel.guild.id
        self.message = message
        self.client = client
        self.response = FakeResponse(self)
        self.followup = FakeFollowup(channel)

    def texts(self):
        return [m.text() for m in self.response.sent + self.followup.sent]


class FakeBot:
    def __init__(self, *channels):
        self.channels = {c.id: c for c in channels}
        self.user = None

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    def get_user(self, user_id):
        return None

    async def wait_until_ready(self):
        return None


class FakeChatMessage:
    """on_message に渡すチャットメッセージ"""
    def __init__(self, author, channel, content='', mentions=()):
        self.author = author
        self.channel = channel
        self.guild = channel.guild
        self.content = content
        self.mentions = list(mentions)
        self.deleted = False

    async def delete(self, *args, **kwargs):
        self.deleted = True


def find_item(view, name):
    """ボタンのメソッド名（例: 'join'）から View の部品を探す"""
    for child in view.children:
        callback = getattr(child, 'callback', None)
        func = getattr(callback, 'callback', None) or getattr(callback, 'func', None) or callback
        if getattr(func, '__name__', None) == name or getattr(getattr(callback, '__func__', None), '__name__', None) == name:
            return child
    item = getattr(view, name, None)
    if item is not None and hasattr(item, 'callback'):
        return item
    raise LookupError(f'{type(view).__name__} に {name} がありません')


async def press(view, name, interaction):
    return await find_item(view, name).callback(interaction)


async def choose(select, value, interaction):
    select._values = [value]
    if hasattr(select, '_selected_values'):
        select._selected_values = [value]
    return await select.callback(interaction)
