"""Tests for the X (FxTwitter / FxEmbed API) source of SNS notify."""
from __future__ import annotations

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.sns import (
    SnsError,
    SnsFetcher,
    _sns_fx_base,
    parse_fx_profile,
    parse_fx_statuses,
    sns_epoch,
)

OWNER = {"screen_name": "jack", "name": "jack", "id": "12"}
OTHER = {"screen_name": "willemaw", "name": "Willem", "id": "2045"}


def _status(post_id, author, *, text="hello", ts=1794030109, reposted_by=None,
            replying_to=None, quote=None, created_at="Sat Nov 07 08:41:49 +0000 2026"):
    row = {
        "type": "status",
        "id": str(post_id),
        "url": f"https://x.com/{author['screen_name']}/status/{post_id}",
        "text": text,
        "created_at": created_at,
        "author": author,
        "reposted_by": reposted_by,
        "replying_to": replying_to,
    }
    if ts is not None:
        row["created_timestamp"] = ts
    if quote is not None:
        row["quote"] = quote
    return row


STATUSES_PAYLOAD = {
    "code": 200,
    "results": [
        # 本人の通常ポスト
        _status(1001, OWNER, text="first post"),
        # 他人のポストのリポスト → 除外
        _status(1002, OTHER, reposted_by=OWNER),
        # 自己リポスト → 除外（IDは元ポストと同一で通知済み扱い）
        _status(1001, OWNER, reposted_by=OWNER),
        # 他人宛の返信 → 除外
        _status(1003, OWNER, replying_to={"screen_name": "willemaw", "status": "1000"}),
        # 自分宛（スレッドの続き）の返信 → 含める
        _status(1004, OWNER, replying_to={"screen_name": "jack", "status": "1001"}),
        # 引用ポスト → 含める
        _status(1005, OWNER, quote={"id": "999", "text": "quoted"}),
        # created_timestamp が無い場合は created_at にフォールバック
        _status(1006, OWNER, ts=None),
    ],
    "cursor": {"top": "t", "bottom": "b"},
}

PROFILE_PAYLOAD = {
    "code": 200,
    "message": "OK",
    "user": {"id": "12", "screen_name": "jack", "name": "jack dorsey", "protected": False},
}


class ParseFxStatusesTest(unittest.TestCase):
    def test_keeps_only_own_posts(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        self.assertEqual([i.id for i in items], ["1001", "1004", "1005", "1006"])

    def test_fields_and_timestamp_priority(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        first = items[0]
        self.assertEqual(first.title, "first post")
        self.assertEqual(first.url, "https://x.com/jack/status/1001")
        self.assertEqual(first.author, "jack")
        # created_timestamp (unix秒) が ISO8601 になり、sns_epoch で戻せる
        self.assertEqual(sns_epoch(first.published), 1794030109)

    def test_created_at_fallback(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        last = items[-1]
        self.assertEqual(last.id, "1006")
        self.assertEqual(last.published, "Sat Nov 07 08:41:49 +0000 2026")

    def test_screen_name_case_insensitive(self):
        payload = {"code": 200, "results": [_status(2001, {"screen_name": "Jack", "name": "j"})]}
        items = parse_fx_statuses(payload, "jack")
        self.assertEqual([i.id for i in items], ["2001"])

    def test_non_200_code_raises(self):
        with self.assertRaises(SnsError):
            parse_fx_statuses({"code": 404, "message": "User not found"}, "jack")
        with self.assertRaises(SnsError):
            parse_fx_statuses(None, "jack")


class ParseFxProfileTest(unittest.TestCase):
    def test_profile(self):
        uid, name = parse_fx_profile(PROFILE_PAYLOAD, "jack")
        self.assertEqual(uid, "12")
        self.assertEqual(name, "jack dorsey")

    def test_protected_raises(self):
        payload = {"code": 200, "user": {"id": "1", "name": "x", "protected": True}}
        with self.assertRaises(SnsError):
            parse_fx_profile(payload, "jack")

    def test_not_found_raises(self):
        with self.assertRaises(SnsError):
            parse_fx_profile({"code": 404, "message": "User not found"}, "jack")
        with self.assertRaises(SnsError):
            parse_fx_profile({"code": 200, "user": None}, "jack")


class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def read(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _FakeSession:
    """URLの一部で応答を振り分ける aiohttp セッションの代役。"""

    def __init__(self, routes):
        self.routes = routes  # list of (url_part, status, payload)

    def get(self, url, params=None, headers=None):
        for part, status, payload in self.routes:
            if part in url:
                body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                return _FakeResp(status, body)
        return _FakeResp(404, b'{"code":404,"message":"User not found"}')


class FxFetcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_lookup_returns_key_uid_name_items(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/statuses", 200, STATUSES_PAYLOAD),
            ("/2/profile/", 200, PROFILE_PAYLOAD),
        ]))
        found = await fetcher.lookup("x", "@Jack")
        self.assertEqual(found["key"], "jack")
        self.assertEqual(found["uid"], "12")
        self.assertEqual(found["name"], "jack dorsey")
        self.assertEqual([i.id for i in found["items"]], ["1001", "1004", "1005", "1006"])

    async def test_lookup_unknown_user_raises(self):
        fetcher = SnsFetcher(_FakeSession([]))
        with self.assertRaises(SnsError):
            await fetcher.lookup("x", "@nope_nope")

    async def test_poll_uses_statuses(self):
        fetcher = SnsFetcher(_FakeSession([("/statuses", 200, STATUSES_PAYLOAD)]))
        items, uid = await fetcher.poll({"platform": "x", "key": "jack"})
        self.assertIsNone(uid)
        self.assertEqual([i.id for i in items], ["1001", "1004", "1005", "1006"])

    async def test_rate_limit_raises(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/statuses", 429, {"code": 429, "message": "Rate limited"}),
        ]))
        with self.assertRaises(SnsError) as ctx:
            await fetcher.x_fx_posts("jack")
        self.assertIn("レート制限", str(ctx.exception))

    async def test_code_field_checked_even_on_http_200(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/2/profile/", 200, {"code": 404, "message": "User not found"}),
        ]))
        with self.assertRaises(SnsError):
            await fetcher.x_fx_lookup_user("jack")


class FxBaseTest(unittest.TestCase):
    def test_default_base(self):
        old = os.environ.pop("FXTWITTER_API_BASE", None)
        try:
            self.assertEqual(_sns_fx_base(), "https://api.fxtwitter.com")
            os.environ["FXTWITTER_API_BASE"] = "http://localhost:8787/"
            self.assertEqual(_sns_fx_base(), "http://localhost:8787")
        finally:
            if old is None:
                os.environ.pop("FXTWITTER_API_BASE", None)
            else:
                os.environ["FXTWITTER_API_BASE"] = old


if __name__ == "__main__":
    unittest.main()
