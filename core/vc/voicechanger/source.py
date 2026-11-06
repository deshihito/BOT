from __future__ import annotations
import logging
import threading
import time
import numpy as np
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.support.legacy import Responder
from core.vc import vc_feature_restore
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_session import VoiceBusy, get_manager
from core.support.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU
from functools import partial as _partial

from core.vc.voicechanger.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.voicechanger.common import BYTES_PER_SECOND, CHANNELS, CHUNK_BYTES, DEFAULT_FADE_MS, DEFAULT_MAX_BUFFER_MS, DEFAULT_TARGET_BUFFER_MS, FRAME_SIZE  # noqa: F401
from core.vc.voicechanger.shifter import AdaptiveWSOLAPitchShifter  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class WaitAndConnectAudioSource(discord.AudioSource):
    """
    データ不足（無音期間）発生時はフェードアウトして「次のデータが来るまで待機」し、
    20ms分のデータが溜まった瞬間にフェードインで滑らかに復帰するソース。
    """
    def __init__(
        self,
        target_buffer_ms: float = DEFAULT_TARGET_BUFFER_MS,
        max_buffer_ms: float = DEFAULT_MAX_BUFFER_MS,
        fade_ms: float = DEFAULT_FADE_MS,
        shifter: AdaptiveWSOLAPitchShifter = None,
    ) -> None:
        self._buffer = bytearray()
        self._lock = threading.Lock()

        self.target_buffer_ms = target_buffer_ms
        self.max_buffer_ms = max_buffer_ms

        self.target_prebuffer_bytes = self._ms_to_frame_bytes(target_buffer_ms)
        self.max_buffer_bytes = self._ms_to_frame_bytes(max_buffer_ms)

        fade_bytes = self._ms_to_frame_bytes(fade_ms)
        self._fade_frames = max(1, fade_bytes // FRAME_SIZE)

        self.is_waiting_for_data = True
        self.shifter = shifter

        self._last_out_tail = np.zeros((self._fade_frames, CHANNELS), dtype=np.float32)
        self._was_playing = False

        self.underrun_count = 0

    @staticmethod
    def _ms_to_frame_bytes(ms: float) -> int:
        raw = int((ms / 1000.0) * BYTES_PER_SECOND)
        return max(FRAME_SIZE, (raw // FRAME_SIZE) * FRAME_SIZE)

    def update_settings(self, target_buffer_ms: float | None = None, max_buffer_ms: float | None = None) -> None:
        with self._lock:
            if target_buffer_ms is not None:
                self.target_buffer_ms = target_buffer_ms
                self.target_prebuffer_bytes = self._ms_to_frame_bytes(target_buffer_ms)
            if max_buffer_ms is not None:
                self.max_buffer_ms = max_buffer_ms
                self.max_buffer_bytes = self._ms_to_frame_bytes(max_buffer_ms)

    def feed(self, pcm: bytes) -> None:
        with self._lock:
            self._buffer.extend(pcm)

            # 遅延が積み重なって max_buffer_ms (40ms) を超えた場合はトリムして遅延増加を防ぐ
            overflow = len(self._buffer) - self.max_buffer_bytes
            if overflow > 0:
                trim_bytes = (overflow // FRAME_SIZE) * FRAME_SIZE
                self._crossfade_trim(trim_bytes)

            # 無音待機中、20ms分データが復帰したら即座に再生再開（read側でフェードイン）
            if self.is_waiting_for_data and len(self._buffer) >= self.target_prebuffer_bytes:
                self.is_waiting_for_data = False

    def _crossfade_trim(self, trim_bytes: int) -> None:
        if trim_bytes <= 0:
            return

        fade_bytes = self._fade_frames * FRAME_SIZE
        fade_bytes = min(fade_bytes, trim_bytes, len(self._buffer) - trim_bytes)

        if fade_bytes <= 0:
            del self._buffer[:trim_bytes]
            return

        pre = np.frombuffer(
            bytes(self._buffer[trim_bytes - fade_bytes:trim_bytes]), dtype=np.int16
        ).astype(np.float32).reshape(-1, CHANNELS)
        post = np.frombuffer(
            bytes(self._buffer[trim_bytes:trim_bytes + fade_bytes]), dtype=np.int16
        ).astype(np.float32).reshape(-1, CHANNELS)

        n = min(len(pre), len(post))
        fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
        fade_out = 1.0 - fade_in
        blended = (pre[:n] * fade_out + post[:n] * fade_in).clip(-32768, 32767).astype(np.int16)

        del self._buffer[:trim_bytes]
        self._buffer[:blended.nbytes] = blended.tobytes()

    def read(self) -> bytes:
        with self._lock:
            # 正常再生時: 20ms分（CHUNK_BYTES）以上のバッファがある場合
            if not self.is_waiting_for_data and len(self._buffer) >= CHUNK_BYTES:
                chunk = bytes(self._buffer[:CHUNK_BYTES])
                del self._buffer[:CHUNK_BYTES]

                out = np.frombuffer(chunk, dtype=np.int16).astype(np.float32).reshape(-1, CHANNELS)

                if not self._was_playing:
                    # 無音待機状態からの復帰時: フェードインして「プチッ」音を防ぐ
                    n = min(self._fade_frames, out.shape[0])
                    fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
                    out[:n] = out[:n] * fade_in

                self._was_playing = True
                if out.shape[0] >= self._fade_frames:
                    self._last_out_tail = out[-self._fade_frames:].copy()
                else:
                    pad = self._fade_frames - out.shape[0]
                    self._last_out_tail = np.pad(out, ((pad, 0), (0, 0)))

                return out.astype(np.int16).tobytes()

            # データ不足時: 次のバッファが届くまで待機（無音を出力しつつフェードアウト処理）
            if self.shifter:
                self.shifter.mark_gap()

            silence = np.zeros((CHUNK_BYTES // FRAME_SIZE, CHANNELS), dtype=np.float32)

            if self._was_playing:
                # 音声再生から無音状態への突入時: 末尾をフェードアウト
                self.underrun_count += 1
                n = min(self._fade_frames, silence.shape[0])
                fade_out = np.linspace(1.0, 0.0, n, dtype=np.float32)[:, None]
                silence[:n] = self._last_out_tail[-n:] * fade_out

            self.is_waiting_for_data = True
            self._was_playing = False

            return silence.astype(np.int16).tobytes()

    @property
    def buffered_ms(self) -> float:
        with self._lock:
            return (len(self._buffer) / BYTES_PER_SECOND) * 1000.0

    def is_opus(self) -> bool:
        return False
