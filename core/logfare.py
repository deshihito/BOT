"""Logfare の OpenAI 互換 API クライアント。"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from typing import Any

import aiohttp

BASE_URL = os.getenv("LOGFARE_BASE_URL", "https://logfare.ai/v1").rstrip("/")
DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_IMAGE_MODEL = "flux-2-dev"
AUTO_MODEL = "logfare/auto"
# nova-3 は日本語音声を認識できず空の結果を返したため（!sttdebug で検証）、日本語に強い Whisper を既定にする。
# 環境変数 LOGFARE_TRANSCRIPTION_MODEL で変更できる。
DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo"
TRANSCRIPTION_MODEL = os.getenv("LOGFARE_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL).strip() or DEFAULT_TRANSCRIPTION_MODEL
# 認識する言語。Whisper は "ja" のような2文字コードのみ受け付ける（"ja-JP" は 400 になる）。
# 空文字にすると言語指定なしで送る（Whisper は自動判定する）。
TRANSCRIPTION_LANGUAGE = os.getenv("LOGFARE_TRANSCRIPTION_LANGUAGE", "ja").strip()


def _json_env(name: str) -> dict[str, str]:
    """環境変数に入れた JSON オブジェクト（例: {"detect_language": "true"}）を {str: str} で返す。"""
    raw = os.getenv(name, "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        logging.getLogger(__name__).warning("%s が JSON として読めないので無視します", name)
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v).lower() if isinstance(v, bool) else str(v) for k, v in data.items()}


# Logfare が language を取り込まないときの調整用。フォーム項目 / クエリ文字列を追加で送れる。
TRANSCRIPTION_EXTRA_FIELDS = _json_env("LOGFARE_TRANSCRIPTION_EXTRA_FIELDS")
TRANSCRIPTION_EXTRA_QUERY = _json_env("LOGFARE_TRANSCRIPTION_EXTRA_QUERY")
DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=45)

logger = logging.getLogger(__name__)


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


def _extract_transcript(result: Any) -> str | None:
    """応答から認識テキストを取り出す。OpenAI互換 {"text": ...} が基本で、Deepgram系（{"result": {"results": {"channels": ...}}} の包み形式を含む）も拾う。

    認識結果が空 (text が null など) の場合は "" を返し、どの形にも当てはまらないときだけ None。
    """
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        return None
    for key in ("text", "transcript"):
        if key in result:
            value = result[key]
            return value if isinstance(value, str) else ""
    # {"result": {...}, "success": true, ...} のように包まれて返る場合は、中身を読む
    inner = result.get("result")
    if isinstance(inner, (dict, str)):
        return _extract_transcript(inner)
    try:
        value = result["results"]["channels"][0]["alternatives"][0].get("transcript")
        return value if isinstance(value, str) else ""
    except (KeyError, IndexError, TypeError, AttributeError):
        pass
    segments = result.get("segments")
    if isinstance(segments, list):
        return "".join(
            seg.get("text", "") for seg in segments
            if isinstance(seg, dict) and isinstance(seg.get("text"), str)
        )
    return None


def _transcription_form(audio: bytes, filename: str, language: str, extra: dict[str, str]) -> aiohttp.FormData:
    form = aiohttp.FormData()
    form.add_field("model", TRANSCRIPTION_MODEL)
    if language:
        form.add_field("language", language)
    for name, value in extra.items():
        if name not in ("model", "file"):
            form.add_field(name, value)
    form.add_field("response_format", "json")
    form.add_field("file", audio, filename=filename, content_type="audio/wav")
    return form


async def transcribe_audio(audio: bytes, *, filename: str = "voice.wav") -> str:
    """Logfare の音声認識 endpoint を呼び、認識テキストを返す。

    追加フォーム項目が 400/422 で拒否された場合だけ、言語指定を維持して再送する。
    日本語の文字起こしで言語指定まで外すと、Whisperの自動判定で英語が混ざるため。
    """
    key = api_key()
    if not key:
        raise RuntimeError("LOGFARE_API_KEY が設定されていません。")
    headers = {"Authorization": f"Bearer {key}"}
    timeout = aiohttp.ClientTimeout(total=90)
    # (language, 追加フォーム項目, 追加クエリ)。追加項目だけを外して再送する。
    fallback = (TRANSCRIPTION_LANGUAGE, {}, {})
    attempts: list[tuple[str, dict[str, str], dict[str, str]]] = [fallback]
    configured = (TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_EXTRA_FIELDS, TRANSCRIPTION_EXTRA_QUERY)
    if configured != fallback:
        attempts.insert(0, configured)
    raw = ""
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for index, (language, extra_fields, extra_query) in enumerate(attempts):
            form = _transcription_form(audio, filename, language, extra_fields)
            async with session.post(
                f"{BASE_URL}/audio/transcriptions",
                headers=headers,
                data=form,
                params=extra_query or None,
            ) as response:
                if response.status >= 400:
                    if index < len(attempts) - 1 and response.status in (400, 422):
                        logger.warning(
                            "Logfare が追加パラメータ (language=%s, fields=%s, query=%s) を受け付けませんでした "
                            "(HTTP %s)。指定なしで再送します",
                            language, extra_fields, extra_query, response.status,
                        )
                        continue
                    raise LogfareHTTPError(response.status, response.headers.get("Retry-After"))
                raw = await response.text()
            break
    try:
        result: Any = json.loads(raw)
    except ValueError:
        result = raw  # プレーンテキストで返ってきた場合
    text = _extract_transcript(result)
    if text is None:
        logger.warning("Logfare 音声認識の応答に text がありません。応答の先頭: %s", raw[:500])
        raise RuntimeError("Logfare 音声認識 API の応答に文字起こし結果がありませんでした。")
    return text.strip()


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


# ============================================================
# 動作確認用: どの指定なら日本語として認識されるかを調べる
#   python -m core.logfare 日本語を話したWAV.wav     (BOT のフォルダで実行)
#   LOGFARE_API_KEY が必要。Discord からは cogs/sio_transcription.py の !sttdebug でも呼べる。
# ============================================================
_PROBE_PATTERNS: list[tuple[str, dict[str, str], dict[str, str]]] = [
    ("指定なし", {}, {}),
    ("form language=ja", {"language": "ja"}, {}),
    ("form language=ja-JP", {"language": "ja-JP"}, {}),
    ("form detect_language=true", {"detect_language": "true"}, {}),
    ("form language=ja + detect_language=true", {"language": "ja", "detect_language": "true"}, {}),
    ("query ?language=ja", {}, {"language": "ja"}),
    ("query ?language=ja-JP", {}, {"language": "ja-JP"}),
    ("query ?detect_language=true", {}, {"detect_language": "true"}),
]


async def fetch_transcription_models() -> list[str]:
    """Logfare の公開カタログから、音声認識に使えそうなモデルIDを返す。

    endpoints に audio/transcriptions があるものを優先し、無ければ名前から推測した候補を返す。
    """
    async with aiohttp.ClientSession(timeout=DEFAULT_TIMEOUT) as session:
        async with session.get(f"{BASE_URL}/models") as response:
            response.raise_for_status()
            payload = await response.json()
    models = [m for m in payload.get("data", []) if isinstance(m, dict) and isinstance(m.get("id"), str)]
    exact = [m["id"] for m in models if "audio/transcriptions" in (m.get("endpoints") or [])]
    if exact:
        return sorted(exact)
    hints = ("whisper", "nova", "transcri", "stt", "speech", "parakeet", "scribe")
    return sorted(m["id"] for m in models if any(h in m["id"].lower() for h in hints))


async def probe_transcription_languages(audio: bytes, model: str | None = None) -> list[tuple[str, str]]:
    """同じ音声を複数の言語指定で送り、[(パターン名, 認識結果またはエラー内容)] を返す。

    model を省略すると TRANSCRIPTION_MODEL を使う。
    """
    model = (model or TRANSCRIPTION_MODEL).strip()
    key = api_key()
    if not key:
        raise RuntimeError("LOGFARE_API_KEY が設定されていません。")
    results: list[tuple[str, str]] = []
    timeout = aiohttp.ClientTimeout(total=90)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for label, fields, query in _PROBE_PATTERNS:
            form = aiohttp.FormData()
            form.add_field("model", model)
            for name, value in fields.items():
                form.add_field(name, value)
            form.add_field("response_format", "json")
            form.add_field("file", audio, filename="voice.wav", content_type="audio/wav")
            try:
                async with session.post(
                    f"{BASE_URL}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {key}"},
                    data=form,
                    params=query or None,
                ) as response:
                    raw = await response.text()
                    status = response.status
            except Exception as exc:  # noqa: BLE001
                results.append((label, f"通信エラー: {exc!r}"))
                continue
            if status >= 400:
                results.append((label, f"HTTP {status}: {raw[:150]}"))
                continue
            try:
                text = _extract_transcript(json.loads(raw))
            except ValueError:
                text = raw
            results.append((label, repr(text) if text else f"(空) 応答: {raw[:200]}"))
            await asyncio.sleep(0.5)
    return results


async def probe_transcription(path: str) -> None:
    """WAVファイルを probe_transcription_languages に通して、結果を表示する（CLI用）。"""
    with open(path, "rb") as f:
        audio = f.read()
    print(f"音声: {path} ({len(audio)} bytes) / モデル: {TRANSCRIPTION_MODEL} / {BASE_URL}\n")
    for label, outcome in await probe_transcription_languages(audio):
        print(f"[{label}] -> {outcome}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("使い方: python -m core.logfare 日本語を話したWAV.wav")
    try:
        asyncio.run(probe_transcription(sys.argv[1]))
    except RuntimeError as exc:
        raise SystemExit(str(exc))
