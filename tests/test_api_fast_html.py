# -*- coding: utf-8 -*-
"""fastHTML の API 側テスト。

fastHTML はステートレス化され、サーバーは HTML 実体を一切保存しない
（Bot が Discord CDN の URL を署名付きトークンに包み、Web が中継する）。
api/app.py の /v1/fast 保存系エンドポイントは撤去済みなので、
ここでは「エンドポイントが存在しないこと」と「アプリ自体は正常に
起動すること」を確かめる。DB は既存の test_api_server と同じ偽プール。
"""
import os
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi.testclient import TestClient

import api.app as api_app
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
        self.rows = []

    def fetchall(self):
        return self.rows


class _FakeConnection:
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


_KEY = "test-key"
AUTH = {"Authorization": f"Bearer {_KEY}"}


class FastHtmlEndpointsRemovedTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict("os.environ", {
            "DATABASE_URL": "postgresql://unused",
            "BOT_API_KEY": _KEY,
        })
        self.env.start()
        self.pool_patch = patch("api.app.ConnectionPool", _FakePool)
        self.pool_patch.start()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.pool_patch.stop()
        self.env.stop()

    def test_no_fast_routes_registered(self):
        paths = {getattr(route, "path", "") for route in app.routes}
        self.assertFalse(any(p.startswith("/v1/fast") for p in paths), paths)

    def test_fast_endpoints_return_404(self):
        token = "v1." + "a" * 40 + "." + "b" * 43
        created = self.client.post(
            "/v1/fast", headers=AUTH,
            json={"filename": "a.html", "owner_id": "1", "content_b64": "eA=="},
        )
        self.assertEqual(created.status_code, 404)
        got = self.client.get(f"/v1/fast/{token}", headers=AUTH)
        self.assertEqual(got.status_code, 404)
        deleted = self.client.request(
            "DELETE", f"/v1/fast/{token}", headers=AUTH, json={"owner_id": "1"},
        )
        self.assertEqual(deleted.status_code, 404)

    def test_storage_internals_removed(self):
        for name in (
            "FASTHTML_TTL_SECONDS", "FASTHTML_MAX_BYTES", "FASTHTML_MAX_PER_USER",
            "_fasthtml_load_index", "_fasthtml_save_index", "_fasthtml_dir",
            "FastHtmlCreateRequest", "FastHtmlDeleteRequest",
        ):
            self.assertFalse(hasattr(api_app, name), name)

    def test_app_still_boots_and_healthz_works(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")


if __name__ == "__main__":
    unittest.main()
