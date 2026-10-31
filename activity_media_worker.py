"""Standalone Activity HLS media worker.

The Discord bot keeps ownership of Voice state and authorization. This process
owns only yt-dlp/FFmpeg work and HLS segment delivery, so CPU-heavy video work
cannot block the bot event loop or its keep-alive HTTP server.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

import yt_dlp
from flask import Flask, jsonify, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024
logger = logging.getLogger(__name__)

SECRET = os.getenv("ACTIVITY_MEDIA_WORKER_SECRET", "")
CACHE_DIR = Path(os.getenv("ACTIVITY_MEDIA_CACHE_DIR", tempfile.gettempdir())) / "agobot-activity-hls"
CACHE_TTL_SECONDS = int(os.getenv("ACTIVITY_MEDIA_CACHE_TTL_SECONDS", str(15 * 60)))
SIGNATURE_TTL_SECONDS = 60
ERROR_COOLDOWN_SECONDS = 20
MANIFEST_WAIT_SECONDS = 25
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
ASSET = re.compile(r"^(?:index\.m3u8|seg-\d{6}\.ts)$")

_state_lock = threading.RLock()
_video_locks: dict[str, threading.Lock] = {}
_processes: dict[str, subprocess.Popen] = {}
_status: dict[str, str] = {}
_last_access: dict[str, float] = {}
_used_nonces: dict[str, float] = {}
_errors: dict[str, tuple[float, str]] = {}


class HlsFailed(RuntimeError):
    """HLS生成に失敗した。detail は呼び出し側へそのまま返す。"""


def _pick_video_source(info: dict) -> tuple[str, dict]:
    """yt-dlp の結果から映像ストリームのURLとHTTPヘッダを取り出す。

    "bestvideo+bestaudio" のように結合フォーマットを選ぶとトップレベルの
    info["url"] は無く、requested_formats の中にURLが入る。
    """
    candidates = info.get("requested_formats") or [info]
    for fmt in candidates:
        url = fmt.get("url")
        if not isinstance(url, str) or not url:
            continue
        if len(candidates) > 1 and fmt.get("vcodec") in (None, "none"):
            continue  # 音声のみのフォーマットは使わない
        headers = fmt.get("http_headers") or info.get("http_headers") or {}
        return url, headers
    raise RuntimeError("yt-dlp did not return a playable video stream URL")


def _video_lock(video_id: str) -> threading.Lock:
    with _state_lock:
        return _video_locks.setdefault(video_id, threading.Lock())


def _authorized() -> bool:
    if request.method != "POST" or request.path != "/v1/hls":
        return False
    if not SECRET:
        return False
    timestamp = request.headers.get("X-AGO-Media-Timestamp", "")
    nonce = request.headers.get("X-AGO-Media-Nonce", "")
    signature = request.headers.get("X-AGO-Media-Signature", "")
    if not re.fullmatch(r"\d{10,20}", timestamp) or not re.fullmatch(r"[0-9a-f]{48}", nonce):
        return False
    try:
        if abs(time.time() - int(timestamp)) > SIGNATURE_TTL_SECONDS:
            return False
    except ValueError:
        return False
    body_hash = hashlib.sha256(request.get_data(cache=True)).hexdigest()
    signed = f"POST\n/v1/hls\n{timestamp}\n{nonce}\n{body_hash}".encode()
    expected = hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return False
    now = time.monotonic()
    with _state_lock:
        for old, expires in list(_used_nonces.items()):
            if expires <= now:
                del _used_nonces[old]
        if nonce in _used_nonces:
            return False
        _used_nonces[nonce] = now + SIGNATURE_TTL_SECONDS
    return True


def _run_ffmpeg(video_id: str, directory: Path, manifest: Path) -> None:
    process: subprocess.Popen | None = None
    stderr_tail: deque[str] = deque(maxlen=8)
    try:
        # 映像のみ取得（音声はBotがVCで再生するのでActivity側は無音）。
        # player_client の固定は取得失敗の原因になるため外し、yt-dlp の既定に任せる。
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
            "-r", "24", "-pix_fmt", "yuv420p",
            "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
            "-force_key_frames", "expr:gte(t,n_forced*2)",
            "-f", "hls",
            # Keep the complete timeline available for track-loop seeks and
            # Activity clients that join after the live edge has moved on.
            "-hls_time", "2", "-hls_list_size", "0",
            "-hls_flags", "independent_segments",
            "-hls_segment_filename", str(directory / "seg-%06d.ts"), str(manifest),
        ]
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        with _state_lock:
            _processes[video_id] = process

        def drain_errors(proc: subprocess.Popen = process) -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                line = line.strip()
                if line:
                    stderr_tail.append(line)
                    logger.error("[Activity HLS][%s] %s", video_id, line)

        threading.Thread(target=drain_errors, daemon=True).start()

        deadline = time.monotonic() + MANIFEST_WAIT_SECONDS
        while not manifest.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.25)
        if not manifest.exists():
            if process.poll() is None:
                process.terminate()
                raise RuntimeError("FFmpeg did not create an HLS manifest in time")
            time.sleep(0.2)  # stderr の読み取りが追いつくのを少し待つ
            reason = " / ".join(stderr_tail) or f"exit code {process.returncode}"
            raise RuntimeError(f"FFmpeg exited before creating a manifest: {reason}")
        with _state_lock:
            _status[video_id] = "ready"
    except Exception as exc:
        detail = str(exc)[:400]
        logger.error("Activity HLS worker failed for %s: %s", video_id, detail)
        if process and process.poll() is None:
            process.terminate()
        with _state_lock:
            _status[video_id] = "error"
            _errors[video_id] = (time.monotonic(), detail)


def _prepare(video_id: str) -> Path | None:
    """生成済みならディレクトリを返す。生成中なら None。失敗なら HlsFailed。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    directory = CACHE_DIR / video_id
    manifest = directory / "index.m3u8"
    with _video_lock(video_id):
        _last_access[video_id] = time.time()
        with _state_lock:
            status = _status.get(video_id)
            process = _processes.get(video_id)

            if status == "error":
                failed_at, detail = _errors.get(video_id, (0.0, "unknown error"))
                # 失敗直後は再試行せずエラーを返す（YouTubeへの連打とffmpeg再起動ループを防ぐ）
                if time.monotonic() - failed_at < ERROR_COOLDOWN_SECONDS:
                    raise HlsFailed(detail)
                _status.pop(video_id, None)
                _errors.pop(video_id, None)
                status = None

            if status == "ready" and process is not None and manifest.exists():
                code = process.poll()
                if code is None:
                    return directory
                # 正常終了した直後なら、終端付きプレイリストをそのまま返す
                if code == 0 and time.time() - manifest.stat().st_mtime < 60:
                    return directory

            if status == "ready":
                # 異常終了した／古い／manifestが無い → 作り直す
                if process is not None and process.poll() is None:
                    process.terminate()
                _status.pop(video_id, None)
                _processes.pop(video_id, None)
                status = None

            if status is None:
                directory.mkdir(parents=True, exist_ok=True)
                for old in directory.iterdir():
                    old.unlink(missing_ok=True)
                _status[video_id] = "processing"
                threading.Thread(target=_run_ffmpeg, args=(video_id, directory, manifest), daemon=True).start()
    return None


@app.post("/v1/hls")
def hls_asset():
    if not _authorized():
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_request"}), 400
    video_id = payload.get("video_id")
    asset = payload.get("asset", "index.m3u8")
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        return jsonify({"error": "invalid_video"}), 400
    if not isinstance(asset, str) or not ASSET.fullmatch(asset):
        return jsonify({"error": "invalid_asset"}), 400
    try:
        directory = _prepare(video_id)
    except HlsFailed as exc:
        return jsonify({"error": "video_unavailable", "detail": str(exc)}), 502
    if directory is None:
        return jsonify({"status": "processing"}), 202
    try:
        os.utime(directory, None)
    except OSError:
        pass
    output = directory / asset
    if asset.endswith(".ts"):
        for _ in range(50):
            if output.exists() and output.stat().st_size > 0:
                break
            time.sleep(0.1)
    if not output.exists() or output.stat().st_size == 0:
        return jsonify({"error": "segment_not_ready"}), 404
    mimetype = "application/vnd.apple.mpegurl" if asset.endswith(".m3u8") else "video/mp2t"
    response = send_file(output, mimetype=mimetype, conditional=True, max_age=0, etag=True)
    response.headers["Cache-Control"] = "no-store"
    return response


def _cleanup_worker() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with _state_lock:
            for video_id, process in list(_processes.items()):
                # 終了済みでも、しばらくアクセスがある間は状態を残す（消すと再生成が走る）
                if now - _last_access.get(video_id, 0) <= CACHE_TTL_SECONDS:
                    continue
                if process.poll() is None:
                    process.terminate()
                _processes.pop(video_id, None)
                _status.pop(video_id, None)
                _errors.pop(video_id, None)
        if CACHE_DIR.exists():
            for directory in CACHE_DIR.iterdir():
                try:
                    if directory.is_dir() and now - directory.stat().st_mtime > CACHE_TTL_SECONDS:
                        shutil.rmtree(directory, ignore_errors=True)
                except OSError:
                    pass


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    threading.Thread(target=_cleanup_worker, daemon=True).start()
    app.run(host=os.getenv("ACTIVITY_MEDIA_WORKER_HOST", "0.0.0.0"), port=int(os.getenv("ACTIVITY_MEDIA_WORKER_PORT", "10002")))
