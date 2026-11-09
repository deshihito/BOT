"""Logfare APIキー予備（RPD用フェイルオーバー）のテスト。

キー値そのものは扱わず、ダミー文字列で Authorization の切替だけを検証する。
"""
import base64
import json
import os
import time
import unittest
from unittest.mock import patch

from core.general.ai import logfare

ENV_NAMES = ("LOGFARE_API_KEY", "LOGFARE_API_KEY_2", "LOGFARE_API_KEY_3", "LOGFARE_API_KEYS")


class FakeLines:
    def __init__(self, lines):
        self.lines = lines

    def __aiter__(self):
        async def iterate():
            for line in self.lines:
                yield line
        return iterate()


class FakeResponse:
    def __init__(self, status=200, *, json_data=None, lines=None, headers=None, text=None):
        self.status = status
        self.headers = headers or {}
        self._json = json_data
        self.content = FakeLines(lines or [])
        if text is not None:
            self._text = text
        elif json_data is not None:
            self._text = json.dumps(json_data)
        else:
            self._text = ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def json(self):
        if isinstance(self._json, Exception):
            raise self._json
        return self._json

    async def text(self):
        return self._text

    async def read(self):
        return b"image-bytes"

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")


class FakeSession:
    def __init__(self, http):
        self.http = http

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    def post(self, url, *, headers=None, json=None, data=None, params=None):
        self.http.requests.append(
            {"method": "post", "url": url, "headers": headers, "json": json, "data": data, "params": params}
        )
        return self.http.next_response()

    def get(self, url, **kwargs):
        self.http.requests.append({"method": "get", "url": url})
        return self.http.next_response()


class FakeHttp:
    """ClientSession の代わりに、応答を順番に配るフェイク。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def next_response(self):
        if not self.responses:
            raise AssertionError("想定より多いリクエストが発生しました")
        return self.responses.pop(0)

    def client_session(self, *args, **kwargs):
        return FakeSession(self)

    def auths(self):
        return [r["headers"]["Authorization"] for r in self.requests if r.get("headers")]


class LogfareApiKeysTestCase:
    """env とクールダウンを初期化する mixin（TestCase 本体ではない）。"""
    def setUp(self):
        self._saved_env = {name: os.environ.get(name) for name in ENV_NAMES}
        for name in ENV_NAMES:
            os.environ.pop(name, None)
        logfare._key_cooldown_until.clear()

    def tearDown(self):
        for name, value in self._saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        logfare._key_cooldown_until.clear()

    def set_env(self, **kwargs):
        for name, value in kwargs.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class ApiKeysParsingTests(LogfareApiKeysTestCase, unittest.TestCase):
    def test_order_dedupe_and_blank_exclusion(self):
        self.set_env(
            LOGFARE_API_KEY=" key-a ",
            LOGFARE_API_KEY_2="key-b",
            LOGFARE_API_KEY_3="",
            LOGFARE_API_KEYS="key-c, key-a,,key-d ,key-c",
        )
        self.assertEqual(logfare.api_keys(), ["key-a", "key-b", "key-c", "key-d"])
        self.assertEqual(logfare.api_key(), "key-a")

    def test_no_keys(self):
        self.assertEqual(logfare.api_keys(), [])
        self.assertIsNone(logfare.api_key())

    def test_keys_env_only(self):
        self.set_env(LOGFARE_API_KEYS="key-x,key-y")
        self.assertEqual(logfare.api_keys(), ["key-x", "key-y"])
        self.assertEqual(logfare.api_key(), "key-x")


class ChatCompletionFailoverTests(LogfareApiKeysTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_429_falls_back_to_second_key(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([
            FakeResponse(429, headers={"Retry-After": "120"}),
            FakeResponse(200, json_data={"choices": [{"message": {"content": "ok"}}]}),
        ])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            data = await logfare.chat_completion("model", [{"role": "user", "content": "hi"}])
        self.assertEqual(data["choices"][0]["message"]["content"], "ok")
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])
        # 429 を返したキーはクールダウンに入る（値はログ等に出さない）
        self.assertIn("key-a", logfare._key_cooldown_until)
        self.assertNotIn("key-b", logfare._key_cooldown_until)

    async def test_non_429_does_not_fall_back(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(500)])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(logfare.LogfareHTTPError) as ctx:
                await logfare.chat_completion("model", [{"role": "user", "content": "hi"}])
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(len(http.requests), 1)

    async def test_all_keys_429_raises_last_429(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(429), FakeResponse(429)])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(logfare.LogfareHTTPError) as ctx:
                await logfare.chat_completion("model", [{"role": "user", "content": "hi"}])
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])

    async def test_cooldown_skips_primary_on_next_request(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([
            FakeResponse(429, headers={"Retry-After": "3600"}),
            FakeResponse(200, json_data={"ok": 1}),
            FakeResponse(200, json_data={"ok": 2}),
        ])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            await logfare.chat_completion("model", [])
            await logfare.chat_completion("model", [])
        # 2回目はクールダウン中の主キーを飛ばし、予備キーだけを使う
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b", "Bearer key-b"])

    async def test_all_in_cooldown_tries_earliest_expiring_key(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        now = time.monotonic()
        logfare._key_cooldown_until["key-a"] = now + 1000
        logfare._key_cooldown_until["key-b"] = now + 10
        http = FakeHttp([FakeResponse(200, json_data={"ok": True})])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            data = await logfare.chat_completion("model", [])
        self.assertEqual(data, {"ok": True})
        self.assertEqual(http.auths(), ["Bearer key-b"])

    async def test_single_key_429_behaves_as_before(self):
        self.set_env(LOGFARE_API_KEY="key-a")
        http = FakeHttp([FakeResponse(429, headers={"Retry-After": "30"})])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(logfare.LogfareHTTPError) as ctx:
                await logfare.chat_completion("model", [])
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(ctx.exception.retry_after, "30")
        self.assertEqual(len(http.requests), 1)

    async def test_no_key_raises_runtime_error(self):
        http = FakeHttp([])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaisesRegex(RuntimeError, "LOGFARE_API_KEY"):
                await logfare.chat_completion("model", [])
        self.assertEqual(http.requests, [])


class ChatStreamFailoverTests(LogfareApiKeysTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_stream_429_falls_back_to_second_key(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        events = [
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n'.encode(),
            b"data: [DONE]\n",
        ]
        http = FakeHttp([FakeResponse(429), FakeResponse(200, lines=events)])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            result = [text async for text in logfare.chat_stream("model", [{"role": "user", "content": "hi"}])]
        self.assertEqual(result, ["hello"])
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])

    async def test_stream_500_does_not_fall_back(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(500)])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(logfare.LogfareHTTPError) as ctx:
                [text async for text in logfare.chat_stream("model", [])]
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(len(http.requests), 1)


class DecisionFailoverTests(LogfareApiKeysTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_decision_429_falls_back(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(429), FakeResponse(200, json_data={"result": {}})])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            data = await logfare.decision("model", "state", {"q": {}})
        self.assertEqual(data, {"result": {}})
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])


class TranscribeFailoverTests(LogfareApiKeysTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_transcribe_429_falls_back_to_second_key(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([
            FakeResponse(429),
            FakeResponse(200, text='{"text": "こんにちは"}'),
        ])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            text = await logfare.transcribe_audio(b"audio-bytes")
        self.assertEqual(text, "こんにちは")
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])


class GenerateImageFailoverTests(LogfareApiKeysTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_image_429_falls_back_to_second_key(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        payload = {"data": [{"b64_json": base64.b64encode(b"png-bytes").decode()}]}
        http = FakeHttp([FakeResponse(429, text="rate limited"), FakeResponse(200, json_data=payload)])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            data = await logfare.generate_image("model", "a cat")
        self.assertEqual(data, b"png-bytes")
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])

    async def test_image_all_429_raises_legacy_runtime_error(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(429, text="limited-a"), FakeResponse(429, text="limited-b")])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaisesRegex(RuntimeError, "Logfare image API error 429: limited-b"):
                await logfare.generate_image("model", "a cat")

    async def test_image_500_does_not_fall_back(self):
        self.set_env(LOGFARE_API_KEY="key-a", LOGFARE_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(500, text="boom")])
        with patch("core.general.ai.logfare.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaisesRegex(RuntimeError, "Logfare image API error 500: boom"):
                await logfare.generate_image("model", "a cat")
        self.assertEqual(len(http.requests), 1)


if __name__ == "__main__":
    unittest.main()
