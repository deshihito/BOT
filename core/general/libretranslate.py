"""Small async client for a self-hosted LibreTranslate instance."""
from __future__ import annotations

import os
from typing import Any

import aiohttp


class LibreTranslateError(RuntimeError):
    """Raised when LibreTranslate cannot translate a request."""


class LibreTranslateClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 30.0):
        self.base_url = (base_url or os.getenv("LIBRETRANSLATE_URL", "http://127.0.0.1:18080")).rstrip("/")
        self.api_key = api_key if api_key is not None else os.getenv("LIBRETRANSLATE_API_KEY", "")
        self.timeout = aiohttp.ClientTimeout(total=timeout)

    async def translate(self, text: str, *, source: str = "ja", target: str = "en",
                        fmt: str = "text") -> str:
        payload: dict[str, Any] = {
            "q": text,
            "source": source,
            "target": target,
            "format": fmt,
        }
        if self.api_key:
            payload["api_key"] = self.api_key
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as session:
                async with session.post(f"{self.base_url}/translate", json=payload) as response:
                    data = await response.json(content_type=None)
                    if response.status >= 400:
                        raise LibreTranslateError(
                            f"LibreTranslate returned HTTP {response.status}: {data}"
                        )
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise LibreTranslateError(f"Could not reach LibreTranslate at {self.base_url}") from exc
        translated = data.get("translatedText") if isinstance(data, dict) else None
        if not isinstance(translated, str):
            raise LibreTranslateError(f"LibreTranslate returned an invalid response: {data}")
        return translated

    async def health(self) -> bool:
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as session:
                async with session.get(f"{self.base_url}/languages") as response:
                    return response.status < 400
        except (aiohttp.ClientError, TimeoutError):
            return False
