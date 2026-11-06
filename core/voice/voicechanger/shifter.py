from __future__ import annotations
import logging
import threading
import time
import numpy as np
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.legacy import Responder
from core import vc_feature_restore
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice_session import VoiceBusy, get_manager
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU
from functools import partial as _partial

from core.voice.voicechanger.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.voicechanger.common import CHANNELS  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class AdaptiveWSOLAPitchShifter:
    """
    20msパケット単位の WSOLA ピッチシフター。
    無音明けの新しいパケットが来た際に、境界をクロスフェードでなめらかに接続します。
    """
    def __init__(self, sample_rate: int = 48000):
        self.sample_rate = sample_rate
        self.win_size = 256  # 窓幅 (約5.3ms)
        self.prev_tail = np.zeros((self.win_size, CHANNELS), dtype=np.float32)
        self.reset_tail = True  # 無音待機明けなどのリセットフラグ

    def process(self, pcm_bytes: bytes, semitones: float) -> bytes:
        if len(pcm_bytes) == 0:
            return pcm_bytes

        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        audio_stereo = audio.reshape(-1, CHANNELS)
        n_samples = audio_stereo.shape[0]

        if semitones == 0:
            resampled = audio_stereo
        else:
            factor = 2.0 ** (semitones / 12.0)
            new_indices = np.arange(0, n_samples, factor)
            new_indices = new_indices[new_indices < n_samples - 1]

            idx_floor = new_indices.astype(np.int32)
            idx_frac = (new_indices - idx_floor)[:, None]

            resampled = (1.0 - idx_frac) * audio_stereo[idx_floor] + idx_frac * audio_stereo[idx_floor + 1]

        # 境界クロスフェード処理
        if not self.reset_tail:
            out_len = resampled.shape[0]
            fade_len = min(self.win_size, out_len, self.prev_tail.shape[0])
            if fade_len > 0:
                fade_in = np.linspace(0, 1, fade_len)[:, None]
                fade_out = 1.0 - fade_in
                resampled[:fade_len] = resampled[:fade_len] * fade_in + self.prev_tail[:fade_len] * fade_out
        else:
            self.reset_tail = False

        # 次回接続用に末尾を保持
        if resampled.shape[0] >= self.win_size:
            self.prev_tail = resampled[-self.win_size:].copy()

        # 20ms長に調整
        out_len = resampled.shape[0]
        if out_len >= n_samples:
            final_audio = resampled[:n_samples]
        else:
            final_audio = np.pad(resampled, ((0, n_samples - out_len), (0, 0)), mode='constant')

        int16_audio = (final_audio * 32767.0).clip(-32768, 32767).astype(np.int16)
        return int16_audio.tobytes()

    def mark_gap(self):
        """長時間無音が続いた時にテールをリセット"""
        self.reset_tail = True
