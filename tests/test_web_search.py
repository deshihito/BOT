"""core/web_search.py の SSRF 防御（IP/ポート/リダイレクト/サイズ）のテスト。"""

import socket
import unittest
from unittest.mock import patch

from core import web_search


def _dns(*addresses):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 0)) for address in addresses]


_UNSET = object()


class FakeContent:
    def __init__(self, body: bytes):
        self._body = body
        self._offset = 0

    async def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            chunk = self._body[self._offset:]
            self._offset = len(self._body)
            return chunk
        chunk = self._body[self._offset:self._offset + n]
        self._offset += len(chunk)
        return chunk


class ChunkedContent:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, n: int = -1) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


class FakeResponse:
    def __init__(self, *, status=200, headers=None, url="https://example.com/", body=b"", chunks=None, content_length=_UNSET):
        self.status = status
        self.headers = headers or {}
        self.url = url
        if chunks is None:
            self.content = FakeContent(body)
            computed_length = len(body)
        else:
            self.content = ChunkedContent(chunks)
            computed_length = sum(len(chunk) for chunk in chunks)
        self.content_length = computed_length if content_length is _UNSET else content_length

    def get_encoding(self):
        return "utf-8"

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeSession:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requested = []

    def get(self, url, **kwargs):
        self.requested.append((url, kwargs))
        if not self._responses:
            raise AssertionError(f"unexpected request: {url}")
        return self._responses.pop(0)


class UrlValidationTest(unittest.TestCase):
    def test_rejects_private_loopback_link_local_and_unsafe_urls(self):
        cases = [
            ("http://127.0.0.1/", "127.0.0.1"),
            ("http://169.254.169.254/latest/meta-data/", "169.254.169.254"),
            ("http://[::1]/", "::1"),
            ("http://example.com:8080/", "93.184.216.34"),
            ("http://user:pass@example.com/", "93.184.216.34"),
            ("file:///etc/passwd", "93.184.216.34"),
        ]
        for url, address in cases:
            with self.subTest(url=url), patch(
                "core.web_search.socket.getaddrinfo",
                return_value=_dns(address),
            ):
                self.assertFalse(web_search._is_public_url(url))

    def test_allows_public_http_and_https_on_default_ports(self):
        for url in ("http://example.com/", "https://example.com/", "https://example.com:443/"):
            with self.subTest(url=url), patch(
                "core.web_search.socket.getaddrinfo",
                return_value=_dns("93.184.216.34"),
            ):
                self.assertTrue(web_search._is_public_url(url))


class RedirectTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _resolver(host, *_args, **_kwargs):
        if host == "example.com":
            return _dns("93.184.216.34")
        if host == "127.0.0.1":
            return _dns("127.0.0.1")
        raise socket.gaierror

    async def test_redirect_to_private_is_rejected_before_second_request(self):
        session = FakeSession([
            FakeResponse(
                status=302,
                headers={"Location": "http://127.0.0.1/secret"},
                url="https://example.com/",
            ),
        ])
        with patch("core.web_search.socket.getaddrinfo", side_effect=self._resolver):
            with self.assertRaises(web_search.WebSearchError):
                await web_search._fetch_html(session, "https://example.com/")
        self.assertEqual(len(session.requested), 1)
        self.assertEqual(session.requested[0][0], "https://example.com/")

    async def test_public_relative_redirect_is_followed(self):
        session = FakeSession([
            FakeResponse(
                status=302,
                headers={"Location": "/next"},
                url="https://example.com/",
            ),
            FakeResponse(
                status=200,
                headers={"Content-Type": "text/html; charset=utf-8"},
                url="https://example.com/next",
                body=b"<html><body>ok</body></html>",
            ),
        ])
        with patch("core.web_search.socket.getaddrinfo", side_effect=self._resolver):
            final_url, html = await web_search._fetch_html(session, "https://example.com/")
        self.assertEqual(final_url, "https://example.com/next")
        self.assertIn("ok", html)
        self.assertEqual(len(session.requested), 2)
        self.assertEqual(session.requested[0][0], "https://example.com/")
        self.assertEqual(session.requested[1][0], "https://example.com/next")

    async def test_oversized_body_is_rejected(self):
        session = FakeSession([
            FakeResponse(
                status=200,
                headers={"Content-Type": "text/html"},
                url="https://example.com/",
                body=b"x" * (web_search.MAX_BODY_BYTES + 1),
                content_length=web_search.MAX_BODY_BYTES + 1,
            ),
        ])
        with patch("core.web_search.socket.getaddrinfo", side_effect=self._resolver):
            with self.assertRaises(web_search.WebSearchError):
                await web_search._fetch_html(session, "https://example.com/")
    async def test_partial_chunks_are_read_to_eof(self):
        session = FakeSession([
            FakeResponse(
                status=200,
                headers={"Content-Type": "text/html"},
                url="https://example.com/",
                chunks=[b"<html>", b"<body>ok", b"</body></html>"],
                content_length=None,
            ),
        ])
        with patch("core.web_search.socket.getaddrinfo", side_effect=self._resolver):
            final_url, html = await web_search._fetch_html(session, "https://example.com/")
        self.assertEqual(final_url, "https://example.com/")
        self.assertEqual(html, "<html><body>ok</body></html>")

    async def test_streaming_body_limit_is_enforced(self):
        half = web_search.MAX_BODY_BYTES // 2 + 1
        session = FakeSession([
            FakeResponse(
                status=200,
                headers={"Content-Type": "text/html"},
                url="https://example.com/",
                chunks=[b"x" * half, b"x" * half],
                content_length=None,
            ),
        ])
        with patch("core.web_search.socket.getaddrinfo", side_effect=self._resolver):
            with self.assertRaises(web_search.WebSearchError):
                await web_search._fetch_html(session, "https://example.com/")


class PublicResolverTest(unittest.IsolatedAsyncioTestCase):
    class Resolver:
        def __init__(self, records):
            self.records = records

        async def resolve(self, host, port, family):
            return self.records

        def close(self):
            pass

    async def test_rejects_private_ip_from_actual_connector_resolution(self):
        resolver = web_search.PublicResolver()
        resolver._resolver = self.Resolver([{"host": "127.0.0.1", "port": 80}])
        with self.assertRaises(OSError):
            await resolver.resolve("attacker.example", 80, socket.AF_INET)
        resolver.close()

    async def test_accepts_public_ip_from_actual_connector_resolution(self):
        resolver = web_search.PublicResolver()
        records = [{"host": "93.184.216.34", "port": 80}]
        resolver._resolver = self.Resolver(records)
        self.assertEqual(await resolver.resolve("example.com", 80, socket.AF_INET), records)
        resolver.close()


class ResultUrlTest(unittest.TestCase):
    def test_unwraps_bing_base64_destination(self):
        import base64
        destination = "https://claude.com/"
        encoded = "a1" + base64.urlsafe_b64encode(destination.encode()).decode().rstrip("=")
        href = "https://www.bing.com/ck/a?u=" + encoded
        self.assertEqual(web_search._unwrap_result_url(href, "https://www.bing.com/search?q=claude"), destination)

    def test_keeps_non_bing_tracking_url_when_destination_is_invalid(self):
        href = "https://www.bing.com/ck/a?u=a1not-valid"
        self.assertEqual(web_search._unwrap_result_url(href, "https://www.bing.com/search?q=test"), href)
