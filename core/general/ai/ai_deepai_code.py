"""DeepAI Code を限定的なチャット経路として呼び出す。

DeepAI Code は公式の画像/動画 API とは別系統で、デスクトップアプリ向けの
`https://api.deepai.org/deepai_code` エンドポイントを使う。認証は
`Authorization` ではなく `Api-Key` ヘッダで、毎日の無料枠 (Theos) の付与には
マシン指紋ヘッダが必要になる（プロトコル実測: magpie-deepaicode の
PROTOCOL.md、2026-11 時点）。

このモジュールは OmniRush と同じ「独立ルート」方式で、`AI_PROVIDER_ORDER`
の自動切替には組み込まない。モデルは固定リストを持たず、キーが設定されて
いる時だけ上流の目録を動的取得する。
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import secrets
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

BASE_URL = "https://api.deepai.org"
PREFIX = "deepaicode::"
TIMEOUT = aiohttp.ClientTimeout(total=45)
USER_AGENT = "AGO-BOT/deepai-code-route"
MAX_PROMPT_CHARS = 32_000

# 課金レーン版数の探査順。受理された値をプロセス内でキャッシュする。
LANE_CANDIDATES = ("4", "5", "6", "8", "12", "3", "2")

_SYSTEM_FALLBACK = "あなたはDiscord上の親切なアシスタントです。日本語で簡潔かつ正確に回答してください。"

_INSTANCE_ID = secrets.token_hex(16)
_lane_version: str | None = None
_models_cache: list[dict[str, Any]] = []


class DeepAICodeError(RuntimeError):
    """DeepAI Code 呼び出しの安全なエラー（キーや生のマシンIDは含めない）。"""


class DeepAICodeAuthError(DeepAICodeError):
    """APIキーが無効、またはメール未確認などで認証できない。"""


class DeepAICodeBusy(DeepAICodeError):
    """上流が容量不足 (session_busy) で、Retry-After 付きで断った。"""

    def __init__(self, retry_after: float):
        self.retry_after = retry_after
        super().__init__(
            f"DeepAI Codeが混雑しています。{retry_after:.0f}秒ほど待ってから再試行してください。"
        )


def api_key() -> str:
    """`DEEPAI_CODE_API_KEY` を優先し、無ければ `DEEPAI_API_KEY` を使う。"""
    return (os.getenv("DEEPAI_CODE_API_KEY", "").strip()
            or os.getenv("DEEPAI_API_KEY", "").strip())


def _base_url() -> str:
    return os.getenv("DEEPAI_CODE_BASE_URL", BASE_URL).strip().rstrip("/") or BASE_URL


def _raw_machine_id() -> str:
    """Linux のマシンIDを読む。生の値はこの関数の外へ出さない。"""
    for path in ("/sys/class/dmi/id/product_uuid", "/etc/machine-id"):
        try:
            value = Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    return ""


def machine_fingerprint() -> str:
    """日次 Theos 付与の鍵。sha256(小文字化・空白除去した生ID) の hex。

    生のマシンIDそのものは送信もログ出力もしない。
    """
    raw = "".join(_raw_machine_id().split()).lower()
    if not raw:
        return ""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_headers(*, lane: str | None = None) -> dict[str, str]:
    """DeepAI Code の必須ヘッダを組み立てる。"""
    headers = {
        "Api-Key": api_key(),
        "User-Agent": USER_AGENT,
        "X-DeepAI-Code-Instance": _INSTANCE_ID,
    }
    fingerprint = machine_fingerprint()
    if fingerprint:
        headers["X-DeepAI-Code-Machine"] = fingerprint
    if lane:
        headers["X-DeepAI-Code-Theos"] = lane
    return headers


def ensure_system_message(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """先頭が system/developer でない場合だけ最小の system を補う。

    既存のメッセージは一切改変しない（上流は先頭ロールの欠落を
    `400 "This request is not one DeepAI Code sends."` で弾く）。
    """
    if messages and str(messages[0].get("role", "")).lower() in {"system", "developer"}:
        return messages
    return [{"role": "system", "content": _SYSTEM_FALLBACK}, *messages]


def _retry_after(value: str | None) -> float:
    try:
        seconds = float(value) if value is not None else 30.0
    except (TypeError, ValueError):
        seconds = 30.0
    return max(1.0, min(seconds, 30.0))


async def _request(session: aiohttp.ClientSession, method: str, path: str, *,
                   lane: str | None, **kwargs) -> tuple[int, Any, dict[str, str]]:
    """リダイレクトを追わずに1回だけ叩き、(status, json|None, headers) を返す。"""
    async with session.request(
        method, f"{_base_url()}{path}",
        headers=build_headers(lane=lane), allow_redirects=False, **kwargs,
    ) as response:
        payload = None
        if response.content_type and "json" in response.content_type:
            try:
                payload = await response.json()
            except ValueError:
                payload = None
        else:
            # エラー本文にキー等が混ざる場合があるため、本文は読み捨てて記録しない。
            await response.read()
        return response.status, payload, dict(response.headers)


def _raise_for_status(status: int, payload: Any, headers: dict[str, str]) -> None:
    """上流ステータスを安全な例外へ変換する。レーン 426 は呼び出し側で扱う。"""
    if status in (301, 302, 303, 307, 308):
        # 無効キーは 302 でログイン画面へ飛ぶ（リダイレクトは追従しない）。
        raise DeepAICodeAuthError(
            "DeepAI Codeの認証に失敗しました。Pi の `.env` の `DEEPAI_API_KEY` を確認してください。"
        )
    if status < 400:
        return
    if status in (401, 404):
        # 無効キーは 302 でログイン画面へ飛ぶ。404 はキーが通らない経路で
        # 返ることがあるため、どちらも認証エラーとして扱う。
        raise DeepAICodeAuthError(
            "DeepAI Codeの認証に失敗しました。Pi の `.env` の `DEEPAI_API_KEY` を確認してください。"
        )
    if status == 409:
        raise DeepAICodeBusy(_retry_after(headers.get("Retry-After")))
    if status == 403:
        detail = ""
        if isinstance(payload, dict):
            detail = str(payload.get("error") or payload.get("detail") or "")
        if "email_unverified" in detail:
            raise DeepAICodeAuthError(
                "DeepAIアカウントのメール確認が完了していません。確認メールのリンクを開いてください。"
            )
        raise DeepAICodeAuthError("DeepAI Codeへのアクセスが拒否されました（403）。")
    raise DeepAICodeError(f"DeepAI Codeがエラーを返しました (HTTP {status})")


async def _resolve_lane(session: aiohttp.ClientSession) -> str:
    """/models を候補順に探査し、受理されたレーン版数をキャッシュする。"""
    global _lane_version
    if _lane_version:
        return _lane_version
    for candidate in LANE_CANDIDATES:
        status, _payload, _headers = await _request(
            session, "GET", "/deepai_code/models", lane=candidate
        )
        if status == 426:
            continue
        _raise_for_status(status, _payload, _headers)
        _lane_version = candidate
        return candidate
    raise DeepAICodeError("DeepAI Codeの課金レーン版数を特定できませんでした。")


async def _models_with_lane(session: aiohttp.ClientSession) -> tuple[str, list[dict[str, Any]]]:
    """キャッシュ済みレーンで目録を取り、426 なら再探査して1回だけ取り直す。"""
    global _lane_version
    lane = await _resolve_lane(session)
    status, payload, headers = await _request(session, "GET", "/deepai_code/models", lane=lane)
    if status == 426:
        _lane_version = None
        lane = await _resolve_lane(session)
        status, payload, headers = await _request(session, "GET", "/deepai_code/models", lane=lane)
    _raise_for_status(status, payload, headers)
    return lane, _parse_models(payload)


def _parse_models(payload: Any) -> list[dict[str, Any]]:
    """目録を正規化する。Responses 専用モデルは初版では除外する。"""
    if isinstance(payload, dict):
        raw = payload.get("data", payload.get("models", []))
    elif isinstance(payload, list):
        raw = payload
    else:
        raw = []
    models = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        if str(item.get("api") or "").strip().lower() == "openai-responses":
            continue
        inputs = item.get("input") or []
        models.append({
            **item,
            "id": model_id,
            "name": str(item.get("name") or model_id),
            "supports_images": any(
                str(value).lower() in {"image", "images", "vision"} for value in inputs
            ) if isinstance(inputs, (list, tuple, set)) else False,
            "free": str(item.get("theosPerRequest")) == "0",
        })
    return sorted(models, key=lambda model: model["id"].lower())


async def fetch_models() -> list[dict[str, Any]]:
    """キーで利用可能なチャットモデルを取得する。キー未設定・失敗時は空。"""
    global _models_cache
    if not api_key():
        return []
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
            _lane, models = await _models_with_lane(session)
    except DeepAICodeError:
        raise
    except Exception:
        logger.warning("DeepAI Code: モデル一覧の取得に失敗しました", exc_info=True)
        return []
    _models_cache = models
    return models


async def model_choices() -> list[dict[str, str]]:
    """モデル選択 UI 用の選択肢。キーが無い、または取得できない場合は空。"""
    if not api_key():
        return []
    try:
        models = await fetch_models()
    except DeepAICodeError:
        logger.warning("DeepAI Code: モデル一覧の取得に失敗しました（認証）", exc_info=True)
        return []
    return [
        {"id": f"{PREFIX}{model['id']}", "name": f"DeepAI Code · {model['name']}"}
        for model in models
    ]


def model_name(model_id: str | None) -> str:
    bare = (model_id or "").removeprefix(PREFIX)
    for model in _models_cache:
        if model["id"] == bare:
            return str(model["name"])
    return bare or "DeepAI Code"


def supports_images(model_id: str) -> bool:
    """目録キャッシュの input に image を含むモデルだけ画像を許可する。"""
    bare = (model_id or "").removeprefix(PREFIX)
    return any(
        model["id"] == bare and model.get("supports_images") for model in _models_cache
    )


def supports_reasoning_efforts(model_id: str) -> list[str]:
    """目録に対応 efforts の情報が無いため、初版は常に対象外。"""
    return []


async def fetch_theos() -> dict[str, Any] | None:
    """Theos 残量を取得する。キー未設定時は None。"""
    if not api_key():
        return None
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        lane = await _resolve_lane(session)
        status, payload, headers = await _request(session, "GET", "/deepai_code/theos", lane=lane)
        _raise_for_status(status, payload, headers)
    return payload if isinstance(payload, dict) else None


async def chat(model_id: str, messages: list[dict[str, Any]], *,
               max_tokens: int = 1200) -> str:
    """deepaicode:: 付き、または素のモデルIDで1回だけ呼び出す。"""
    global _lane_version
    if not api_key():
        raise DeepAICodeAuthError(
            "DeepAI CodeのAPIキーが未設定です。Pi の `.env` に `DEEPAI_API_KEY` を設定してください。"
        )
    bare = (model_id or "").removeprefix(PREFIX)
    if not bare:
        raise DeepAICodeError("DeepAI Codeのモデルが指定されていません。")
    shaped = ensure_system_message(list(messages))
    total_chars = sum(len(str(message.get("content", ""))) for message in shaped)
    if total_chars > MAX_PROMPT_CHARS:
        raise DeepAICodeError("DeepAI Codeへ送る内容は32,000文字までです。")
    payload = {"model": bare, "messages": shaped, "max_tokens": max_tokens}
    async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
        lane = await _resolve_lane(session)
        status, data, headers = await _request(
            session, "POST", "/deepai_code/chat/completions", lane=lane, json=payload
        )
        if status == 426:
            _lane_version = None
            lane = await _resolve_lane(session)
            status, data, headers = await _request(
                session, "POST", "/deepai_code/chat/completions", lane=lane, json=payload
            )
    _raise_for_status(status, data, headers)
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise DeepAICodeError("DeepAI Codeから回答本文が返りませんでした。") from exc
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    text = str(content or "").strip()
    if not text:
        raise DeepAICodeError("DeepAI Codeから空の回答が返りました。")
    return text
