"""Logfare の OpenAI 互換 API クライアント。"""
from __future__ import annotations

import asyncio
import base64
import os
from typing import Any

import aiohttp

BASE_URL = os.getenv("LOGFARE_BASE_URL", "https://logfare.ai/v1").rstrip("/")
DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_IMAGE_MODEL = "flux-2-dev"
AUTO_MODEL = "logfare/auto"
DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=45)


class LogfareHTTPError(RuntimeError):
    def __init__(self, status: int, retry_after: str | None = None):
        self.status = status
        self.retry_after = retry_after
        super().__init__(f"Logfare API error {status}")


def api_key() -> str | None:
    return os.getenv("LOGFARE_API_KEY")


def configured_default_model() -> str:
    return os.getenv("LOGFARE_DEFAULT_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


def _is_chat_model(model: dict[str, Any]) -> bool:
    endpoints = model.get("endpoints") or []
    return (
        "chat/completions" in endpoints
        and isinstance(model.get("id"), str)
        and bool(model["id"].strip())
    )


def reasoning_efforts(model: dict[str, Any]) -> list[str]:
    """モデルが明示的に公開している思考強度だけを返す。"""
    reasoning = (model.get("chat_capabilities") or {}).get("reasoning")
    efforts = reasoning.get("supported_efforts") if isinstance(reasoning, dict) else None
    if not isinstance(efforts, list):
        return []
    return [effort for effort in efforts if isinstance(effort, str) and effort.strip()]


async def fetch_free_chat_models() -> list[dict[str, Any]]:
    """Logfare の公開カタログから、free利用枠のチャットモデルを返す。

    Premium表示のモデルも料金は無料だが、``requires_training_optin`` が
    true の場合はLogfare側でトレーニング利用への同意が必要になる。
    """
    async with aiohttp.ClientSession(timeout=DEFAULT_TIMEOUT) as session:
        async with session.get(f"{BASE_URL}/models") as response:
            response.raise_for_status()
            payload = await response.json()
    models = [model for model in payload.get("data", []) if _is_chat_model(model)]
    return sorted(models, key=lambda model: (model["id"] != AUTO_MODEL, model["id"]))


async def fetch_image_models() -> list[dict[str, Any]]:
    """画像生成に対応するLogfareモデルを公開カタログから返す。"""
    async with aiohttp.ClientSession(timeout=DEFAULT_TIMEOUT) as session:
        async with session.get(f"{BASE_URL}/models") as response:
            response.raise_for_status()
            payload = await response.json()
    models = [
        model for model in payload.get("data", [])
        if "images/generations" in (model.get("endpoints") or [])
        and isinstance(model.get("id"), str)
        and model["id"].strip()
    ]
    return sorted(models, key=lambda model: (model["id"] != DEFAULT_IMAGE_MODEL, model["id"]))


async def resolve_image_model(preferred: str | None = None) -> tuple[str, bool]:
    requested = (preferred or os.getenv("LOGFARE_DEFAULT_IMAGE_MODEL", DEFAULT_IMAGE_MODEL)).strip()
    requested = requested or DEFAULT_IMAGE_MODEL
    try:
        model_ids = {item["id"] for item in await fetch_image_models()}
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError):
        return requested, False
    if requested in model_ids:
        return requested, True
    return DEFAULT_IMAGE_MODEL, False


async def resolve_model(preferred: str | None = None) -> tuple[str, bool]:
    """指定モデルを使えるか確認し、使えなければ auto にフォールバックする。"""
    requested = (preferred or configured_default_model()).strip() or AUTO_MODEL
    try:
        model_ids = {item["id"] for item in await fetch_free_chat_models()}
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError):
        # カタログが一時的に取得できなくても、auto は Logfare 側で解決できる。
        return requested, False
    if requested in model_ids:
        return requested, True
    return AUTO_MODEL, False


async def chat(
    model: str,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1200,
    reasoning_effort: str | None = None,
) -> str:
    """Chat Completions を実行し、回答本文だけを返す。"""
    data = await chat_completion(
        model,
        messages,
        max_tokens=max_tokens,
        reasoning_effort=reasoning_effort,
    )
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Logfare API の応答に回答本文がありませんでした。") from exc
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return str(content or "").strip()


async def chat_completion(
    model: str,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1200,
    reasoning_effort: str | None = None,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Chat CompletionsのJSON全体を返す（ツール呼び出し用）。"""
    key = api_key()
    if not key:
        raise RuntimeError("LOGFARE_API_KEY が設定されていません。")
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    async with aiohttp.ClientSession(timeout=DEFAULT_TIMEOUT) as session:
        async with session.post(f"{BASE_URL}/chat/completions", headers=headers, json=payload) as response:
            if response.status >= 400:
                raise LogfareHTTPError(response.status, response.headers.get("Retry-After"))
            try:
                data = await response.json()
            except ValueError as exc:
                raise RuntimeError("Logfare API の応答をJSONとして解釈できませんでした。") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Logfare APIの応答形式が不正です。")
    return data


async def decision(
    model: str,
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, Any],
    *,
    timeout: aiohttp.ClientTimeout | None = None,
) -> dict[str, Any]:
    """Logfare decision-model endpointへSystem One形式の判断を送る。"""
    key = api_key()
    if not key:
        raise RuntimeError("LOGFARE_API_KEY が設定されていません。")
    payload = {"model": model, "state": state, "questions": questions}
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    async with aiohttp.ClientSession(timeout=timeout or DEFAULT_TIMEOUT) as session:
        async with session.post(f"{BASE_URL}/decisions", headers=headers, json=payload) as response:
            if response.status >= 400:
                raise LogfareHTTPError(response.status, response.headers.get("Retry-After"))
            try:
                data = await response.json()
            except ValueError as exc:
                raise RuntimeError("Logfare decision API の応答をJSONとして解釈できませんでした。") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Logfare decision APIの応答形式が不正です。")
    return data


async def generate_image(model: str, prompt: str, *, size: str = "1024x1024") -> bytes:
    """画像生成結果をPNG/JPEG等のバイト列として返す。"""
    key = api_key()
    if not key:
        raise RuntimeError("LOGFARE_API_KEY が設定されていません。")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {"model": model, "prompt": prompt, "size": size, "n": 1}
    async with aiohttp.ClientSession(timeout=DEFAULT_TIMEOUT) as session:
        async with session.post(f"{BASE_URL}/images/generations", headers=headers, json=payload) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"Logfare image API error {response.status}: {body[:300]}")
            try:
                data = await response.json()
            except ValueError as exc:
                raise RuntimeError("Logfare画像APIの応答をJSONとして解釈できませんでした。") from exc

        try:
            item = data["data"][0]
            if item.get("b64_json"):
                return base64.b64decode(item["b64_json"])
            image_url = item["url"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Logfare画像APIの応答に画像データがありませんでした。") from exc

        async with session.get(image_url) as image_response:
            image_response.raise_for_status()
            return await image_response.read()
