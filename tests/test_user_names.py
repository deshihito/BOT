# -*- coding: utf-8 -*-
"""ランキング等の氏名表記（メンション→通常表記）の共通ヘルパーのテスト。"""
import unittest
from types import SimpleNamespace

from core import user_names
from core.user_names import (
    cached_display_name, display_name, fallback_name, resolve_display_names,
)


class FakeBot:
    def __init__(self, cached=None, fetched=None):
        self._cached = cached or {}
        self._fetched = fetched or {}
        self.fetch_calls = []

    def get_user(self, uid):
        name = self._cached.get(uid)
        return SimpleNamespace(display_name=name) if name else None

    async def fetch_user(self, uid):
        self.fetch_calls.append(uid)
        name = self._fetched.get(uid)
        if name is None:
            raise RuntimeError("unknown user")
        return SimpleNamespace(display_name=name)


class UserNamesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        user_names._CACHE.clear()

    def test_fallback_format(self):
        self.assertEqual(fallback_name(123456789012345678), "ユーザー(…5678)")
        self.assertEqual(fallback_name("42"), "ユーザー(…0042)")

    async def test_resolve_prefers_stored_then_cache_then_fetch(self):
        bot = FakeBot(cached={2: "キャッシュ太郎"}, fetched={3: "取得花子"})
        names = await resolve_display_names(bot, [1, 2, 3, 4], stored={1: "保存次郎"})
        self.assertEqual(names[1], "保存次郎")
        self.assertEqual(names[2], "キャッシュ太郎")
        self.assertEqual(names[3], "取得花子")
        self.assertEqual(names[4], "ユーザー(…0004)")
        self.assertNotIn("<@", "".join(names.values()))

    async def test_resolve_uses_module_cache_without_refetch(self):
        bot = FakeBot(fetched={9: "一度だけ"})
        await resolve_display_names(bot, [9])
        bot2 = FakeBot()  # get_user/fetch_user どちらでも取れない bot
        names = await resolve_display_names(bot2, [9])
        self.assertEqual(names[9], "一度だけ")
        self.assertEqual(bot2.fetch_calls, [])  # モジュールキャッシュが効いて再取得しない

    async def test_display_name_single(self):
        bot = FakeBot(fetched={5: "単独"})
        self.assertEqual(await display_name(bot, 5), "単独")
        self.assertEqual(await display_name(bot, 6), "ユーザー(…0006)")

    def test_cached_display_name_sync(self):
        bot = FakeBot(cached={7: "同期"})
        self.assertEqual(cached_display_name(bot, 7), "同期")
        self.assertEqual(cached_display_name(bot, 8), "ユーザー(…0008)")
        self.assertEqual(cached_display_name(None, 8), "ユーザー(…0008)")
        self.assertEqual(cached_display_name(bot, "abc"), "ユーザー(…0abc)")


if __name__ == "__main__":
    unittest.main()
