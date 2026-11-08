# -*- coding: utf-8 -*-
"""fastHTML の API 側（api/app.py の /v1/fast）のテスト。

DB は使わない経路だが、アプリの lifespan がプールを作るため既存の
test_api_server と同じ偽プールで起動する。保存先は FASTHTML_STORAGE_DIR
で一時ディレクトリへ差し替える（外部ネットワーク・実DBに依存しない）。
"""
import base64
import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
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
HTML = b"<!doctype html><title>t</title><script>1</script>"


def _payload(owner="111", data=HTML, filename="page.html"):
    return {
        "filename": filename,
        "owner_id": owner,
        "content_b64": base64.b64encode(data).decode("ascii"),
    }


class FastHtmlApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict("os.environ", {
            "DATABASE_URL": "postgresql://unused",
            "BOT_API_KEY": "test-key",
            "FASTHTML_STORAGE_DIR": self.tmp.name,
        })
        self.env.start()
        self.pool_patch = patch("api.app.ConnectionPool", _FakePool)
        self.pool_patch.start()
        api_app._fasthtml_index = None
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.pool_patch.stop()
        self.env.stop()
        api_app._fasthtml_index = None
        self.tmp.cleanup()

    def _create(self, **kwargs):
        return self.client.post("/v1/fast", headers=AUTH, json=_payload(**kwargs))

    def test_create_requires_auth(self):
        response = self.client.post("/v1/fast", json=_payload())
        self.assertEqual(response.status_code, 401)

    def test_create_and_get_roundtrip(self):
        created = self._create()
        self.assertEqual(created.status_code, 200)
        data = created.json()["data"]
        token = data["token"]
        self.assertGreater(len(token), 20)
        self.assertGreater(data["expires_at"], int(time.time()))
        self.assertTrue((Path(self.tmp.name) / f"{token}.html").exists())

        got = self.client.get(f"/v1/fast/{token}", headers=AUTH)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, HTML)
        self.assertIn("X-Fast-Expires-At", got.headers)

    def test_get_unknown_token_404(self):
        response = self.client.get("/v1/fast/" + "a" * 32, headers=AUTH)
        self.assertEqual(response.status_code, 404)
        response = self.client.get("/v1/fast/..%2fsecret", headers=AUTH)
        self.assertEqual(response.status_code, 404)

    def test_create_rejects_oversize_and_bad_base64(self):
        big = b"x" * (api_app.FASTHTML_MAX_BYTES + 1)
        response = self._create(data=big)
        self.assertEqual(response.status_code, 413)
        response = self.client.post(
            "/v1/fast", headers=AUTH,
            json={"filename": "a.html", "owner_id": "1", "content_b64": "!!!"},
        )
        self.assertEqual(response.status_code, 400)

    def test_per_user_limit(self):
        for _ in range(api_app.FASTHTML_MAX_PER_USER):
            self.assertEqual(self._create().status_code, 200)
        response = self._create()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["detail"]["code"], "FASTHTML_LIMIT")
        # 別のユーザーは影響を受けない
        self.assertEqual(self._create(owner="222").status_code, 200)

    def test_delete_owner_only(self):
        token = self._create().json()["data"]["token"]
        response = self.client.request(
            "DELETE", f"/v1/fast/{token}", headers=AUTH, json={"owner_id": "999"},
        )
        self.assertEqual(response.status_code, 403)
        # まだ残っている
        self.assertEqual(self.client.get(f"/v1/fast/{token}", headers=AUTH).status_code, 200)
        response = self.client.request(
            "DELETE", f"/v1/fast/{token}", headers=AUTH, json={"owner_id": "111"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get(f"/v1/fast/{token}", headers=AUTH).status_code, 404)
        self.assertFalse((Path(self.tmp.name) / f"{token}.html").exists())

    def test_expired_get_returns_410_and_prunes(self):
        token = self._create().json()["data"]["token"]
        index = api_app._fasthtml_load_index()
        index[token]["expires_at"] = time.time() - 1
        api_app._fasthtml_save_index()
        response = self.client.get(f"/v1/fast/{token}", headers=AUTH)
        self.assertEqual(response.status_code, 410)
        self.assertNotIn(token, api_app._fasthtml_load_index())
        self.assertFalse((Path(self.tmp.name) / f"{token}.html").exists())

    def test_create_prunes_expired_entries(self):
        token = self._create().json()["data"]["token"]
        index = api_app._fasthtml_load_index()
        index[token]["expires_at"] = time.time() - 1
        api_app._fasthtml_save_index()
        # 期限切れは上限に数えられない（prune されてから数える）
        for _ in range(api_app.FASTHTML_MAX_PER_USER):
            self.assertEqual(self._create().status_code, 200)
        self.assertNotIn(token, api_app._fasthtml_load_index())


if __name__ == "__main__":
    unittest.main()
