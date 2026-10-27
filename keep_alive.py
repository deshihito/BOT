"""Botの稼働確認と、Webから呼び出す内部API。"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from concurrent.futures import TimeoutError
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from threading import Lock, Thread
from typing import Any

import yt_dlp
import requests
from flask import Flask, Response, jsonify, request, send_file

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

# 動画配信用のロックとプロセス管理
_video_lock = Lock()
_video_locks: dict[str, Lock] = defaultdict(Lock)
_hls_processes: dict[str, subprocess.Popen] = {}
_hls_last_access: dict[str, float] = {}
_video_status: dict[str, str] = {}
_video_errors: dict[str, tuple[float, str]] = {}

_next_nonce_cleanup = 0.0
_WINDOW_SECONDS = 60
_MAX_REQUESTS_PER_WINDOW = 8
_ACTIVITY_MAX_REQUESTS_PER_WINDOW = 45
_SIGNATURE_TTL_SECONDS = 60
_HLS_CACHE_TTL_SECONDS = 15 * 60
_HLS_ERROR_COOLDOWN_SECONDS = 20
_HLS_MANIFEST_WAIT_SECONDS = 25
_HLS_CACHE_DIR = Path(os.getenv("ACTIVITY_VIDEO_CACHE_DIR", tempfile.gettempdir())) / "agobot-activity-hls"


def _media_worker_configured() -> bool:
    return bool(os.getenv("ACTIVITY_MEDIA_WORKER_URL") and os.getenv("ACTIVITY_MEDIA_WORKER_SECRET"))


def _proxy_activity_hls_to_worker(video_id: str, asset: str):
    """Forward only the authorized, current-video HLS request to the worker."""
    base_url = os.getenv("ACTIVITY_MEDIA_WORKER_URL", "").rstrip("/")
    secret = os.getenv("ACTIVITY_MEDIA_WORKER_SECRET", "")
    body = json.dumps({"video_id": video_id, "asset": asset}, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(24)
    body_hash = hashlib.sha256(body).hexdigest()
    signed = f"POST\n/v1/hls\n{timestamp}\n{nonce}\n{body_hash}".encode()
    signature = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    try:
        upstream = requests.post(
            f"{base_url}/v1/hls",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-AGO-Media-Timestamp": timestamp,
                "X-AGO-Media-Nonce": nonce,
                "X-AGO-Media-Signature": signature,
            },
            stream=True,
            timeout=(3, 10),
        )
    except requests.RequestException:
        logger.exception("Activity Media Worker request failed")
        return jsonify({"error": "media_worker_unavailable"}), 503

    if upstream.status_code != 200:
        try:
            payload = upstream.json()
        except ValueError:
            payload = {"error": "media_worker_failed"}
        status = upstream.status_code if upstream.status_code in {202, 404, 409, 429} else 502
        upstream.close()
        return jsonify(payload), status

    def stream():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    headers = {"Content-Type": upstream.headers.get("Content-Type", "application/octet-stream")}
    for name in ("Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control"):
        value = upstream.headers.get(name)
        if value:
            headers[name] = value
    return Response(stream(), status=200, headers=headers, direct_passthrough=True)


@app.route("/")
def home():
    return "alive"


def configure_coder(bot: Any) -> None:
    global _bot
    _bot = bot


def _authorized(expected_path: str = "/internal/coder/run") -> bool:
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


class _HlsFailed(RuntimeError):
    """HLS生成が失敗したことを表す。detail は呼び出し側へそのまま返す。"""


def _pick_video_source(info: dict) -> tuple[str, dict]:
    """yt-dlp の結果から映像ストリームのURLとHTTPヘッダを取り出す。

    "bestvideo+bestaudio" のようにフォーマットを結合した場合、トップレベルの
    info["url"] は存在せず requested_formats の中にURLが入る。
    """
    candidates = info.get("requested_formats") or [info]
    for fmt in candidates:
        url = fmt.get("url")
        if not isinstance(url, str) or not url:
            continue
        if fmt.get("vcodec") in (None, "none") and fmt is not info and len(candidates) > 1:
            continue  # 音声のみのフォーマットは使わない
        headers = fmt.get("http_headers") or info.get("http_headers") or {}
        return url, headers
    raise RuntimeError("yt-dlp did not return a playable video stream URL")


def _run_ffmpeg_task(video_id: str, directory: Path, manifest: Path):
    process: subprocess.Popen | None = None
    stderr_tail: deque[str] = deque(maxlen=8)
    try:
        # 映像のみ取得（音声はBotがVCで再生するのでActivity側は無音）。
        # extractor_args でクライアントを固定すると取得できなくなることがあるため、
        # yt-dlp の既定に任せる。
        options = {
            "format": "bestvideo[height<=720]/best[height<=720]/best",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": 10,
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)

        stream_url, headers = _pick_video_source(info)
        header_value = "".join(f"{key}: {value}\r\n" for key, value in headers.items())

        command = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
        if header_value:
            command += ["-headers", header_value]
        command += [
            "-re",  # 実時間で変換する（全編を一気に変換するとプレイリストが終端だけになる）
            "-i", stream_url,
            "-map", "0:v:0", "-an",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-r", "24",
            "-pix_fmt", "yuv420p",
            "-g", "48", "-keyint_min", "48",
            "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*2)",
            "-f", "hls",
            "-hls_time", "2", "-hls_list_size", "6",
            "-hls_flags", "delete_segments+append_list+independent_segments",
            "-hls_segment_filename", str(directory / "seg-%06d.ts"),
            str(manifest),
        ]
        process = subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
        )

        with _video_lock:
            _hls_processes[video_id] = process

        def read_ffmpeg_errors(proc: subprocess.Popen = process) -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                line = line.strip()
                if line:
                    stderr_tail.append(line)
                    logger.error("[ActivityVideo][ffmpeg][%s] %s", video_id, line)

        Thread(target=read_ffmpeg_errors, daemon=True).start()

        deadline = time.monotonic() + _HLS_MANIFEST_WAIT_SECONDS
        while not manifest.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.25)

        if not manifest.exists():
            if process.poll() is None:
                process.terminate()
                raise RuntimeError("FFmpeg did not create an HLS manifest in time")
            time.sleep(0.2)  # stderr の読み取りが追いつくのを少し待つ
            reason = " / ".join(stderr_tail) or f"exit code {process.returncode}"
            raise RuntimeError(f"FFmpeg exited before creating a manifest: {reason}")

        with _video_lock:
            _video_status[video_id] = "ready"

    except Exception as e:
        detail = str(e)[:400]
        logger.error("[ActivityVideo] HLS background task failed video_id=%s error=%s", video_id, detail)
        if process is not None and process.poll() is None:
            process.terminate()
        with _video_lock:
            _video_status[video_id] = "error"
            _video_errors[video_id] = (time.monotonic(), detail)


def _prepare_activity_hls(video_id: str) -> Path | None:
    """生成済みならディレクトリを返す。生成中なら None。失敗なら _HlsFailed。"""
    _HLS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    directory = _HLS_CACHE_DIR / video_id

    # video_id 単位のロックで、同時アクセス時に1人だけが生成処理に入るようにする
    with _video_locks[video_id]:
        _hls_last_access[video_id] = time.time()
        manifest = directory / "index.m3u8"

        with _video_lock:
            status = _video_status.get(video_id)
            process = _hls_processes.get(video_id)

            if status == "error":
                failed_at, detail = _video_errors.get(video_id, (0.0, "unknown error"))
                # 失敗直後は再試行せずエラーを返す（YouTubeへの連打とffmpegの再起動ループを防ぐ）
                if time.monotonic() - failed_at < _HLS_ERROR_COOLDOWN_SECONDS:
                    raise _HlsFailed(detail)
                _video_status.pop(video_id, None)
                _video_errors.pop(video_id, None)
                status = None

            if status == "ready" and process is not None and manifest.exists():
                code = process.poll()
                if code is None:
                    return directory
                # 正常終了した直後なら終端付きプレイリストをそのまま返す
                if code == 0 and time.time() - manifest.stat().st_mtime < 60:
                    return directory

            if status == "ready":
                # プロセスが異常終了した／古い／manifestが無い → 作り直す
                if process is not None and process.poll() is None:
                    process.terminate()
                _video_status.pop(video_id, None)
                _hls_processes.pop(video_id, None)
                status = None

            if status is None:
                directory.mkdir(parents=True, exist_ok=True)
                for old in directory.iterdir():
                    old.unlink(missing_ok=True)

                _video_status[video_id] = "processing"
                Thread(target=_run_ffmpeg_task, args=(video_id, directory, manifest), daemon=True).start()
                return None

            return None  # processing


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


@app.post("/internal/activity/music-video")
def activity_music_video():
    path = "/internal/activity/music-video"
    if not _authorized(path):
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_request"}), 400
    guild_id = payload.get("guild_id")
    channel_id = payload.get("channel_id")
    user_id = payload.get("user_id")
    video_id = payload.get("video_id")
    asset = payload.get("asset", "index.m3u8")
    for value in (guild_id, channel_id, user_id):
        if not isinstance(value, str) or not re.fullmatch(r"\d{1,30}", value):
            return jsonify({"error": "invalid_request"}), 400
    if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "invalid_video"}), 400
    if not isinstance(asset, str) or not re.fullmatch(r"(?:index\.m3u8|seg-\d{6}\.ts)", asset):
        return jsonify({"error": "invalid_asset"}), 400
    loop = getattr(_bot, "coder_loop", None)
    if _bot is None or loop is None or not _bot.is_ready():
        return jsonify({"error": "bot_unavailable"}), 503
    future = asyncio.run_coroutine_threadsafe(
        _fetch_activity_music_snapshot(int(guild_id), int(channel_id), int(user_id)), loop
    )
    try:
        snapshot = future.result(timeout=3)
    except Exception:
        logger.exception("Music Activity video state request failed")
        return jsonify({"error": "music_state_unavailable"}), 502
    if not snapshot or snapshot.get("videoId") != video_id:
        return jsonify({"error": "video_not_current"}), 409

    # CPU-heavy yt-dlp/FFmpeg/HLS work runs in the dedicated worker when
    # configured. The bot remains the authorization boundary for guild/voice
    # membership and only proxies the resulting bytes.
    if _media_worker_configured():
        return _proxy_activity_hls_to_worker(video_id, asset)
    
    try:
        try:
            directory = _prepare_activity_hls(video_id)
        except _HlsFailed as e:
            return jsonify({"error": "video_unavailable", "detail": str(e)}), 502
        if directory is None:
            return jsonify({"status": "processing"}), 202

        output = directory / asset
        
        # セグメントファイルへの同時アクセスによる読み込みエラーを防ぐため、
        # ファイルが存在しない、またはサイズが0の場合は最大5秒待機してリトライする
        if asset.endswith(".ts"):
            for _ in range(50):
                if output.exists() and output.stat().st_size > 0:
                    break
                time.sleep(0.1)
        
        if not output.exists() or output.stat().st_size == 0:
            logger.warning("[ActivityVideo] asset not ready video_id=%s asset=%s", video_id, asset)
            return jsonify({"error": "segment_not_ready"}), 404
            
        mimetype = "application/vnd.apple.mpegurl" if asset.endswith(".m3u8") else "video/mp2t"
        
        try:
            response = send_file(output, mimetype=mimetype, conditional=True, max_age=0, etag=True)
        except OSError as e:
            # ffmpeg がファイルを書き込み中でロックされている場合などのエラーをキャッチ
            logger.warning("[ActivityVideo] File locked or read error: %s", e)
            return jsonify({"error": "file_busy"}), 503

        response.headers["Cache-Control"] = "no-store"
        return response
    except Exception as e:
        logger.exception("Music Activity video download failed for %s", video_id)
        return jsonify({"error": "video_unavailable", "detail": str(e)}), 502


def _hls_cleanup_worker() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with _video_lock:
            for vid, proc in list(_hls_processes.items()):
                # 終了済みでも、しばらくアクセスがある間は状態を残す（消すと再生成が走る）
                if now - _hls_last_access.get(vid, 0) <= _HLS_CACHE_TTL_SECONDS:
                    continue
                if proc.poll() is None:
                    proc.terminate()
                _hls_processes.pop(vid, None)
                _video_status.pop(vid, None)
                _video_errors.pop(vid, None)
                    
        if _HLS_CACHE_DIR.exists():
            for d in _HLS_CACHE_DIR.iterdir():
                if d.is_dir():
                    try:
                        if now - d.stat().st_mtime > _HLS_CACHE_TTL_SECONDS:
                            shutil.rmtree(d, ignore_errors=True)
                    except Exception:
                        pass


def run():
    Thread(target=_hls_cleanup_worker, daemon=True).start()
    app.run(host="0.0.0.0", port=10000)


def keep_alive():
    Thread(target=run, daemon=True).start()
