"""GuildSettings.update が古い写しで Web ダッシュボードの保存を巻き戻さないことのテスト。

X-01（lost update）: Bot 側のメモリ上の写しは最大で再読込間隔（60秒）ぶん古い。
その写しを丸ごと書き戻すと、その間に Web が保存した変更が静かに消える。
update は保存直前に最新を読み直し、変更分だけを重ねるので消えないことを確認する。
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.guild_settings import GuildSettings
from core.support.storage import KVStore
from tests.fake_kv_supabase import FakeKVSupabase


class FakeKV:
    """load_all / load_one / set / delete をメモリで真似る KVStore の代わり。

    remote を直接書き換えるのが「Web ダッシュボード（別プロセス）の保存」に当たる。
    """

    def __init__(self, remote=None):
        self.remote = copy.deepcopy(remote or {})

    def load_local(self):
        return {}

    async def load_all(self):
        return copy.deepcopy(self.remote)

    async def load_one(self, key):
        return copy.deepcopy(self.remote.get(str(key)))

    async def set(self, key, value, *, wait=True):
        self.remote[str(key)] = copy.deepcopy(value)

    async def delete(self, key, *, wait=True):
        self.remote.pop(str(key), None)


class LostUpdateTest(unittest.IsolatedAsyncioTestCase):
    def make_store(self, remote=None):
        kv = FakeKV(remote)
        store = GuildSettings(kv)
        # 再読込間隔内（= 手元の写しが古いまま）でも保存が巻き戻らないことを見る
        store.reload_interval = 3600
        return store, kv

    async def test_dashboard_save_survives_stale_update_other_section(self):
        store, kv = self.make_store({"123": {"assist_welcome": {"enabled": False}}})
        await store.ensure_loaded()
        # Web ダッシュボードが別プロセスから保存した
        kv.remote["123"] = {"assist_welcome": {"enabled": True}}
        # Bot 側の自動書き込み（タイマー告知など）が古い写しのまま別セクションを保存する
        await store.update(123, "assist_timed", last_sent="2026-11-10T07:00:00")
        # Web の保存が消えず、Bot の変更も入っている
        self.assertEqual(kv.remote["123"], {
            "assist_welcome": {"enabled": True},
            "assist_timed": {"last_sent": "2026-11-10T07:00:00"},
        })
        self.assertTrue(store.get(123, "assist_welcome")["enabled"])

    async def test_dashboard_save_survives_stale_update_same_section(self):
        store, kv = self.make_store({"123": {"assist_timed": {"channel_id": 111}}})
        await store.ensure_loaded()
        # Web が同じセクションの別項目を保存した
        kv.remote["123"] = {"assist_timed": {"channel_id": 222}}
        # Bot は古い写し（channel_id=111）を基に last_sent だけを足す
        await store.update(123, "assist_timed", last_sent="2026-11-10T07:00:00")
        self.assertEqual(kv.remote["123"], {
            "assist_timed": {"channel_id": 222, "last_sent": "2026-11-10T07:00:00"},
        })

    async def test_saved_value_intact_after_ttl_expiry(self):
        store, kv = self.make_store({"123": {"assist_welcome": {"enabled": False}}})
        await store.ensure_loaded()
        kv.remote["123"] = {"assist_welcome": {"enabled": True}}
        await store.update(123, "assist_timed", last_sent="2026-11-10T07:00:00")
        # 再読込間隔を過ぎて読み直しても、Web の保存値は残っている
        store.reload_interval = 0
        await store.ensure_loaded()
        self.assertTrue(store.get(123, "assist_welcome")["enabled"])
        self.assertEqual(store.get(123, "assist_timed"),
                         {"last_sent": "2026-11-10T07:00:00"})

    async def test_update_delete_keeps_external_sections(self):
        store, kv = self.make_store({"123": {"a": {"x": 1}}})
        await store.ensure_loaded()
        kv.remote["123"] = {"a": {"x": 1}, "b": {"y": 2}}
        # x を消す（セクション a が空になる）保存でも、Web の b は残る
        await store.update(123, "a", x=None)
        self.assertEqual(kv.remote["123"], {"b": {"y": 2}})

    async def test_plain_update_still_roundtrips(self):
        store, kv = self.make_store()
        await store.update(456, "assist_invites", enabled=True, channel_id=999)
        self.assertEqual(kv.remote["456"],
                         {"assist_invites": {"enabled": True, "channel_id": 999}})
        self.assertEqual(store.get(456, "assist_invites"),
                         {"enabled": True, "channel_id": 999})


class LoadOneTest(unittest.IsolatedAsyncioTestCase):
    """KVStore.load_one（書き込み直前の1件読み直し）の優先順位。"""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "bot_kv.json")

    def store(self, client, namespace="guild_settings"):
        return KVStore(namespace, client=client, path=self.path)

    async def test_returns_remote_value_and_none_for_missing(self):
        db = FakeKVSupabase(rows=[
            {"namespace": "guild_settings", "key": "1", "value": {"a": {"x": 1}}},
        ])
        store = self.store(db)
        self.assertEqual(await store.load_one("1"), {"a": {"x": 1}})
        self.assertIsNone(await store.load_one("2"))

    async def test_unsent_local_value_wins_over_remote(self):
        db = FakeKVSupabase(rows=[
            {"namespace": "guild_settings", "key": "1", "value": {"a": {"x": 1}}},
        ])
        store = self.store(db)
        db.block_next_write()
        await store.set("1", {"a": {"x": 2}}, wait=False)
        # まだ遠隔へ届いていない自プロセスの保存が最新として返る
        self.assertEqual(await store.load_one("1"), {"a": {"x": 2}})
        db.release()
        await store.flush()
        self.assertEqual(db.value("guild_settings", "1"), {"a": {"x": 2}})

    async def test_external_write_is_seen(self):
        db = FakeKVSupabase(rows=[
            {"namespace": "guild_settings", "key": "1", "value": {"a": {"x": 1}}},
        ])
        store = self.store(db)
        self.assertEqual(await store.load_one("1"), {"a": {"x": 1}})
        # 別プロセス（Web）が直接書き換えた値は、キャッシュ無しで見える
        db.rows[:] = [
            r for r in db.rows
            if not (r["namespace"] == "guild_settings" and r["key"] == "1")
        ]
        db.rows.append({"namespace": "guild_settings", "key": "1", "value": {"a": {"x": 9}}})
        self.assertEqual(await store.load_one("1"), {"a": {"x": 9}})


if __name__ == "__main__":
    unittest.main()
