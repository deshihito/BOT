import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.app import app


class _FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, params=None):
        type(self.connection).last_statement = statement
        type(self.connection).last_params = params
        if isinstance(statement, str) and "information_schema.columns" in statement:
            self.rows = [
                {"column_name": "user_id", "udt_name": "text"},
                {"column_name": "balance", "udt_name": "int8"},
            ]
        else:
            self.rows = [{"user_id": "user-1", "balance": 42}]

    def fetchall(self):
        return self.rows


class _FakeConnection:
    last_statement = None
    last_params = None

    @contextmanager
    def transaction(self):
        yield self

    def execute(self, _statement):
        return self

    def cursor(self, **_kwargs):
        return _FakeCursor(self)


class _FakePool:
    def __init__(self, **_kwargs):
        self.opened = False

    def open(self, wait=True):
        self.opened = True

    def close(self):
        self.opened = False

    @contextmanager
    def connection(self, **_kwargs):
        yield _FakeConnection()


class APIServerSecurityTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict("os.environ", {"DATABASE_URL": "postgresql://unused", "BOT_API_KEY": "test-secret"})
        self.env.start()
        self.pool_patch = patch("api.app.ConnectionPool", _FakePool)
        self.pool_patch.start()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.pool_patch.stop()
        self.env.stop()

    def test_health_is_ready_without_exposing_credentials(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_query_requires_bearer_key(self):
        response = self.client.post("/v1/query", json={"table": "users"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"]["code"], "UNAUTHORIZED")

    def test_query_rejects_tables_outside_public_allowlist(self):
        response = self.client.post(
            "/v1/query",
            headers={"Authorization": "Bearer test-secret"},
            json={"table": "auth.users", "action": "select"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "TABLE_NOT_ALLOWED")

    def test_query_binds_filter_values_as_parameters(self):
        injected = "x'); DROP TABLE public.users; --"
        response = self.client.post(
            "/v1/query",
            headers={"Authorization": "Bearer test-secret"},
            json={
                "table": "users",
                "action": "select",
                "columns": "user_id,balance",
                "filters": [{"column": "user_id", "op": "eq", "value": injected}],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"], [{"user_id": "user-1", "balance": 42}])
        self.assertIn(injected, _FakeConnection.last_params)
        self.assertNotIsInstance(_FakeConnection.last_statement, str)

    def test_rpc_rejects_unlisted_functions(self):
        response = self.client.post(
            "/v1/rpc",
            headers={"Authorization": "Bearer test-secret"},
            json={"name": "pg_sleep", "params": {"seconds": 10}},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "RPC_NOT_ALLOWED")


if __name__ == "__main__":
    unittest.main()
