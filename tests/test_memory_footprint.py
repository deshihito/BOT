# -*- coding: utf-8 -*-
"""メモリ方針（core/member_access）と状態観測のテスト。

- Bot のクライアント引数: 起動時チャンク停止・メッセージキャッシュ
  上限・typing intent 無効化が効いていること。
- メンバー全件／単体取得ヘルパ: キャッシュで足りる場合は取得せず、
  足りない場合だけ fetch し、失敗時はキャッシュ分へ縮退すること。
- ステータススナップショット: メモリ系の任意項目が、渡したときだけ
  含まれること（従来の形は完全一致のまま）。
"""
from __future__ import annotations

import datetime
import os
import sys
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord
from discord.ext import commands

from core.member_access import (
    bot_client_kwargs, build_intents, get_or_fetch_member, list_all_members)
from core.support.bot_status import snapshot as status_snapshot
from core.support.bot_status.cog import trim_released_heap


class BotClientKwargsTest(unittest.IsolatedAsyncioTestCase):
    async def test_kwargs_disable_startup_chunking_and_cap_messages(self):
        kwargs = bot_client_kwargs()
        self.assertIs(kwargs["chunk_guilds_at_startup"], False)
        self.assertEqual(kwargs["max_messages"], 500)
        bot = commands.Bot(command_prefix="!", **kwargs)
        try:
            state = bot._connection
            self.assertFalse(state._chunk_guilds)
            self.assertEqual(state.max_messages, 500)
            # member_cache_flags は既定（joined / voice）のまま。
            self.assertTrue(state.member_cache_flags.joined)
            self.assertTrue(state.member_cache_flags.voice)
        finally:
            await bot.close()

    def test_intents_keep_required_and_drop_typing(self):
        intents = build_intents()
        self.assertTrue(intents.members)
        self.assertTrue(intents.message_content)
        self.assertTrue(intents.presences)
        self.assertTrue(intents.voice_states)
        self.assertFalse(intents.guild_typing)
        self.assertFalse(intents.dm_typing)
        self.assertIsInstance(intents, discord.Intents)


class _FakeGuild:
    def __init__(self, members, member_count=None, fetch_result=None, fetch_error=None):
        self.members = list(members)
        self.member_count = len(members) if member_count is None else member_count
        self._fetch_result = fetch_result
        self._fetch_error = fetch_error
        self.fetch_calls = 0
        self._by_id = {m.id: m for m in self.members}

    async def fetch_members(self, *, limit=None):
        self.fetch_calls += 1
        if self._fetch_error is not None:
            raise self._fetch_error
        for member in self._fetch_result or []:
            yield member

    def get_member(self, user_id):
        return self._by_id.get(user_id)

    async def fetch_member(self, user_id):
        member = self._by_id.get(user_id)
        if member is None:
            raise RuntimeError("not found")
        return member


def _member(uid):
    return types.SimpleNamespace(id=uid)


class ListAllMembersTest(unittest.IsolatedAsyncioTestCase):
    async def test_complete_cache_skips_fetch(self):
        guild = _FakeGuild([_member(1), _member(2)], fetch_result=[_member(3)])
        result = await list_all_members(guild)
        self.assertEqual([m.id for m in result], [1, 2])
        self.assertEqual(guild.fetch_calls, 0)

    async def test_incomplete_cache_fetches_all(self):
        guild = _FakeGuild([_member(1)], member_count=3,
                           fetch_result=[_member(1), _member(2), _member(3)])
        result = await list_all_members(guild)
        self.assertEqual([m.id for m in result], [1, 2, 3])
        self.assertEqual(guild.fetch_calls, 1)

    async def test_fetch_failure_falls_back_to_cache(self):
        guild = _FakeGuild([_member(1)], member_count=5,
                           fetch_error=RuntimeError("boom"))
        result = await list_all_members(guild)
        self.assertEqual([m.id for m in result], [1])

    async def test_guild_without_fetch_returns_cache(self):
        guild = types.SimpleNamespace(members=[_member(9)], member_count=100)
        result = await list_all_members(guild)
        self.assertEqual([m.id for m in result], [9])


class GetOrFetchMemberTest(unittest.IsolatedAsyncioTestCase):
    async def test_cache_hit(self):
        guild = _FakeGuild([_member(7)])
        self.assertEqual((await get_or_fetch_member(guild, 7)).id, 7)

    async def test_fetch_fallback_and_miss(self):
        guild = _FakeGuild([_member(7)])
        guild._by_id = {}  # キャッシュには無いが fetch では引ける想定
        guild.fetch_member = lambda user_id: _async_value(_member(8))
        self.assertEqual((await get_or_fetch_member(guild, 8)).id, 8)
        guild.fetch_member = lambda user_id: _async_raise()
        self.assertIsNone(await get_or_fetch_member(guild, 8))

    async def test_none_guild(self):
        self.assertIsNone(await get_or_fetch_member(None, 1))


async def _async_value(value):
    return value


async def _async_raise():
    raise RuntimeError("not found")


class SnapshotMemoryFieldsTest(unittest.TestCase):
    NOW = datetime.datetime(2026, 11, 12, 12, 0, tzinfo=datetime.timezone.utc)

    def test_legacy_shape_unchanged_without_memory_fields(self):
        snap = status_snapshot.build_snapshot(
            guild_count=3, member_count=1234, latency_ms=42,
            started_at=None, now=self.NOW)
        self.assertEqual(set(snap), {
            "updated_at", "started_at", "guild_count", "member_count", "latency_ms"})

    def test_memory_fields_included_when_provided(self):
        snap = status_snapshot.build_snapshot(
            guild_count=3, member_count=1234, latency_ms=42,
            started_at=None, now=self.NOW,
            process_rss_mb=812, cached_member_count=123, cached_user_count=45)
        self.assertEqual(snap["process_rss_mb"], 812)
        self.assertEqual(snap["cached_member_count"], 123)
        self.assertEqual(snap["cached_user_count"], 45)

    def test_collect_counts_cached_members(self):
        guild = types.SimpleNamespace(
            member_count=100, members=[_member(1), _member(2), _member(3)])
        bot = types.SimpleNamespace(guilds=[guild], latency=0.01, users=[object()] * 5)
        snap = status_snapshot.collect_snapshot(bot, now=self.NOW)
        self.assertEqual(snap["member_count"], 100)
        self.assertEqual(snap["cached_member_count"], 3)
        self.assertEqual(snap["cached_user_count"], 5)
        self.assertIn("process_rss_mb", snap)


class TrimReleasedHeapTest(unittest.TestCase):
    def test_failure_is_swallowed(self):
        with mock.patch("ctypes.CDLL", side_effect=OSError("no libc")):
            self.assertFalse(trim_released_heap())

    def test_success_reports_release(self):
        libc = mock.Mock()
        libc.malloc_trim.return_value = 1
        with mock.patch("ctypes.CDLL", return_value=libc):
            self.assertTrue(trim_released_heap())
        libc.malloc_trim.assert_called_once_with(0)


if __name__ == "__main__":
    unittest.main()
