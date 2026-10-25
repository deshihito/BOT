"""Botの稼働確認と、Webから呼び出す内部API。"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from concurrent.futures import TimeoutError
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from threading import Lock, Thread
from typing import Any

from flask import Flask, jsonify, request

from core import coder_service

app = Flask("")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024

logger = logging.getLogger(__name__)
_bot: Any | None = None
_recent_requests: dict[str, deque[float]] = defaultdict(deque)
_activity_requests: dict[tuple[str, str, str], deque[float]] = defaultdict(deque)
_used_nonces: dict[str, float] = {}
_nonce_lock = Lock()
_activity_rate_lock = Lock()
_next_nonce_cleanup = 0.0
_WINDOW_SECONDS = 60
_MAX_REQUESTS_PER_WINDOW = 8
_ACTIVITY_MAX_REQUESTS_PER_WINDOW = 45
_SIGNATURE_TTL_SECONDS = 60


@app.route("/")
def home():
    return "alive"


def configure_coder(bot: Any) -> None:
    """Discord Botの実行ループを、Flaskスレッドから使えるように保持する。"""
    global _bot
    _bot = bot


def _authorized(expected_path: str = "/internal/coder/run") -> bool:
    """Verify a one-time HMAC for a fixed internal POST path."""
    if request.method != "POST" or request.path != expected_path:
        return False
    secret = os.getenv("CODER_SERVICE_SHARED_SECRET", "")
    timestamp = request.headers.get("X-AGO-Coder-Timestamp", "")
    nonce = request.headers.get("X-AGO-Coder-Nonce", "")
    signature = request.headers.get("X-AGO-Coder-Signature", "")
    if not secret or not timestamp or not re.fullmatch(r"[0-9a-f]{48}", nonce) or not signature:
        return False
    try:
        signed_at = int(timestamp)
    except ValueError:
        return False
    if abs(time.time() - signed_at) > _SIGNATURE_TTL_SECONDS:
        return False

    body_hash = hashlib.sha256(request.get_data(cache=True)).hexdigest()
    signed_payload = f"POST\n{expected_path}\n{timestamp}\n{nonce}\n{body_hash}".encode()
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    if not secrets.compare_digest(signature, expected):
        return False

    global _next_nonce_cleanup
    now = time.monotonic()
    with _nonce_lock:
        if now >= _next_nonce_cleanup:
            for used_nonce, expires_at in list(_used_nonces.items()):
                if expires_at <= now:
                    del _used_nonces[used_nonce]
            _next_nonce_cleanup = now + 10
        if nonce in _used_nonces:
            return False
        _used_nonces[nonce] = now + _SIGNATURE_TTL_SECONDS
    return True


def _within_rate_limit(user_id: str) -> bool:
    now = time.monotonic()
    requests = _recent_requests[user_id]
    while requests and now - requests[0] >= _WINDOW_SECONDS:
        requests.popleft()
    if len(requests) >= _MAX_REQUESTS_PER_WINDOW:
        return False
    requests.append(now)
    return True


def _within_activity_rate_limit(user_id: str, guild_id: str, channel_id: str) -> bool:
    now = time.monotonic()
    key = (user_id, guild_id, channel_id)
    with _activity_rate_lock:
        requests = _activity_requests[key]
        while requests and now - requests[0] >= _WINDOW_SECONDS:
            requests.popleft()
        if len(requests) >= _ACTIVITY_MAX_REQUESTS_PER_WINDOW:
            return False
        requests.append(now)
    return True


async def _fetch_activity_music_snapshot(guild_id: int, channel_id: int, user_id: int) -> dict | None:
    """Only expose current Music state to a member currently in that voice channel."""
    if _bot is None:
        return None
    guild = _bot.get_guild(guild_id)
    if guild is None:
        return None
    member = guild.get_member(user_id)
    voice = getattr(member, "voice", None) if member is not None else None
    member_channel = getattr(getattr(voice, "channel", None), "id", None)
    if member_channel != channel_id:
        return None

    voice_client = getattr(guild, "voice_client", None)
    voice_channel = getattr(getattr(voice_client, "channel", None), "id", None)
    if (
        voice_client is None
        or not voice_client.is_connected()
        or voice_channel != channel_id
    ):
        return {"status": "idle", "serverTime": round(time.time(), 3)}

    cog = _bot.get_cog("VoiceCog")
    if cog is None:
        return {"status": "idle", "serverTime": round(time.time(), 3)}
    return cog.activity_snapshot(
        guild_id,
        is_playing=bool(voice_client.is_playing()),
        now=time.time(),
    )


@app.post("/internal/coder/run")
def run_coder():
    if not _authorized("/internal/coder/run"):
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_request"}), 400
    prompt = payload.get("prompt")
    user = payload.get("user")
    user_id = user.get("id") if isinstance(user, dict) else None
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 4000:
        return jsonify({"error": "invalid_prompt"}), 400
    if not isinstance(user_id, str) or not re.fullmatch(r"\d{1,30}", user_id):
        return jsonify({"error": "invalid_user"}), 400

    loop = getattr(_bot, "coder_loop", None)
    if _bot is None or loop is None or not _bot.is_ready():
        return jsonify({"error": "bot_unavailable"}), 503
    if not _within_rate_limit(user_id):
        return jsonify({"error": "rate_limited"}), 429

    future = asyncio.run_coroutine_threadsafe(coder_service.reply(prompt, int(user_id)), loop)
    try:
        result = future.result(timeout=55)
    except TimeoutError:
        future.cancel()
        return jsonify({"error": "timeout"}), 504
    except Exception:
        logger.exception("Coder request failed")
        return jsonify({"error": "upstream_failed"}), 502

    return jsonify({"answer": result.text, "provider": result.provider, "model": result.model})


@app.post("/internal/activity/music-state")
def activity_music_state():
    path = "/internal/activity/music-state"
    if not _authorized(path):
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_request"}), 400
    guild_id = payload.get("guild_id")
    channel_id = payload.get("channel_id")
    user_id = payload.get("user_id")
    for value in (guild_id, channel_id, user_id):
        if not isinstance(value, str) or not re.fullmatch(r"\d{1,30}", value):
            return jsonify({"error": "invalid_request"}), 400

    loop = getattr(_bot, "coder_loop", None)
    if _bot is None or loop is None or not _bot.is_ready():
        return jsonify({"error": "bot_unavailable"}), 503
    if not _within_activity_rate_limit(user_id, guild_id, channel_id):
        return jsonify({"error": "rate_limited"}), 429

    future = asyncio.run_coroutine_threadsafe(
        _fetch_activity_music_snapshot(int(guild_id), int(channel_id), int(user_id)), loop
    )
    try:
        snapshot = future.result(timeout=3)
    except TimeoutError:
        future.cancel()
        return jsonify({"error": "timeout"}), 504
    except Exception:
        logger.exception("Music Activity state request failed")
        return jsonify({"error": "upstream_failed"}), 502
    if snapshot is None:
        return jsonify({"error": "not_in_voice_channel"}), 403
    response = jsonify(snapshot)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


def run():
    port = int(os.getenv("BOT_API_PORT", "8081"))
    app.run(host="0.0.0.0", port=port)


def keep_alive():
    Thread(target=run, daemon=True).start()
