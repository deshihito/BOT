"""core/storage.py（Supabase の bot_kv と、ローカル JSON への切り替え）のテスト。ファイルは一時フォルダにだけ書く。"""

import json
import os
import sys
import tempfile
import unittest
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.storage import KVStore, is_missing_table  # noqa: E402
from tests.fake_kv_supabase import APIError, FakeKVSupabase, missing_table_error  # noqa: E402


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "bot_kv.json")

    def store(self, client, namespace="ns"):
        return KVStore(namespace, client=client, path=self.path)

    def local(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)


class RemoteTest(Base):
    async def test_background_set_updates_local_immediately_and_remote_later(self):
        db = FakeKVSupabase()
        store = self.store(db)
        await store.set("k", 1, wait=False)
        self.assertEqual(self.local()["ns"], {"k": 1})
        await asyncio.sleep(0.1)
        self.assertEqual(db.value("ns", "k"), 1)

    async def test_background_writes_coalesce_to_latest_value(self):
        db = FakeKVSupabase()
        store = self.store(db)
        await store.set("k", 1, wait=False)
        await store.set("k", 2, wait=False)
        await asyncio.sleep(0.1)
        self.assertEqual(db.value("ns", "k"), 2)

    async def test_background_set_does_not_overwrite_newer_sync_set(self):
        db = FakeKVSupabase()
        db.block_next_write()
        store = self.store(db)
        await store.set("k", "old", wait=False)
        await asyncio.to_thread(db.gate_started.wait, 2)
        task = asyncio.create_task(store.set("k", "new"))
        await asyncio.sleep(0.05)
        db.release()
        await task
        self.assertEqual(db.value("ns", "k"), "new")

    async def test_delete_after_background_set_is_not_resurrected(self):
        db = FakeKVSupabase()
        db.block_next_write()
        store = self.store(db)
        await store.set("k", "old", wait=False)
        await asyncio.to_thread(db.gate_started.wait, 2)
        task = asyncio.create_task(store.delete("k"))
        await asyncio.sleep(0.05)
        db.release()
        await task
        self.assertIsNone(db.value("ns", "k"))
        self.assertNotIn("ns", self.local())

    async def test_load_does_not_revert_value_saved_during_read(self):
        db = FakeKVSupabase(rows=[{"namespace": "ns", "key": "k", "value": "old"}])
        db.block_next("select")
        store = self.store(db)
        task = asyncio.create_task(store.load_all())
        await asyncio.to_thread(db.gate_started.wait, 2)
        await store.set("k", "new")
        db.release()
        self.assertEqual(await task, {"k": "new"})
        self.assertEqual(self.local()["ns"], {"k": "new"})

    async def test_unsent_value_survives_restart_and_beats_stale_remote(self):
        db = FakeKVSupabase(rows=[{"namespace": "ns", "key": "k", "value": False}])
        db.error = APIError("temporary unavailable")
        store = self.store(db)
        with self.assertLogs("core.storage", level="WARNING"):
            await store.set("k", True)
        self.assertEqual(self.local()["ns"], {"k": True})

        db.error = None
        restarted = self.store(db)
        self.assertEqual(await restarted.load_all(), {"k": True})
        self.assertEqual(self.local()["ns"], {"k": True})
        self.assertTrue(restarted.has_pending)
        self.assertTrue(await restarted.flush(timeout=2))
        self.assertEqual(db.value("ns", "k"), True)
        self.assertFalse(restarted.has_pending)

    async def test_failed_write_is_retried_without_another_edit(self):
        db = FakeKVSupabase()
        db.error = APIError("temporary unavailable")
        store = self.store(db)
        with self.assertLogs("core.storage", level="WARNING"):
            await store.set("k", 1)
        self.assertTrue(store.has_pending)
        db.error = None
        self.assertTrue(await store.flush(timeout=2))
        self.assertEqual(db.value("ns", "k"), 1)

    async def test_background_failure_schedules_retry(self):
        db = FakeKVSupabase()
        db.error = APIError("temporary unavailable")
        store = self.store(db)
        store.retry_delay = 0.05
        store.max_retry_delay = 0.05
        with self.assertLogs("core.storage", level="WARNING"):
            await store.set("k", 1, wait=False)
            await asyncio.sleep(0.15)
        self.assertTrue(store.has_pending)
        db.error = None
        await asyncio.sleep(0.3)
        self.assertEqual(db.value("ns", "k"), 1)
        self.assertFalse(store.has_pending)

    async def test_set_load_delete_in_supabase_and_local_copy(self):
        db = FakeKVSupabase()
        store = self.store(db)
        await store.set("1", {"a": 1})
        await store.set(2, [1, 2])
        self.assertEqual(db.value("ns", "1"), {"a": 1})
        self.assertIn("updated_at", db.rows[0])
        self.assertEqual(await self.store(db).load_all(), {"1": {"a": 1}, "2": [1, 2]})
        self.assertEqual(self.local(), {"ns": {"1": {"a": 1}, "2": [1, 2]}})

        await store.delete("1")
        self.assertIsNone(db.value("ns", "1"))
        self.assertEqual(await self.store(db).load_all(), {"2": [1, 2]})

    async def test_namespaces_are_separate(self):
        db = FakeKVSupabase()
        await self.store(db, "a").set("k", 1)
        await self.store(db, "b").set("k", 2)
        self.assertEqual(await self.store(db, "a").load_all(), {"k": 1})
        self.assertEqual(await self.store(db, "b").load_all(), {"k": 2})
        self.assertEqual(self.local(), {"a": {"k": 1}, "b": {"k": 2}})

    async def test_remote_is_source_of_truth_on_load(self):
        db = FakeKVSupabase(rows=[{"namespace": "ns", "key": "x", "value": 1}])
        store = self.store(None)
        await store.set("old", 9)  # ローカルにだけある古い控え
        self.assertEqual(await self.store(db).load_all(), {"x": 1})
        self.assertEqual(self.local(), {"ns": {"x": 1}})

    async def test_pagination(self):
        db = FakeKVSupabase(rows=[{"namespace": "ns", "key": str(i), "value": i} for i in range(1005)])
        self.assertEqual(len(await self.store(db).load_all()), 1005)


class FallbackTest(Base):
    async def test_no_supabase_uses_local_file(self):
        store = self.store(None)
        await store.set("k", {"v": 1})
        self.assertEqual(await self.store(None).load_all(), {"k": {"v": 1}})

    async def test_missing_table_falls_back_and_logs_once(self):
        db = FakeKVSupabase(error=missing_table_error())
        store = self.store(db)
        with self.assertLogs("core.storage", level="WARNING") as logs:
            await store.set("k", 1)
            await store.set("k2", 2)
            data = await store.load_all()
        self.assertEqual(data, {"k": 1, "k2": 2})
        warnings = [r for r in logs.records if r.levelname == "WARNING"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("bot_kv.sql", warnings[0].getMessage())
        self.assertFalse(store.remote_enabled)
        self.assertEqual(len(db.calls), 1)  # テーブルが無いとわかったら、もう Supabase には問い合わせない

    async def test_other_errors_fall_back_but_keep_trying(self):
        db = FakeKVSupabase(error=APIError("connection reset"))
        store = self.store(db)
        with self.assertLogs("core.storage", level="WARNING"):
            await store.set("k", 1)
        self.assertTrue(store.remote_enabled)
        db.error = None
        await store.set("k", 2)
        self.assertEqual(db.value("ns", "k"), 2)

    async def test_broken_local_file_is_ignored(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{oops")
        with self.assertLogs("core.storage", level="ERROR"):
            self.assertEqual(self.store(None).load_local(), {})

    def test_is_missing_table(self):
        self.assertTrue(is_missing_table(missing_table_error()))
        self.assertTrue(is_missing_table(Exception('relation "public.bot_kv" does not exist')))
        self.assertFalse(is_missing_table(Exception("timeout")))

    def test_sql_file_matches(self):
        sql = (ROOT / "docs" / "sql" / "bot_kv.sql").read_text(encoding="utf-8")
        for text in ("create table if not exists public.bot_kv", "namespace text not null", "key text not null",
                     "value jsonb", "updated_at timestamptz not null default now()", "primary key (namespace, key)"):
            self.assertIn(text, sql)


if __name__ == "__main__":
    unittest.main()
