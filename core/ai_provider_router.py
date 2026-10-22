"""!ai 用の OpenAI 互換 API プロバイダー切替。DSH は不要。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import os
import re
import time
from typing import Any

import aiohttp

from core import logfare

logger = logging.getLogger(__name__)

AUTO_MODEL = "ai/auto"
TIMEOUT = aiohttp.ClientTimeout(total=45)
COOLDOWN_SECONDS = 60
REQUEST_BUDGET_SECONDS = 90

# OpenAI Chat Completions 互換の公式エンドポイント。その他は環境変数で追加できる。
BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "openrouter": "https://openrouter.ai/api/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "sambanova": "https://api.sambanova.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "mistral": "https://api.mistral.ai/v1",
    "together": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "nvidia_nim": "https://integrate.api.nvidia.com/v1",
    "openai": "https://api.openai.com/v1",
}

_cooldown_until: dict[str, float] = {}


@dataclass(frozen=True)
class Route:
    name: str
    model: str
    base_url: str
    api_key: str


@dataclass(frozen=True)
class Answer:
    text: str
    provider: str
    model: str


def logical_model() -> str:
    return os.getenv("AI_ROUTED_MODEL", "").strip()


def routes() -> list[Route]:
    """順番を明示した、キーとモデルが揃う経路だけを使用する。"""
    order = os.getenv("AI_PROVIDER_ORDER", "")
    result = []
    seen = set()
    for raw_name in order.split(","):
        name = raw_name.strip().lower().replace("-", "_")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name or "") or name in seen:
            continue
        seen.add(name)
        prefix = f"AI_{name.upper()}"
        if name == "logfare":
            key = logfare.api_key() or ""
            model = os.getenv(f"{prefix}_MODEL", "").strip() or logical_model() or logfare.AUTO_MODEL
            base_url = logfare.BASE_URL
        else:
            key = (os.getenv(f"{prefix}_API_KEY", "").strip()
                   or os.getenv(f"{name.upper()}_API_KEY", "").strip())
            model = os.getenv(f"{prefix}_MODEL", "").strip() or logical_model()
            base_url = (os.getenv(f"{prefix}_BASE_URL", "").strip()
                        or BASE_URLS.get(name, ""))
        if key and model and base_url:
            result.append(Route(name, model, base_url.rstrip("/"), key))
    return result


def enabled() -> bool:
    return bool(routes())


def _retry_after(response: aiohttp.ClientResponse) -> float:
    try:
        seconds = float(response.headers.get("Retry-After", COOLDOWN_SECONDS))
    except (TypeError, ValueError):
        seconds = COOLDOWN_SECONDS
    return max(1, min(seconds, 300))


async def _call(route: Route, messages: list[dict[str, str]], max_tokens: int) -> str:
    if route.name == "logfare":
        return await logfare.chat(route.model, messages, max_tokens=max_tokens)
    headers = {"Authorization": f"Bearer {route.api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": route.model, "messages": messages, "max_tokens": max_tokens,
    }
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        async with session.post(
            f"{route.base_url}/chat/completions", headers=headers, json=payload,
        ) as response:
            if response.status >= 400:
                if response.status == 429:
                    _cooldown_until[route.name] = time.monotonic() + _retry_after(response)
                # エラーボディに鍵やプロンプトが混ざる上流があるため記録しない。
                raise RuntimeError(f"HTTP {response.status}")
            data = await response.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("回答本文がありません") from exc
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    text = str(content or "").strip()
    if not text:
        raise RuntimeError("回答本文が空です")
    return text


async def chat(messages: list[dict[str, str]], *, max_tokens: int = 1200) -> Answer:
    configured = routes()
    if not configured:
        raise RuntimeError("利用可能なAIプロバイダーが設定されていません")
    deadline = time.monotonic() + REQUEST_BUDGET_SECONDS
    for route in configured:
        if _cooldown_until.get(route.name, 0) > time.monotonic():
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            text = await asyncio.wait_for(_call(route, messages, max_tokens), remaining)
            return Answer(text, route.name, route.model)
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, ValueError) as exc:
            logger.warning("!ai provider failed: provider=%s error=%s", route.name, type(exc).__name__)
    raise RuntimeError("全AIプロバイダーが応答できませんでした") from None
