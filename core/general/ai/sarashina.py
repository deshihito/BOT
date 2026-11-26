"""Sarashina（SB Intuitions）の API クライアント。

音声認識 (ASR) と音声合成 (TTS) を使う。チャットは Luna 側の経路
（core/support/server_assist/features/luna_ai.py）が担当する。

- ASR: ``POST /audio/transcriptions``（multipart、16kHz モノラル 16bit WAV、最大60秒）
- TTS: ``POST /audio/speech``（JSON、非ストリーミング、wav は 24kHz モノラル）

キーは Logfare と同じ複数キー規約で集め、HTTP 429 のときだけ次のキーへ
切り替える。レート制限は ASR 30 RPM / TTS 6 RPM（契約主体×モデル単位）。
"""
from __future__ import annotations

import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.sarashina.ai/v1"

TRANSCRIPTION_MODEL = os.getenv("SARASHINA_ASR_MODEL", "sarashina3.2-asr").strip() or "sarashina3.2-asr"
TTS_MODEL = os.getenv("SARASHINA_TTS_MODEL", "sarashina3.2-tts").strip() or "sarashina3.2-tts"

# TTS の声（57種）。先頭の aiku を既定にする。
VOICES: tuple[str, ...] = (
    "aiku", "aika", "aoi", "arisa", "ayumi", "daichi", "haruka", "hiroto",
    "ichika", "kai", "kazuki", "keita", "kenji", "kenya", "kenta", "kentaro",
    "kotaro", "kyoka", "mai", "mana", "megu", "mikoto", "mizuki", "nagi",
    "nanami", "nana", "naoki", "nao", "natsumi", "nonoka", "nozomi", "osamu",
    "rei", "ren", "riku", "rina", "rinka", "ryuji", "ryota", "saki",
    "sakura", "satoshi", "sayaka", "shiori", "shota", "shun", "soma", "sotaro",
    "takumi", "tamaki", "tatsuya", "tsuyoshi", "yuki", "yuto", "yuma", "yuna",
    "yuya",
)
DEFAULT_VOICE = VOICES[0]

TTS_MAX_CHARS = 1000


def _base_url() -> str:
    return os.getenv("SARASHINA_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/") or DEFAULT_BASE_URL


class SarashinaHTTPError(RuntimeError):
    def __init__(self, status: int, retry_after: str | None = None):
        self.status = status
        self.retry_after = retry_after
        super().__init__(f"Sarashina API error {status}")


# 予備キーのクールダウン（Logfare と同方式）。429 を返したキーは
# Retry-After（無ければ既定値）の間スキップする。メモリ内のみ。
DEFAULT_KEY_COOLDOWN_SECONDS = 3600.0
MAX_KEY_COOLDOWN_SECONDS = 86400.0
_key_cooldown_until: dict[str, float] = {}


def api_keys() -> list[str]:
    """利用可能な API キーを優先順に返す。

    主キー ``SARASHINA_API_KEY``、番号付き予備 ``SARASHINA_API_KEY_2`` 〜
    ``SARASHINA_API_KEY_10``、追加分 ``SARASHINA_API_KEYS``（カンマ区切り）の順。
    空白除去・空欄除外・重複除去する。
    """
    candidates: list[str | None] = [os.getenv("SARASHINA_API_KEY")]
    candidates.extend(os.getenv(f"SARASHINA_API_KEY_{i}") for i in range(2, 11))
    candidates.extend(os.getenv("SARASHINA_API_KEYS", "").split(","))
    keys: list[str] = []
    for candidate in candidates:
        if candidate is None:
            continue
        key = candidate.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def api_key() -> str | None:
    """互換用: 先頭のキーを返す（未設定なら None）。設定有無チェックは従来通り動く。"""
    keys = api_keys()
    return keys[0] if keys else None


def _retry_after_seconds(retry_after: str | None) -> float:
    if retry_after:
        try:
            value = float(str(retry_after).strip())
        except ValueError:
            return DEFAULT_KEY_COOLDOWN_SECONDS
        return min(max(value, 0.0), MAX_KEY_COOLDOWN_SECONDS)
    return DEFAULT_KEY_COOLDOWN_SECONDS


def _mark_key_cooldown(key: str, retry_after: str | None) -> None:
    _key_cooldown_until[key] = time.monotonic() + _retry_after_seconds(retry_after)


def _key_attempt_order() -> list[tuple[int, str]]:
    """試行順の (キー番号, キー) 一覧。クールダウン中のキーは飛ばす。

    全キーがクールダウン中なら、終了が一番早いキーだけを試す。
    キー番号は api_keys() の 1 始まりの順序で、ログでの識別にだけ使う。
    """
    keys = api_keys()
    if not keys:
        return []
    now = time.monotonic()
    indexed = list(enumerate(keys, start=1))
    available = [(i, k) for i, k in indexed if _key_cooldown_until.get(k, 0.0) <= now]
    if available:
        return available
    return [min(indexed, key=lambda item: _key_cooldown_until.get(item[1], 0.0))]


def _note_key_429(order: list[tuple[int, str]], pos: int, index: int, key: str, retry_after: str | None) -> None:
    """429 を返したキーをクールダウンに入れ、切替をキー番号だけで記録する（キー値は出さない）。"""
    _mark_key_cooldown(key, retry_after)
    if pos + 1 < len(order):
        logger.warning(
            "Sarashina APIキー #%d が HTTP 429 のため、キー #%d へ切り替えます", index, order[pos + 1][0]
        )
    else:
        logger.warning("Sarashina APIキーがすべて HTTP 429 を返しました（最後はキー #%d）", index)


async def _with_key_failover(attempt: Callable[[str], Awaitable[Any]]) -> Any:
    """attempt(key) を実行し、HTTP 429 のときだけ次のキーで同じリクエストを再試行する。

    429 以外のエラーはそのまま上げる（設定ミス等を予備キーで隠さない）。
    """
    order = _key_attempt_order()
    if not order:
        raise RuntimeError("SARASHINA_API_KEY が設定されていません。")
    last_error: SarashinaHTTPError | None = None
    for pos, (index, key) in enumerate(order):
        try:
            return await attempt(key)
        except SarashinaHTTPError as exc:
            if exc.status != 429:
                raise
            _note_key_429(order, pos, index, key, exc.retry_after)
            last_error = exc
    assert last_error is not None
    raise last_error


def _transcription_form(audio: bytes, filename: str) -> aiohttp.FormData:
    form = aiohttp.FormData()
    form.add_field("model", TRANSCRIPTION_MODEL)
    form.add_field("response_format", "json")
    form.add_field("file", audio, filename=filename, content_type="audio/wav")
    return form


async def transcribe_audio(audio: bytes, *, filename: str = "voice.wav") -> str:
    """Sarashina の音声認識 endpoint を呼び、認識テキストを返す。

    応答に text が無い場合は、呼び出し側が文字列マッチで判定できるよう
    「文字起こし結果がありません」を含む RuntimeError を上げる。
    認識結果が空文字の場合はそのまま空文字を返す（呼び出し側で無言扱いになる）。
    """
    timeout = aiohttp.ClientTimeout(total=90)

    async def _attempt(key: str) -> str:
        headers = {"Authorization": f"Bearer {key}"}
        form = _transcription_form(audio, filename)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{_base_url()}/audio/transcriptions",
                headers=headers,
                data=form,
            ) as response:
                if response.status >= 400:
                    raise SarashinaHTTPError(response.status, response.headers.get("Retry-After"))
                try:
                    result: Any = await response.json(content_type=None)
                except Exception:
                    result = await response.text()
        if isinstance(result, dict) and isinstance(result.get("text"), str):
            return result["text"].strip()
        logger.warning("Sarashina 音声認識の応答に text がありません。応答の型: %s", type(result).__name__)
        raise RuntimeError("Sarashina 音声認識 API の応答に文字起こし結果がありませんでした。")

    return await _with_key_failover(_attempt)


async def synthesize_speech(text: str, *, voice: str, speed: float = 1.0) -> bytes:
    """Sarashina の音声合成 endpoint を呼び、wav のバイト列を返す（24kHz モノラル）。"""
    if voice not in VOICES:
        raise ValueError(f"Sarashina の声 '{voice}' は使えません。")
    if len(text) > TTS_MAX_CHARS:
        raise ValueError(f"Sarashina TTS は1リクエスト {TTS_MAX_CHARS} 文字までです。")
    timeout = aiohttp.ClientTimeout(total=90)
    payload = {
        "model": TTS_MODEL,
        "input": text,
        "voice": voice,
        "response_format": "wav",
        "speed": speed,
    }

    async def _attempt(key: str) -> bytes:
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{_base_url()}/audio/speech",
                headers=headers,
                json=payload,
            ) as response:
                if response.status >= 400:
                    raise SarashinaHTTPError(response.status, response.headers.get("Retry-After"))
                return await response.read()

    return await _with_key_failover(_attempt)
