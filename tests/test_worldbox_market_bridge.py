# -*- coding: utf-8 -*-
"""core/general/market/worldbox_bridge.py（WorldBox 取引所の橋渡し）のテスト。

- オプの検証（parse_market_op）
- スナップショットの形（build_snapshot）
- poll_once の適用フロー（fake KV + fake 実行系）: done / failed /
  claim の不一致では適用しない / 古い processing は中断として failed
- MarketStore.apply_convert の保存則（プール＋保有＝総量）
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general.market import market as market_core
from core.general.market import worldbox_bridge as bridge


class ParseMarketOpTest(unittest.TestCase):
    def test_buy_ok(self):
        op = bridge.parse_market_op({
            "id": "op-12345678", "kind": "buy",
            "userId": "1000302102473613373", "amountAga": 500,
        })
        self.assertEqual(op["amountAga"], 500)

    def test_sell_ok_float(self):
        op = bridge.parse_market_op({
            "id": "op-12345678", "kind": "sell",
            "userId": "12345", "tokenAmount": 2.5,
        })
        self.assertEqual(op["tokenAmount"], 2.5)

    def test_convert_ok(self):
        op = bridge.parse_market_op({
            "id": "op-12345678", "kind": "convert",
            "userId": "12345", "count": 3,
        })
        self.assertEqual(op["count"], 3)

    def test_rejects_bad_shapes(self):
        base = {"id": "op-12345678", "kind": "buy", "userId": "12345", "amountAga": 100}
        self.assertIsNone(bridge.parse_market_op(None))
        self.assertIsNone(bridge.parse_market_op({**base, "id": "short"}))
        self.assertIsNone(bridge.parse_market_op({**base, "kind": "steal"}))
        self.assertIsNone(bridge.parse_market_op({**base, "userId": "abc"}))
        self.assertIsNone(bridge.parse_market_op({**base, "amountAga": 0}))
        self.assertIsNone(bridge.parse_market_op({**base, "amountAga": True}))
        self.assertIsNone(bridge.parse_market_op({**base, "amountAga": 10.5}))
        self.assertIsNone(bridge.parse_market_op({
            "id": "op-12345678", "kind": "sell", "userId": "12345", "tokenAmount": -1,
        }))
        self.assertIsNone(bridge.parse_market_op({
            "id": "op-12345678", "kind": "convert", "userId": "12345", "count": 0,
        }))


class FakeKV:
    def __init__(self, records=None):
        self.records = dict(records or {})

    async def load_all(self):
        return dict(self.records)

    async def load_one(self, key):
        return self.records.get(key)

    async def set(self, key, value, *, wait=True):
        self.records[key] = value


def make_bridge(kv, *, buy=None, sell=None, convert=None, store=None):
    async def ok_buy(user_id, amount):
        return {"ok": True, "tokens": 4.95, "fee": 5, "rate": 100.0,
                "tokenBalance": 4.95, "coinBalance": 500}

    async def ok_sell(user_id, amount):
        return {"ok": True, "netAga": 490, "tokenBalance": 0.0, "coinBalance": 990}

    async def ok_convert(user_id, count):
        return {"ok": True, "tokens": float(count), "tokenBalance": float(count)}

    return bridge.WorldBoxMarketBridge(
        kv=kv,
        buy=buy or ok_buy,
        sell=sell or ok_sell,
        convert=convert or ok_convert,
        snapshot=lambda: bridge.build_snapshot(store) if store is not None else {"rate": 100.0},
    )


class PollOnceTest(unittest.IsolatedAsyncioTestCase):
    async def test_pending_buy_becomes_done_and_snapshot_published(self):
        kv = FakeKV({
            "op-12345678": {
                "id": "op-12345678", "kind": "buy", "status": "pending",
                "userId": "12345", "amountAga": 500,
            },
        })
        handled = await make_bridge(kv).poll_once()
        self.assertEqual(handled, 1)
        record = kv.records["op-12345678"]
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["result"]["tokens"], 4.95)
        self.assertIn(bridge.SNAPSHOT_KEY, kv.records)

    async def test_failed_result_becomes_failed_with_error(self):
        async def ng_buy(user_id, amount):
            return {"ok": False, "error": "コインが不足しています。"}

        kv = FakeKV({
            "op-12345678": {
                "id": "op-12345678", "kind": "buy", "status": "pending",
                "userId": "12345", "amountAga": 500,
            },
        })
        await make_bridge(kv, buy=ng_buy).poll_once()
        record = kv.records["op-12345678"]
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "コインが不足しています。")

    async def test_invalid_op_becomes_failed(self):
        kv = FakeKV({
            "op-12345678": {
                "id": "op-12345678", "kind": "buy", "status": "pending",
                "userId": "not-a-number", "amountAga": 500,
            },
        })
        await make_bridge(kv).poll_once()
        self.assertEqual(kv.records["op-12345678"]["status"], "failed")

    async def test_stale_processing_becomes_failed(self):
        kv = FakeKV({
            "op-12345678": {
                "id": "op-12345678", "kind": "sell", "status": "processing",
                "userId": "12345", "tokenAmount": 1.0,
                "processingAt": 1,
            },
        })
        await make_bridge(kv).poll_once()
        self.assertEqual(kv.records["op-12345678"]["status"], "failed")

    async def test_snapshot_key_is_not_treated_as_op(self):
        kv = FakeKV({bridge.SNAPSHOT_KEY: {"rate": 100.0}})
        handled = await make_bridge(kv).poll_once()
        self.assertEqual(handled, 0)


class SnapshotAndConvertTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = market_core.MarketStore(path=Path(self.tmp.name) / "market.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_snapshot_shape(self):
        snap = bridge.build_snapshot(self.store)
        self.assertEqual(snap["rate"], market_core.ANCHOR_RATE)
        self.assertIn("history", snap)
        self.assertIn("balances", snap)
        self.assertFalse(snap["halted"])
        self.assertGreater(snap["tradeCapAga"], 0)

    def test_convert_moves_from_pool_and_keeps_supply(self):
        result = self.store.apply_convert("12345", 3.0)
        self.assertEqual(result["balance"], 3.0)
        state = self.store.snapshot()
        held = sum(state["balances"].values())
        self.assertAlmostEqual(state["pool_token"] + held, market_core.TOTAL_TOKEN_SUPPLY)

    def test_convert_rejects_more_than_pool(self):
        with self.assertRaises(market_core.TradeError):
            self.store.apply_convert("12345", market_core.TOTAL_TOKEN_SUPPLY + 1)


if __name__ == "__main__":
    unittest.main()
