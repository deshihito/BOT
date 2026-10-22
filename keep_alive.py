"""Botの稼働確認と、Webから呼び出す内部API。"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from concurrent.futures import TimeoutError
import logging
import os
import re
import secrets
import time
from threading import Thread
from typing import Any

from flask import Flask, jsonify, request

from core import coder_service

app = Flask("")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024

logger = logging.getLogger(__name__)
_bot: Any | None = None
_recent_requests: dict[str, deque[float]] = defaultdict(deque)
_WINDOW_SECONDS = 60
_MAX_REQUESTS_PER_WINDOW = 8


@app.route("/")
def home():
    return "alive"


def configure_coder(bot: Any) -> None:
    """Discord Botの実行ループを、Flaskスレッドから使えるように保持する。"""
    global _bot
    _bot = bot


def _authorized() -> bool:
    expected = os.getenv("CODER_SERVICE_SHARED_SECRET", "")
    authorization = request.headers.get("Authorization", "")
    if not expected or not authorization.startswith("Bearer "):
        return False
    return secrets.compare_digest(authorization.removeprefix("Bearer "), expected)


def _within_rate_limit(user_id: str) -> bool:
    now = time.monotonic()
    requests = _recent_requests[user_id]
    while requests and now - requests[0] >= _WINDOW_SECONDS:
        requests.popleft()
    if len(requests) >= _MAX_REQUESTS_PER_WINDOW:
        return False
    requests.append(now)
    return True


@app.post("/internal/coder/run")
def run_coder():
    if not _authorized():
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

    future = asyncio.run_coroutine_threadsafe(coder_service.reply(prompt), loop)
    try:
        result = future.result(timeout=55)
    except TimeoutError:
        future.cancel()
        return jsonify({"error": "timeout"}), 504
    except Exception:
        logger.exception("Coder request failed")
        return jsonify({"error": "upstream_failed"}), 502

    return jsonify({"answer": result.text, "provider": result.provider, "model": result.model})


def run():
    app.run(host="0.0.0.0", port=10000)


def keep_alive():
    Thread(target=run, daemon=True).start()
