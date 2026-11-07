import asyncio
import unittest

from core.support.api_client import APIError, APIResponse
from cogs.dangeon import d_apply_economy


class _FailingRPC:
    def execute(self):
        raise APIError("connection lost after request", code="API_CONNECTION_ERROR")


class _UnexpectedRPC:
    def execute(self):
        raise RuntimeError("unexpected RPC client failure")


class _FalseRPC:
    def execute(self):
        return APIResponse(False)


class _FakeDBAPI:
    def __init__(self):
        self.table_calls = 0

    def rpc(self, _name, _params):
        return _FailingRPC()

    def table(self, _name):
        self.table_calls += 1
        raise AssertionError("legacy balance fallback must not run after an ambiguous RPC failure")


class WriteFallbackSafetyTest(unittest.TestCase):
    def test_dungeon_does_not_fallback_after_ambiguous_rpc_failure(self):
        db_api = _FakeDBAPI()
        with self.assertRaises(APIError) as raised:
            asyncio.run(d_apply_economy("123", db_api, coins=5))
        self.assertEqual(raised.exception.code, "API_CONNECTION_ERROR")
        self.assertEqual(db_api.table_calls, 0)

    def test_dungeon_does_not_fallback_after_unexpected_rpc_failure(self):
        db_api = _FakeDBAPI()
        db_api.rpc = lambda _name, _params: _UnexpectedRPC()
        with self.assertRaisesRegex(RuntimeError, "unexpected RPC client failure"):
            asyncio.run(d_apply_economy("123", db_api, coins=5))
        self.assertEqual(db_api.table_calls, 0)

    def test_dungeon_explicit_false_does_not_retry_through_legacy_balance_update(self):
        db_api = _FakeDBAPI()
        db_api.rpc = lambda _name, _params: _FalseRPC()
        self.assertFalse(asyncio.run(d_apply_economy("123", db_api, coins=5)))
        self.assertEqual(db_api.table_calls, 0)


if __name__ == "__main__":
    unittest.main()
