# -*- coding: utf-8 -*-
"""EconomyPoolStore の Postgres バックエンド（コイン API 直接化 第2段）。

フェイクの db_api クライアントで SQL 関数（docs/sql/economy_pool.sql）の
意味論を再現し、次を検証する:
- 初回利用時に JSON の現在値が economy_pool_seed で DB へ移行される
- pay_house / add_loss / pay / refund / refund_house が DB を正として動き、
  JSON ファイルは書き換わらない
- RPC が使えない環境では従来の JSON 経路へフォールバックする
- 週次還流などの出口系は DB 行への CAS で適用される
- snapshot は他経路（Web 直接適用）の変更を取り込む
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import config
from core.general.circulation import economy_pool
from core.general.circulation.economy_pool import EconomyPoolStore

JST = timezone(timedelta(hours=9))

_STATE_KEYS = (
    "pool", "treasury", "total_recycled", "total_paid", "total_released",
    "total_boosted", "lottery_boost_pending", "total_house_paid",
    "last_release_date",
)


class _Response:
    def __init__(self, data):
        self.data = data


class _RpcCall:
    def __init__(self, client, name, params):
        self._client = client
        self._name = name
        self._params = params

    def execute(self):
        return _Response(self._client.apply_rpc(self._name, self._params))


class _TableQuery:
    def __init__(self, client, table):
        self._client = client
        self._table = table
        self._values = None
        self._filters: list[tuple[str, object]] = []

    def select(self, *_args, **_kwargs):
        return self

    def update(self, values):
        self._values = values
        return self

    def eq(self, column, value):
        self._filters.append((column, value))
        return self

    def execute(self):
        assert self._table == "economy_pool_state"
        row = self._client.row
        if self._values is None:
            return _Response([dict(row)] if row is not None else [])
        if row is None:
            return _Response([])
        for column, value in self._filters:
            if column == "id":
                continue
            if row.get(column) != value:
                return _Response([])
        row.update(self._values)
        return _Response([dict(row)])


class _FakeDbClient:
    """docs/sql/economy_pool.sql の関数群をインメモリで再現するフェイク。"""

    def __init__(self, *, fail_rpc: bool = False):
        self.row: dict | None = None
        self.fail_rpc = fail_rpc
        self.rpc_calls: list[str] = []

    # -- クライアント接口（core/support/api_client.py と同型） --
    def rpc(self, name, params=None):
        return _RpcCall(self, name, params or {})

    def table(self, name):
        return _TableQuery(self, name)

    # -- SQL 関数の意味論 --
    def _ensure_row(self):
        if self.row is None:
            self.row = {key: (None if key == "last_release_date" else 0) for key in _STATE_KEYS}

    def apply_rpc(self, name, params):
        self.rpc_calls.append(name)
        if self.fail_rpc:
            raise RuntimeError("RPC unavailable (simulated)")
        if name == "economy_pool_seed":
            if self.row is None:
                self.row = {
                    "pool": params["p_pool"],
                    "treasury": params["p_treasury"],
                    "total_recycled": params["p_total_recycled"],
                    "total_paid": params["p_total_paid"],
                    "total_released": params["p_total_released"],
                    "total_boosted": params["p_total_boosted"],
                    "lottery_boost_pending": params["p_lottery_boost_pending"],
                    "total_house_paid": params["p_total_house_paid"],
                    "last_release_date": params["p_last_release_date"],
                }
            return [dict(self.row)]
        self._ensure_row()
        row = self.row
        if name == "economy_pool_pay_house":
            amount = max(0, int(params["p_amount"]))
            pool_part = min(int(row["pool"]), amount)
            treasury_part = min(int(row["treasury"]), amount - pool_part)
            paid = pool_part + treasury_part
            row["pool"] -= pool_part
            row["treasury"] -= treasury_part
            row["total_house_paid"] += paid
            return [{"paid": paid, "pool_part": pool_part, "treasury_part": treasury_part}]
        if name == "economy_pool_refund_house":
            back = max(0, int(params["p_pool_part"])) + max(0, int(params["p_treasury_part"]))
            row["pool"] += max(0, int(params["p_pool_part"]))
            row["treasury"] += max(0, int(params["p_treasury_part"]))
            row["total_house_paid"] = max(0, int(row["total_house_paid"]) - back)
            return row["total_house_paid"]
        if name == "economy_pool_add_loss":
            amount = max(0, int(params["p_amount"]))
            pool_part = (amount * 7) // 10
            treasury_part = amount - pool_part
            row["pool"] += pool_part
            row["treasury"] += treasury_part
            row["total_recycled"] += amount
            return [{"pool_part": pool_part, "treasury_part": treasury_part}]
        if name == "economy_pool_pay":
            amount = max(0, int(params["p_amount"]))
            paid = min(int(row["pool"]), amount)
            row["pool"] -= paid
            row["total_paid"] += paid
            return paid
        if name == "economy_pool_refund":
            amount = max(0, int(params["p_amount"]))
            row["pool"] += amount
            row["total_paid"] = max(0, int(row["total_paid"]) - amount)
            return row["pool"]
        raise AssertionError(f"unexpected rpc {name}")


class EconomyPoolDbTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.json_path = Path(self._tmp.name) / "economy_pool.json"
        self.seed = {
            "pool": 1000, "treasury": 500, "total_recycled": 7,
            "total_paid": 0, "total_released": 0, "total_boosted": 0,
            "lottery_boost_pending": 0, "total_house_paid": 0,
            "last_release_date": None,
        }
        self.json_path.write_text(json.dumps(self.seed), encoding="utf-8")
        self._env = patch.dict(os.environ, {"ECONOMY_POOL_DATA_PATH": str(self.json_path)})
        self._env.start()
        self.addCleanup(self._env.stop)

    def _store(self, client) -> EconomyPoolStore:
        with patch.object(config, "db_api", client):
            store = EconomyPoolStore()
            # _use_db は config.db_api を都度参照するので、生成後も
            # フェイクを差し続ける必要がある。テスト中は patch を維持する代わりに
            # クライアント取得を固定する。
            store._get_db_client = lambda: client  # noqa: SLF001
            return store

    def test_seed_migrates_json_state_to_db(self):
        client = _FakeDbClient()
        store = self._store(client)
        self.assertEqual(store.pool_balance(), 1000)
        # pool_balance はミラー参照で RPC を呼ばない。snapshot で DB 化を確認する。
        store.snapshot()
        self.assertTrue(store._db_mode)  # noqa: SLF001
        self.assertEqual(client.row["pool"], 1000)
        self.assertEqual(client.row["treasury"], 500)
        self.assertEqual(client.row["total_recycled"], 7)
        self.assertIn("economy_pool_seed", client.rpc_calls)

    def test_pay_house_uses_db_and_leaves_json_untouched(self):
        client = _FakeDbClient()
        store = self._store(client)
        breakdown = store.pay_house(1200)
        self.assertEqual(breakdown, {"paid": 1200, "pool": 1000, "treasury": 200})
        self.assertEqual(client.row["pool"], 0)
        self.assertEqual(client.row["treasury"], 300)
        self.assertEqual(client.row["total_house_paid"], 1200)
        # JSON は正ではなくなったので書き換わらない
        self.assertEqual(json.loads(self.json_path.read_text(encoding="utf-8")), self.seed)
        # 戻しも DB へ
        store.refund_house(breakdown)
        self.assertEqual(client.row["pool"], 1000)
        self.assertEqual(client.row["treasury"], 500)
        self.assertEqual(client.row["total_house_paid"], 0)

    def test_add_loss_and_mining_pay_refund_use_db(self):
        client = _FakeDbClient()
        store = self._store(client)
        self.assertEqual(store.add_loss(1000), {"pool": 700, "treasury": 300})
        self.assertEqual(client.row["pool"], 1700)
        self.assertEqual(client.row["treasury"], 800)
        self.assertEqual(client.row["total_recycled"], 1007)
        self.assertEqual(store.pay(200), 200)
        self.assertEqual(client.row["pool"], 1500)
        store.refund(50)
        self.assertEqual(client.row["pool"], 1550)
        self.assertEqual(client.row["total_paid"], 150)

    def test_weekly_release_applies_via_cas(self):
        client = _FakeDbClient()
        store = self._store(client)
        store.snapshot()  # DB 化 + seed
        client.row["treasury"] = 10_000
        client.row["last_release_date"] = "2026-11-01"
        now = datetime(2026, 11, 17, tzinfo=JST)
        moved = store.maybe_weekly_release(now=now)
        self.assertEqual(moved, 2000)
        self.assertEqual(client.row["treasury"], 8000)
        self.assertEqual(client.row["pool"], 3000)
        self.assertEqual(client.row["last_release_date"], "2026-11-17")
        # 同じ週に2回は走らない
        self.assertEqual(store.maybe_weekly_release(now=now), 0)

    def test_snapshot_picks_up_external_db_changes(self):
        client = _FakeDbClient()
        store = self._store(client)
        store.snapshot()
        client.row["pool"] = 4242  # Web 直接適用など他経路の変更を模す
        snap = store.snapshot()
        self.assertEqual(snap["pool"], 4242)

    def test_fallback_to_json_when_rpc_unavailable(self):
        client = _FakeDbClient(fail_rpc=True)
        store = self._store(client)
        breakdown = store.pay_house(300)
        self.assertEqual(breakdown, {"paid": 300, "pool": 300, "treasury": 0})
        self.assertFalse(store._db_mode)  # noqa: SLF001
        self.assertIsNone(client.row)
        store.flush()
        saved = json.loads(self.json_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["pool"], 700)
        self.assertEqual(saved["total_house_paid"], 300)

    def test_explicit_json_backend_never_touches_db(self):
        client = _FakeDbClient()
        with patch.dict(os.environ, {"ECONOMY_POOL_BACKEND": "json"}):
            store = self._store(client)
            self.assertEqual(store.pay_house(100)["paid"], 100)
        self.assertEqual(client.rpc_calls, [])
        self.assertIsNone(client.row)


if __name__ == "__main__":
    unittest.main()
