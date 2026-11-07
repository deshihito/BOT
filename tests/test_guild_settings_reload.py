"""GuildSettings の再読込（Web ダッシュボードからの書き換えを取り込む）のテスト。"""
from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.guild_settings import GuildSettings


class FakeKV:
    """load_all / set / delete をメモリで真似る KVStore の代わり。"""

    def __init__(self, remote=None):
        self.remote = dict(remote or {})
        self.load_calls = 0
        self.fail_loads = False

    def load_local(self):
        return {}

    async def load_all(self):
        self.load_calls += 1
        if self.fail_loads:
            raise RuntimeError("API unreachable")
        return {key: dict(value) for key, value in self.remote.items()}

    async def set(self, key, value, *, wait=True):
        self.remote[str(key)] = value

    async def delete(self, key, *, wait=True):
        self.remote.pop(str(key), None)


class ReloadTest(unittest.IsolatedAsyncioTestCase):
    def make_store(self, remote=None):
        kv = FakeKV(remote)
        return GuildSettings(kv), kv

    async def test_first_load_reads_remote(self):
        store, _ = self.make_store({"123": {"assist_welcome": {"welcome_enabled": True}}})
        await store.ensure_loaded()
        self.assertTrue(store.get(123, "assist_welcome")["welcome_enabled"])

    async def test_within_interval_does_not_reload(self):
        store, kv = self.make_store({"123": {"a": {"x": 1}}})
        store.reload_interval = 3600
        await store.ensure_loaded()
        await store.ensure_loaded()
        self.assertEqual(kv.load_calls, 1)

    async def test_reload_picks_up_external_change(self):
        store, kv = self.make_store({"123": {"assist_welcome": {"welcome_enabled": False}}})
        await store.ensure_loaded()
        self.assertFalse(store.get(123, "assist_welcome")["welcome_enabled"])
        # Web ダッシュボードが保存先を直接書き換えた状況
        kv.remote["123"] = {"assist_welcome": {"welcome_enabled": True}}
        store.reload_interval = 0
        await store.ensure_loaded()
        self.assertTrue(store.get(123, "assist_welcome")["welcome_enabled"])
        self.assertEqual(kv.load_calls, 2)

    async def test_failed_reload_keeps_existing_data(self):
        store, kv = self.make_store({"123": {"a": {"x": 1}}})
        await store.ensure_loaded()
        store.reload_interval = 0
        kv.fail_loads = True
        await store.ensure_loaded()  # 例外にならない
        self.assertEqual(store.get(123, "a"), {"x": 1})

    async def test_update_still_saves_after_change(self):
        store, kv = self.make_store()
        store.reload_interval = 0
        await store.update(456, "assist_invites", enabled=True, channel_id=999)
        self.assertEqual(kv.remote["456"], {"assist_invites": {"enabled": True, "channel_id": 999}})
        self.assertEqual(store.get(456, "assist_invites"), {"enabled": True, "channel_id": 999})


if __name__ == "__main__":
    unittest.main()
