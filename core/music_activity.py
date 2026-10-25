"""Small, read-only projection of Music state for the Discord Activity."""
from __future__ import annotations

import math
import re
import time
from urllib.parse import parse_qs, urlsplit

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_youtube_video_id(url: object) -> str | None:
    """Return a validated YouTube video ID from a supported page URL."""
    if not isinstance(url, str) or len(url) > 2048:
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in {"http", "https"}:
            return None
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return None

    candidate = None
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        query_id = parse_qs(parsed.query).get("v", [None])[0]
        if query_id:
            candidate = query_id
        else:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"embed", "shorts", "live", "v"}:
                candidate = parts[1]
    elif host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com"):
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2 and parts[0] == "embed":
            candidate = parts[1]

    return candidate if isinstance(candidate, str) and _VIDEO_ID.fullmatch(candidate) else None


def _finite_number(value: object, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return fallback
    return result if math.isfinite(result) else fallback


def build_music_activity_snapshot(
    state: dict,
    *,
    is_playing: bool,
    now: float | None = None,
) -> dict:
    """Project Bot state into a minimal Activity response safe for a browser."""
    server_time = time.time() if now is None else _finite_number(now, time.time())
    result = {"status": "idle", "serverTime": round(server_time, 3)}
    track = state.get("current_track")
    if not isinstance(track, (tuple, list)) or len(track) < 5:
        return result

    title = str(track[1] or "").replace("\r", " ").replace("\n", " ").strip()[:200]
    if track[4] is not True:
        return {**result, "status": "unsupported", "title": title}

    video_id = extract_youtube_video_id(state.get("current_yt_page_url"))
    if video_id is None:
        return {**result, "status": "unsupported", "title": title}

    speed = _finite_number(state.get("speed", 1.0), 1.0)
    if speed < 0.25 or speed > 4.0:
        speed = 1.0
    position = max(0.0, _finite_number(state.get("elapsed_offset", 0.0)))
    paused = bool(state.get("is_paused"))
    status = "paused" if paused else ("playing" if is_playing else "loading")
    if status == "playing":
        started_at = _finite_number(state.get("start_time", server_time), server_time)
        if started_at > 0:
            position += max(0.0, server_time - started_at) * speed

    duration = max(0.0, _finite_number(track[2], 0.0))
    if duration > 0:
        position = min(position, duration)

    result.update({
        "status": status,
        "videoId": video_id,
        "title": title,
        "positionSeconds": round(position, 3),
        "durationSeconds": round(duration, 3),
        "playbackRate": round(speed, 3),
    })
    return result
