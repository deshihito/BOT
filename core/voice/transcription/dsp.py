from __future__ import annotations
import asyncio
import functools
import io
import logging
import os
import threading
import time
import wave
from collections import deque
import numpy as np
import aiohttp
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.legacy import Responder
from core import logfare
from core.voice import vc_feature_restore
from core.voice.voice_session import VoiceBusy, get_manager
from core.voice.voice_recv_patch import patch_voice_recv_client
from core.messages import voice_connection_failed
from core.voice.voice_media import add_receive_sink, remove_receive_sink
from core.voice.speech_vad import SpeechDetector
from core.emojis import FAILED, LOADING, LOUPE, PAUSE
try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

from core.voice.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.transcription.common import CHANNELS, DISCORD_SAMPLE_RATE, HIGHPASS_HZ, MAX_GAIN, TARGET_PEAK, TRANSCRIPTION_SAMPLE_RATE, VOICE_BAND_HZ  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


patch_voice_recv_client()


def _lowpass_taps(num_taps: int = 95, cutoff_hz: float = 7200.0, fs: float = DISCORD_SAMPLE_RATE) -> np.ndarray:
    """間引き前に折り返し雑音を消すための FIR ローパス（窓付き sinc）"""
    n = np.arange(num_taps) - (num_taps - 1) / 2
    h = np.sinc(2.0 * cutoff_hz / fs * n) * np.hamming(num_taps)
    return (h / h.sum()).astype(np.float32)


_LPF_TAPS = _lowpass_taps()


@functools.lru_cache(maxsize=8)
def _spectrum_masks(n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """フレーム長 n 用の (窓, 全帯域マスク, 声帯域マスク)"""
    freqs = np.fft.rfftfreq(n, 1.0 / DISCORD_SAMPLE_RATE)
    lo, hi = VOICE_BAND_HZ
    return (
        np.hanning(n).astype(np.float32),
        freqs >= 50.0,
        (freqs >= lo) & (freqs <= hi),
    )


def _frame_features(pcm_data: bytes) -> tuple[float, float]:
    """1フレーム(20ms, 48kHzステレオ)の (RMS, 声の帯域に入っているエネルギー割合) を返す"""
    x = np.frombuffer(pcm_data, dtype=np.int16)
    usable = len(x) - (len(x) % CHANNELS)
    if usable <= 0:
        return 0.0, 0.0
    mono = x[:usable].reshape(-1, CHANNELS).astype(np.float32).mean(axis=1)
    rms = float(np.sqrt(np.mean(mono * mono)))
    window, full_mask, band_mask = _spectrum_masks(len(mono))
    power = np.abs(np.fft.rfft(mono * window)) ** 2
    total = float(power[full_mask].sum())
    if total <= 0.0:
        return rms, 0.0
    return rms, float(power[band_mask].sum()) / total


def _highpass(x: np.ndarray, cutoff_hz: float = HIGHPASS_HZ, fs: int = TRANSCRIPTION_SAMPLE_RATE) -> np.ndarray:
    """低域の雑音（ゴロゴロ音・吹かれ）を落とす"""
    if x.size < 8:
        return x
    spec = np.fft.rfft(x)
    spec[np.fft.rfftfreq(x.size, 1.0 / fs) < cutoff_hz] = 0
    return np.fft.irfft(spec, n=x.size).astype(np.float32)


def resample_48k_to_16k(pcm_data: bytes) -> bytes:
    """48kHz ステレオ 16bit PCM -> 16kHz モノラル 16bit PCM（ローパス付き + 音量補正）"""
    audio_16bit = np.frombuffer(pcm_data, dtype=np.int16)
    usable = len(audio_16bit) - (len(audio_16bit) % CHANNELS)
    if usable <= 0:
        return b""

    # ステレオ -> モノラル
    mono = audio_16bit[:usable].reshape(-1, CHANNELS).astype(np.float32).mean(axis=1)

    # 48kHz -> 16kHz（単純な [::3] 間引きだと高域が折り返して子音が潰れ、認識できなくなる）
    if resample_poly is not None:
        audio_16k = resample_poly(mono, 1, 3).astype(np.float32)
    else:
        audio_16k = np.convolve(mono, _LPF_TAPS, mode="same")[::3]

    audio_16k = _highpass(audio_16k)

    # 小さい声はピークが TARGET_PEAK になるまで持ち上げる（持ち上げのみ、MAX_GAIN 倍まで）
    peak = float(np.max(np.abs(audio_16k))) if audio_16k.size else 0.0
    if peak > 0:
        gain = min(MAX_GAIN, TARGET_PEAK * 32767.0 / peak)
        if gain > 1.0:
            audio_16k = audio_16k * gain

    return np.clip(audio_16k, -32768, 32767).astype(np.int16).tobytes()
