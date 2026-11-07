"""GuildRegistry（Web ダッシュボードの導入判定に使うサーバー一覧）のテスト。"""
from __future__ import annotations

import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.guild_registry import GuildRegistry


class FakeKV:
    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.set_calls = []
        self.delete_calls = []

    async def load_all(self):
        return dict(self.rows)

    async def set(self, key, value, *, wait=True):
        self.set_calls.append((key, value))
        self.rows[str(key)] = value

    async def delete(self, key, *, wait=True):
        self.delete_calls.append(key)
        self.rows.pop(str(key), None)


def fake_guild(guild_id, name="サーバー", member_count=42):
    return types.SimpleNamespace(id=guild_id, name=name, member_count=member_count, icon=None)


class GuildRegistryTest(unittest.IsolatedAsyncioTestCase):
    async def test_record_writes_summary(self):
        kv = FakeKV()
        registry = GuildRegistry(kv)
        await registry.record(fake_guild(123, "テスト鯖", 7))
        self.assertEqual(len(kv.set_calls), 1)
        key, value = kv.set_calls[0]
        self.assertEqual(key, "123")
        self.assertEqual(value["name"], "テスト鯖")
        self.assertEqual(value["member_count"], 7)
        self.assertIsNone(value["icon"])
        self.assertIn("updated_at", value)

    async def test_remove_deletes_key(self):
        kv = FakeKV({"123": {"name": "x"}})
        registry = GuildRegistry(kv)
        await registry.remove(123)
        self.assertEqual(kv.delete_calls, ["123"])
        self.assertNotIn("123", kv.rows)

    async def test_sync_all_writes_current_and_removes_stale(self):
        kv = FakeKV({"999": {"name": "抜けた鯖"}})
        registry = GuildRegistry(kv)
        await registry.sync_all([fake_guild(111), fake_guild(222)])
        self.assertIn("111", kv.rows)
        self.assertIn("222", kv.rows)
        self.assertNotIn("999", kv.rows)

    async def test_sync_all_skips_invalid_ids(self):
        kv = FakeKV()
        registry = GuildRegistry(kv)
        await registry.sync_all([
            types.SimpleNamespace(id=True, name="bool", member_count=1, icon=None),
            types.SimpleNamespace(id="abc", name="str", member_count=1, icon=None),
            fake_guild(333),
        ])
        self.assertEqual(list(kv.rows), ["333"])


if __name__ == "__main__":
    unittest.main()
