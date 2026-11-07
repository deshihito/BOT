"""DuckDuckGo検索とHTML本文抽出を行う読み取り専用Web検索。"""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

import aiohttp
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver
from bs4 import BeautifulSoup

USER_AGENT = "AGOBOT/1.0 (+https://logfare.ai/docs; web-search)"
TIMEOUT = aiohttp.ClientTimeout(total=15)
MAX_QUERY_LENGTH = 300
MAX_PAGE_CHARS = 7000
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 2_000_000
BODY_CHUNK_SIZE = 64 * 1024
ALLOWED_PORTS = {None, 80, 443}


class WebSearchError(RuntimeError):
    pass


def _is_public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved)


def _is_public_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    if parsed.username or parsed.password:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    if port not in ALLOWED_PORTS:
        return False
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except (socket.gaierror, UnicodeError):
        return False
    return bool(addresses) and all(_is_public_ip(address) for address in addresses)


class PublicResolver(AbstractResolver):
    """実際のaiohttp接続で使うDNS結果も公開IPだけに固定する。"""

    def __init__(self):
        self._resolver = DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        records = await self._resolver.resolve(host, port, family)
        if not records or any(not _is_public_ip(str(record["host"])) for record in records):
            raise OSError("private or special IP address rejected")
        return records

    def close(self):
        self._resolver.close()


def _safe_session() -> aiohttp.ClientSession:
    connector = aiohttp.TCPConnector(resolver=PublicResolver())
    return aiohttp.ClientSession(timeout=TIMEOUT, connector=connector)


def _unwrap_result_url(href: str, base_url: str) -> str:
    absolute = urljoin(base_url, href)
    parsed = urlparse(absolute)
    query = parse_qs(parsed.query)
    if query.get("uddg"):
        return unquote(query["uddg"][0])
    # Bing HTML results use a tracking URL with the destination in u=a1<base64>.
    # Do not pass the tracking page itself to RAG: it returns only Bing's
    # "click here if the page does not redirect" interstitial to HTTP clients.
    encoded = query.get("u", [""])[0]
    if encoded.startswith("a1"):
        try:
            padded = encoded[2:] + "=" * (-len(encoded[2:]) % 4)
            decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
            if decoded.startswith(("http://", "https://")):
                return decoded
        except (ValueError, UnicodeError):
            pass
    return absolute


async def _fetch_html(session: aiohttp.ClientSession, url: str) -> tuple[str, str]:
    current_url = url
    for _ in range(MAX_REDIRECTS + 1):
        if not _is_public_url(current_url):
            raise WebSearchError("公開HTTP(S) URL以外は取得できません。")
        async with session.get(
            current_url,
            headers={"User-Agent": USER_AGENT},
            allow_redirects=False,
        ) as response:
            if response.status in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location")
                if not location:
                    raise WebSearchError("リダイレクト先がありません。")
                current_url = urljoin(current_url, location)
                continue
            if response.status >= 400:
                raise WebSearchError(f"ページ取得に失敗しました（HTTP {response.status}）。")
            final_url = str(response.url)
            if not _is_public_url(final_url):
                raise WebSearchError("安全でないリダイレクト先を拒否しました。")
            content_type = response.headers.get("Content-Type", "")
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                return final_url, ""
            length = getattr(response, "content_length", None)
            if length is not None and length > MAX_BODY_BYTES:
                raise WebSearchError("ページが大きすぎます。")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = await response.content.read(BODY_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BODY_BYTES:
                    raise WebSearchError("ページが大きすぎます。")
                chunks.append(chunk)
            body = b"".join(chunks)
            try:
                encoding = response.get_encoding() or "utf-8"
            except LookupError:
                encoding = "utf-8"
            return final_url, body.decode(encoding, errors="ignore")
    raise WebSearchError("リダイレクトが多すぎます。")


async def search(query: str, *, max_results: int = 5) -> list[dict[str, str]]:
    query = re.sub(r"\s+", " ", query or "").strip()[:MAX_QUERY_LENGTH]
    if not query:
        raise WebSearchError("検索語が空です。")
    max_results = max(1, min(max_results, 5))
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    async with _safe_session() as session:
        _, html = await _fetch_html(session, url)
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict[str, str]] = []
    for result in soup.select(".result"):
        link = result.select_one("a.result__a")
        if not link or not link.get("href"):
            continue
        result_url = _unwrap_result_url(str(link["href"]), url)
        if not _is_public_url(result_url):
            continue
        snippet = result.select_one(".result__snippet")
        results.append({
            "title": link.get_text(" ", strip=True)[:300],
            "url": result_url,
            "snippet": snippet.get_text(" ", strip=True)[:700] if snippet else "",
        })
        if len(results) >= max_results:
            break
    if results:
        return results

    # DuckDuckGo may return a consent/anti-bot page from some networks.
    bing_url = f"https://www.bing.com/search?q={quote_plus(query)}"
    async with _safe_session() as session:
        _, html = await _fetch_html(session, bing_url)
    soup = BeautifulSoup(html, "html.parser")
    for result in soup.select("li.b_algo"):
        link = result.select_one("h2 a")
        if not link or not link.get("href"):
            continue
        result_url = _unwrap_result_url(str(link["href"]), bing_url)
        if not _is_public_url(result_url):
            continue
        snippet = result.select_one(".b_caption p") or result.select_one("p")
        results.append({
            "title": link.get_text(" ", strip=True)[:300],
            "url": result_url,
            "snippet": snippet.get_text(" ", strip=True)[:700] if snippet else "",
        })
        if len(results) >= max_results:
            break
    return results


def _extract_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = re.sub(r"\s+", " ", main.get_text(" ", strip=True))
    return title[:300], text[:MAX_PAGE_CHARS]


async def retrieve(query: str, *, max_results: int = 3) -> list[dict[str, str]]:
    """検索結果と公開ページ本文を取得し、RAG用の資料として返す。"""
    results = await search(query, max_results=max_results)
    documents: list[dict[str, str]] = []
    async with _safe_session() as session:
        for result in results:
            try:
                final_url, html = await _fetch_html(session, result["url"])
                title, text = _extract_text(html)
                if text:
                    documents.append({
                        "title": title or result["title"],
                        "url": final_url,
                        "snippet": result["snippet"],
                        "content": text,
                    })
            except (aiohttp.ClientError, asyncio.TimeoutError, WebSearchError):
                documents.append(result | {"content": "（本文を取得できませんでした）"})
    return documents


def compact_documents(documents: list[dict[str, str]]) -> str:
    """検索資料をモデルへ渡すためのサイズ制限付きコンテキストにする。"""
    blocks = []
    for index, document in enumerate(documents, 1):
        blocks.append(
            f"[Source {index}] {document.get('title', '')}\n"
            f"URL: {document.get('url', '')}\n"
            f"本文: {document.get('content') or document.get('snippet', '')}"
        )
    return "\n\n".join(blocks)[:18000]
