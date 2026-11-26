"""Sarashina API クライアント（ASR / TTS）のテスト。

キー値そのものは扱わず、ダミー文字列で Authorization の切替だけを検証する。
実 API は叩かない（モックのみ）。
"""
import json
import os
import unittest
from unittest.mock import patch

from core.general.ai import sarashina

ENV_NAMES = tuple(
    ["SARASHINA_API_KEY", "SARASHINA_API_KEYS", "SARASHINA_BASE_URL"]
    + [f"SARASHINA_API_KEY_{i}" for i in range(2, 11)]
)


class FakeResponse:
    def __init__(self, status=200, *, json_data=None, headers=None, body=b""):
        self.status = status
        self.headers = headers or {}
        self._json = json_data
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def json(self, content_type=None):
        if isinstance(self._json, Exception):
            raise self._json
        return self._json

    async def text(self):
        if self._json is not None:
            return json.dumps(self._json)
        return self._body.decode("utf-8", errors="replace")

    async def read(self):
        return self._body


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


def form_fields(form):
    """aiohttp.FormData から {名前: 値} を取り出す（ファイルは (値, filename) にする）。"""
    out = {}
    for headers, _meta, value in form._fields:
        name = headers["name"]
        if "filename" in headers:
            out[name] = (value, headers["filename"])
        else:
            out[name] = value
    return out


class SarashinaTestCase:
    """env とクールダウンを初期化する mixin（TestCase 本体ではない）。"""

    def setUp(self):
        self._saved_env = {name: os.environ.get(name) for name in ENV_NAMES}
        for name in ENV_NAMES:
            os.environ.pop(name, None)
        sarashina._key_cooldown_until.clear()

    def tearDown(self):
        for name, value in self._saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        sarashina._key_cooldown_until.clear()

    def set_env(self, **kwargs):
        for name, value in kwargs.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class ApiKeysParsingTests(SarashinaTestCase, unittest.TestCase):
    def test_order_dedupe_and_blank_exclusion(self):
        self.set_env(
            SARASHINA_API_KEY="key-a",
            SARASHINA_API_KEY_2="key-b",
            SARASHINA_API_KEY_3="",
            SARASHINA_API_KEYS="key-c, key-a,,key-d ,key-c",
        )
        self.assertEqual(sarashina.api_keys(), ["key-a", "key-b", "key-c", "key-d"])
        self.assertEqual(sarashina.api_key(), "key-a")

    def test_numbered_keys_up_to_10(self):
        # 現在5個・将来10個まで増やす前提で、_5 や _10 も漏れなく拾うこと。
        self.set_env(
            SARASHINA_API_KEY="key-1",
            SARASHINA_API_KEY_2="key-2",
            SARASHINA_API_KEY_5="key-5",
            SARASHINA_API_KEY_9="key-9",
            SARASHINA_API_KEY_10="key-10",
        )
        self.assertEqual(
            sarashina.api_keys(),
            ["key-1", "key-2", "key-5", "key-9", "key-10"],
        )

    def test_numbered_keys_fill_after_primary_in_numeric_order(self):
        self.set_env(
            SARASHINA_API_KEY_10="key-10",
            SARASHINA_API_KEY_3="key-3",
            SARASHINA_API_KEYS="key-x",
        )
        # 主キーが無くても番号順（_3 → _10）で並び、カンマ区切りは最後に付く。
        self.assertEqual(sarashina.api_keys(), ["key-3", "key-10", "key-x"])
        self.assertEqual(sarashina.api_key(), "key-3")

    def test_no_keys(self):
        self.assertEqual(sarashina.api_keys(), [])
        self.assertIsNone(sarashina.api_key())

    def test_keys_env_only(self):
        self.set_env(SARASHINA_API_KEYS="key-x,key-y")
        self.assertEqual(sarashina.api_keys(), ["key-x", "key-y"])
        self.assertEqual(sarashina.api_key(), "key-x")


class TranscribeTests(SarashinaTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_form_and_text_extraction(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([FakeResponse(200, json_data={"text": "  こんにちは  "})])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            text = await sarashina.transcribe_audio(b"audio-bytes", filename="clip.wav")
        self.assertEqual(text, "こんにちは")
        self.assertEqual(len(http.requests), 1)
        req = http.requests[0]
        self.assertEqual(req["url"], "https://api.sarashina.ai/v1/audio/transcriptions")
        self.assertEqual(req["headers"]["Authorization"], "Bearer key-a")
        fields = form_fields(req["data"])
        self.assertEqual(fields["model"], "sarashina3.2-asr")
        self.assertEqual(fields["response_format"], "json")
        self.assertEqual(fields["file"], (b"audio-bytes", "clip.wav"))

    async def test_empty_text_returns_empty(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([FakeResponse(200, json_data={"text": ""})])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            text = await sarashina.transcribe_audio(b"audio-bytes")
        self.assertEqual(text, "")

    async def test_missing_text_raises_marker_error(self):
        # 呼び出し側（transcription/session.py）が文字列マッチで判定する文言を含むこと。
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([FakeResponse(200, json_data={"result": "???"})])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(RuntimeError) as ctx:
                await sarashina.transcribe_audio(b"audio-bytes")
        self.assertIn("文字起こし結果がありません", str(ctx.exception))

    async def test_429_falls_back_to_second_key(self):
        self.set_env(SARASHINA_API_KEY="key-a", SARASHINA_API_KEY_2="key-b")
        http = FakeHttp([
            FakeResponse(429, headers={"Retry-After": "120"}),
            FakeResponse(200, json_data={"text": "認識できました"}),
        ])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            text = await sarashina.transcribe_audio(b"audio-bytes")
        self.assertEqual(text, "認識できました")
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-b"])
        self.assertIn("key-a", sarashina._key_cooldown_until)
        self.assertNotIn("key-b", sarashina._key_cooldown_until)

    async def test_non_429_does_not_fall_back(self):
        self.set_env(SARASHINA_API_KEY="key-a", SARASHINA_API_KEY_2="key-b")
        http = FakeHttp([FakeResponse(403)])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(sarashina.SarashinaHTTPError) as ctx:
                await sarashina.transcribe_audio(b"audio-bytes")
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(len(http.requests), 1)

    async def test_all_keys_429_raises_last_429(self):
        self.set_env(SARASHINA_API_KEY="key-a", SARASHINA_API_KEY_5="key-e")
        http = FakeHttp([FakeResponse(429), FakeResponse(429)])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(sarashina.SarashinaHTTPError) as ctx:
                await sarashina.transcribe_audio(b"audio-bytes")
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-e"])

    async def test_no_key_raises_runtime_error(self):
        http = FakeHttp([])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaisesRegex(RuntimeError, "SARASHINA_API_KEY"):
                await sarashina.transcribe_audio(b"audio-bytes")
        self.assertEqual(http.requests, [])


class SynthesizeTests(SarashinaTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_payload_and_bytes(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([FakeResponse(200, body=b"wav-bytes")])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            audio = await sarashina.synthesize_speech("こんにちは", voice="haruka")
        self.assertEqual(audio, b"wav-bytes")
        req = http.requests[0]
        self.assertEqual(req["url"], "https://api.sarashina.ai/v1/audio/speech")
        self.assertEqual(req["headers"]["Authorization"], "Bearer key-a")
        self.assertEqual(req["json"], {
            "model": "sarashina3.2-tts",
            "input": "こんにちは",
            "voice": "haruka",
            "response_format": "wav",
            "speed": 1.0,
        })

    async def test_speed_is_passed_through(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([FakeResponse(200, body=b"wav")])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            await sarashina.synthesize_speech("テスト", voice="aiku", speed=1.5)
        self.assertEqual(http.requests[0]["json"]["speed"], 1.5)

    async def test_invalid_voice_rejected_before_request(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(ValueError):
                await sarashina.synthesize_speech("テスト", voice="no-such-voice")
        self.assertEqual(http.requests, [])

    async def test_too_long_text_rejected_before_request(self):
        self.set_env(SARASHINA_API_KEY="key-a")
        http = FakeHttp([])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            with self.assertRaises(ValueError):
                await sarashina.synthesize_speech("あ" * 1001, voice="aiku")
        self.assertEqual(http.requests, [])

    async def test_429_falls_back_to_second_key(self):
        self.set_env(SARASHINA_API_KEY="key-a", SARASHINA_API_KEY_10="key-j")
        http = FakeHttp([FakeResponse(429), FakeResponse(200, body=b"wav-bytes")])
        with patch("core.general.ai.sarashina.aiohttp.ClientSession", side_effect=http.client_session):
            audio = await sarashina.synthesize_speech("テスト", voice="aiku")
        self.assertEqual(audio, b"wav-bytes")
        self.assertEqual(http.auths(), ["Bearer key-a", "Bearer key-j"])


class VoiceCatalogTests(unittest.TestCase):
    def test_57_voices_and_default(self):
        self.assertEqual(len(sarashina.VOICES), 57)
        self.assertEqual(len(set(sarashina.VOICES)), 57)
        self.assertEqual(sarashina.DEFAULT_VOICE, "aiku")
        self.assertEqual(sarashina.VOICES[0], sarashina.DEFAULT_VOICE)


if __name__ == "__main__":
    unittest.main()
