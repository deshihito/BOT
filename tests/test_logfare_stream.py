import os
import unittest
from unittest.mock import patch

from core import logfare


class FakeLines:
    def __init__(self, lines):
        self.lines = lines

    def __aiter__(self):
        async def iterate():
            for line in self.lines:
                yield line
        return iterate()


class FakeResponse:
    def __init__(self, lines):
        self.status = 200
        self.headers = {}
        self.content = FakeLines(lines)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    def post(self, url, *, headers, json):
        self.request = {"url": url, "headers": headers, "json": json}
        return self.response


class LogfareStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_stream_yields_sse_text_and_sets_stream_payload(self):
        events = [
            'data: {"choices":[{"delta":{"content":"雨が"}}]}\n'.encode(),
            'data: {"choices":[{"delta":{"content":[{"type":"text","text":"降ってきました。"}]}}]}\n'.encode(),
            b'data: [DONE]\n',
        ]
        session = FakeSession(FakeResponse(events))
        with patch.dict(os.environ, {"LOGFARE_API_KEY": "test-key"}), patch(
            "core.logfare.aiohttp.ClientSession", return_value=session
        ):
            result = [
                text async for text in logfare.chat_stream(
                    "gemma-4-26b", [{"role": "user", "content": "天気は？"}], max_tokens=2400
                )
            ]

        self.assertEqual(result, ["雨が", "降ってきました。"])
        self.assertEqual(session.request["url"], f"{logfare.BASE_URL}/chat/completions")
        self.assertTrue(session.request["json"]["stream"])
        self.assertEqual(session.request["json"]["model"], "gemma-4-26b")
        self.assertEqual(session.request["json"]["max_tokens"], 2400)


if __name__ == "__main__":
    unittest.main()
