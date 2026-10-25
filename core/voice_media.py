"""Shared voice-client media paths for compatible voice features.

Discord VoiceClient allows one playback source and one receive sink. This module
multiplexes per-feature PCM sources and fans received VoiceData out to registered
feature sinks without introducing external audio processing services.
"""
from __future__ import annotations

import array
import logging
import threading

import discord
from discord.ext import voice_recv

logger = logging.getLogger(__name__)
FRAME_BYTES = 3840  # 20 ms, 48 kHz, stereo, signed 16-bit PCM


def _mix_frames(frames: list[bytes]) -> bytes:
    frames = [frame[:FRAME_BYTES].ljust(FRAME_BYTES, b"\x00") for frame in frames if frame]
    if not frames:
        return b"\x00" * FRAME_BYTES
    if len(frames) == 1:
        return frames[0]
    accum = array.array("i", [0] * (FRAME_BYTES // 2))
    for frame in frames:
        samples = array.array("h")
        samples.frombytes(frame)
        for index, sample in enumerate(samples):
            accum[index] += sample
    # Headroom grows with the number of simultaneous sources; then hard-limit peaks.
    gain = len(frames) ** -0.5
    output = array.array("h")
    output.extend(max(-32768, min(32767, int(sample * gain))) for sample in accum)
    return output.tobytes()


class SharedAudioSource(discord.AudioSource):
    """Pull one frame from each active feature source and mix it for Discord."""
    def __init__(self):
        self._sources: dict[str, tuple[discord.AudioSource, object | None]] = {}
        self._lock = threading.RLock()

    def add(self, key: str, source: discord.AudioSource, after=None) -> None:
        with self._lock:
            old = self._sources.get(key)
            if old and old[0] is source:
                return
            self._sources[key] = (source, after)
        if old:
            self._finish(key, old, None)

    def contains(self, key: str) -> bool:
        with self._lock:
            return key in self._sources

    def remove(self, key: str, error=None, *, notify: bool = False) -> bool:
        with self._lock:
            item = self._sources.pop(key, None)
        if item is None:
            return False
        self._finish(key, item, error if notify else None)
        return True

    @staticmethod
    def _finish(key: str, item, error) -> None:
        source, after = item
        try:
            source.cleanup()
        except Exception:
            logger.debug("audio source cleanup failed: %s", key, exc_info=True)
        if after is not None:
            try:
                after(error)
            except Exception:
                logger.exception("audio source completion callback failed: %s", key)

    def read(self) -> bytes:
        with self._lock:
            items = list(self._sources.items())
        frames: list[bytes] = []
        ended: list[tuple[str, tuple[discord.AudioSource, object | None], Exception | None]] = []
        for key, item in items:
            source = item[0]
            try:
                frame = source.read()
                if frame:
                    frames.append(frame)
                else:
                    ended.append((key, item, None))
            except Exception as exc:
                ended.append((key, item, exc))
        if ended:
            with self._lock:
                for key, item, error in ended:
                    if self._sources.get(key) == item:
                        self._sources.pop(key, None)
                        self._finish(key, item, error)
        return _mix_frames(frames)

    def is_opus(self) -> bool:
        return False

    def cleanup(self) -> None:
        with self._lock:
            items = list(self._sources.items())
            self._sources.clear()
        for key, item in items:
            self._finish(key, item, None)


class SharedReceiveSink(voice_recv.AudioSink):
    """Fan out Discord voice packets to feature sinks sharing a VoiceClient."""
    def __init__(self):
        super().__init__()
        self._sinks: dict[str, voice_recv.AudioSink] = {}
        self._lock = threading.RLock()

    def add(self, key: str, sink: voice_recv.AudioSink) -> None:
        with self._lock:
            old = self._sinks.get(key)
            self._sinks[key] = sink
        if old is not None and old is not sink:
            old.cleanup()

    def remove(self, key: str) -> bool:
        with self._lock:
            sink = self._sinks.pop(key, None)
        if sink is None:
            return False
        try:
            sink.cleanup()
        except Exception:
            logger.exception("receive sink cleanup failed: %s", key)
        return True

    def wants_opus(self) -> bool:
        with self._lock:
            return any(sink.wants_opus() for sink in self._sinks.values())

    def write(self, user, data: voice_recv.VoiceData) -> None:
        with self._lock:
            sinks = list(self._sinks.items())
        for key, sink in sinks:
            try:
                sink.write(user, data)
            except Exception:
                logger.exception("receive sink write failed: %s", key)

    def cleanup(self) -> None:
        with self._lock:
            sinks = list(self._sinks.items())
            self._sinks.clear()
        for key, sink in sinks:
            try:
                sink.cleanup()
            except Exception:
                logger.exception("receive sink cleanup failed: %s", key)


def get_audio_mixer(vc) -> SharedAudioSource:
    mixer = getattr(vc, "_shared_audio_source", None)
    if mixer is None:
        mixer = SharedAudioSource()
        vc._shared_audio_source = mixer
    return mixer


def add_audio_source(vc, key: str, source: discord.AudioSource, after=None) -> SharedAudioSource:
    mixer = get_audio_mixer(vc)
    mixer.add(key, source, after)
    if not vc.is_playing():
        vc.play(mixer, after=lambda error: logger.warning("shared voice mixer stopped: %r", error) if error else None)
    return mixer


def remove_audio_source(vc, key: str, error=None, *, notify: bool = False) -> bool:
    mixer = getattr(vc, "_shared_audio_source", None)
    return mixer.remove(key, error, notify=notify) if mixer is not None else False


def has_audio_source(vc, key: str) -> bool:
    mixer = getattr(vc, "_shared_audio_source", None)
    return bool(mixer is not None and mixer.contains(key))


def add_receive_sink(vc, key: str, sink: voice_recv.AudioSink) -> SharedReceiveSink:
    mux = getattr(vc, "_shared_receive_sink", None)
    if mux is None:
        mux = SharedReceiveSink()
        vc._shared_receive_sink = mux
        mux.add(key, sink)
        vc.listen(mux)
    else:
        mux.add(key, sink)
    return mux


def remove_receive_sink(vc, key: str) -> bool:
    mux = getattr(vc, "_shared_receive_sink", None)
    if mux is None:
        return False
    removed = mux.remove(key)
    with mux._lock:
        empty = not mux._sinks
    if empty and (removed or getattr(vc, "_shared_receive_sink", None) is mux):
        try:
            vc.stop_listening()
        except Exception:
            logger.debug("stop_listening failed", exc_info=True)
        if getattr(vc, "_shared_receive_sink", None) is mux:
            delattr(vc, "_shared_receive_sink")
    return removed
