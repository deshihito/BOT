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
    "apinex": "https://api.apinex.bond/v1",
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


class ProviderHTTPError(RuntimeError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(f"HTTP {status}")


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


async def fetch_kiosapi_models() -> list[dict[str, Any]]:
    """KiosAPIキーで利用可能なチャットモデルを取得する。"""
    key = (os.getenv("AI_KIOSAPI_API_KEY", "").strip()
           or os.getenv("KIOSAPI_API_KEY", "").strip())
    if not key:
        return []
    base_url = os.getenv("AI_KIOSAPI_BASE_URL", "https://kiosapi.com/v1").strip().rstrip("/")
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        async with session.get(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        ) as response:
            response.raise_for_status()
            payload = await response.json()
    return sorted(
        (model for model in payload.get("data", [])
         if isinstance(model, dict) and isinstance(model.get("id"), str) and model["id"].strip()),
        key=lambda model: model["id"].lower(),
    )


async def fetch_apinex_free_models() -> list[dict[str, Any]]:
    """APInexの認証済みカタログからFreeカテゴリだけを返す。"""
    key = (os.getenv("AI_APINEX_API_KEY", "").strip()
           or os.getenv("APINEX_API_KEY", "").strip())
    if not key:
        return []
    base_url = os.getenv("AI_APINEX_BASE_URL", "https://api.apinex.bond/v1").strip().rstrip("/")
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        async with session.get(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        ) as response:
            response.raise_for_status()
            payload = await response.json()
    return sorted(
        (model for model in payload.get("data", [])
         if isinstance(model, dict) and isinstance(model.get("id"), str)
         and model["id"].startswith("free/") and model["id"].strip()),
        key=lambda model: model["id"].lower(),
    )


def supported_reasoning_efforts(provider: str, model: str) -> list[str]:
    """APIとモデルで明示的に対応する場合だけ思考強度を返す。"""
    if provider.lower() != "apinex":
        return []
    model_id = model.lower().removeprefix("free/")
    supported_families = ("deepseek-", "deepseek/", "gemini-", "gemini/", "claude-",
                          "claude/", "gpt-", "gpt/", "glm-", "glm/", "grok-")
    if model_id.startswith(supported_families):
        return ["low", "medium", "high"]
    return []


async def chat_with_model(provider: str, model: str, messages: list[dict[str, str]], *,
                          max_tokens: int = 1200, reasoning_effort: str | None = None) -> Answer:
    """特定プロバイダーの指定モデルをフォールバックなしで呼び出す。"""
    name = provider.strip().lower().replace("-", "_")
    prefix = f"AI_{name.upper()}"
    key = (os.getenv(f"{prefix}_API_KEY", "").strip()
           or os.getenv(f"{name.upper()}_API_KEY", "").strip())
    base_url = (os.getenv(f"{prefix}_BASE_URL", "").strip()
                or BASE_URLS.get(name, "https://kiosapi.com/v1" if name == "kiosapi" else ""))
    if not key or not base_url or not model:
        raise RuntimeError("指定プロバイダーの設定がありません")
    if reasoning_effort not in supported_reasoning_efforts(name, model):
        reasoning_effort = None
    route = Route(name, model, base_url.rstrip("/"), key)
    text = await _call(route, messages, max_tokens, reasoning_effort=reasoning_effort)
    return Answer(text, name, model)


def _retry_after(value: str | None) -> float:
    try:
        seconds = float(value) if value is not None else COOLDOWN_SECONDS
    except (TypeError, ValueError):
        seconds = COOLDOWN_SECONDS
    return max(1, min(seconds, 300))


async def _call(route: Route, messages: list[dict[str, str]], max_tokens: int,
                *, reasoning_effort: str | None = None) -> str:
    if route.name == "logfare":
        try:
            return await logfare.chat(route.model, messages, max_tokens=max_tokens)
        except logfare.LogfareHTTPError as exc:
            if exc.status == 429:
                _cooldown_until[route.name] = time.monotonic() + _retry_after(exc.retry_after)
            raise
    headers = {"Authorization": f"Bearer {route.api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": route.model, "messages": messages, "max_tokens": max_tokens,
    }
    if reasoning_effort and reasoning_effort in {"low", "medium", "high"}:
        payload["reasoning_effort"] = reasoning_effort
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        async with session.post(
            f"{route.base_url}/chat/completions", headers=headers, json=payload,
        ) as response:
            if response.status >= 400:
                if response.status == 429:
                    _cooldown_until[route.name] = time.monotonic() + _retry_after(response.headers.get("Retry-After"))
                # エラーボディに鍵やプロンプトが混ざる上流があるため記録しない。
                raise ProviderHTTPError(response.status)
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
            logger.warning("!ai provider failed: provider=%s status=%s error=%s",
                           route.name, getattr(exc, "status", "-"), type(exc).__name__)
    raise RuntimeError("全AIプロバイダーが応答できませんでした") from None
