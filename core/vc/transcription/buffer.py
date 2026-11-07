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
from core.support.legacy import Responder
from core.general.ai import logfare
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import voice_connection_failed
from core.vc.voice_media import add_receive_sink, remove_receive_sink
from core.vc.speech_vad import SpeechDetector
from core.support.emojis import FAILED, LOADING, LOUPE, PAUSE
try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

from core.vc.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.transcription.common import BYTES_PER_FRAME, CHANNELS, CONFIRM_FRAMES, DISCORD_SAMPLE_RATE, FRAME_SEC, FRAME_SIZE, HANGOVER_SEC, MAX_GAP_FILL_SEC, MAX_UTTERANCE_SECONDS, MIN_VOICE_BAND_RATIO, MIN_VOICE_RMS, ONSET_FRAMES, PRE_ROLL_SEC, SILENCE_THRESHOLD_SEC, TAIL_PAD_SEC, VAD_AGGRESSIVENESS, VOICE_SNR_RATIO  # noqa: F401
from core.vc.transcription.dsp import _frame_features  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class UserAudioBuffer:
    def __init__(self, user_id: int, display_name: str, avatar_url: str | None = None):
        self.user_id = user_id
        self.display_name = display_name
        self.avatar_url = avatar_url
        self.buffer = bytearray()  # 48kHz ステレオ 16bit PCM（発話中のみ）
        self.pre_roll: deque[bytes] = deque(maxlen=max(1, int(PRE_ROLL_SEC / FRAME_SEC)))
        self.last_speech_time = time.monotonic()
        self.is_speaking = False
        self.loud_frames = 0
        self.speech_detector = SpeechDetector(aggressiveness=VAD_AGGRESSIVENESS)
        self.noise_floor: float | None = None  # 背景ノイズの大きさ（RMS）。ユーザーごとに自動で学習
        self.voice_run = 0  # 「声」と判定されたフレームの連続数
        self.voiced_end = 0  # buffer 内で最後に声があった位置（バイト）
        self._last_rtp_end: int | None = None
        self._last_arrival: float | None = None

    def _missing_samples(self, n_samples: int, rtp_timestamp: int | None) -> int:
        """直前のパケットから今回のパケットまでに「届かなかった」サンプル数（48kHz基準）"""
        now = time.monotonic()
        missing = 0
        if rtp_timestamp is not None:
            if self._last_rtp_end is not None:
                diff = (rtp_timestamp - self._last_rtp_end) & 0xFFFFFFFF
                missing = diff if diff < 0x80000000 else 0  # 巻き戻りは無視
            self._last_rtp_end = (rtp_timestamp + n_samples) & 0xFFFFFFFF
        else:
            # RTP タイムスタンプが取れない場合は到着時刻から推定
            if self._last_arrival is not None:
                gap = now - self._last_arrival - FRAME_SEC
                if gap > 0.06:
                    missing = int(gap * DISCORD_SAMPLE_RATE)
        self._last_arrival = now
        return min(missing, int(MAX_GAP_FILL_SEC * DISCORD_SAMPLE_RATE))

    def _is_voice_frame(self, pcm_data: bytes, vad_speech: bool) -> bool:
        """VAD・音量（背景ノイズ比）・声の帯域の3条件をすべて満たすフレームだけを「声」とする"""
        rms, band_ratio = _frame_features(pcm_data)
        floor = self.noise_floor if self.noise_floor is not None else min(max(rms, 20.0), 300.0)
        is_voice = (
            vad_speech
            and rms >= max(MIN_VOICE_RMS, floor * VOICE_SNR_RATIO)
            and band_ratio >= MIN_VOICE_BAND_RATIO
        )
        # 背景ノイズ量の学習: 静かになれば素早く下がり、声以外の音が続けば（ファン等）ゆっくり上がる
        if rms < floor:
            floor = floor * 0.8 + rms * 0.2
        else:
            floor += (rms - floor) * (0.0002 if is_voice else 0.002)
        self.noise_floor = max(floor, 20.0)
        return is_voice

    def append(self, pcm_data: bytes, rtp_timestamp: int | None = None):
        audio_np = np.frombuffer(pcm_data, dtype=np.int16)
        if len(audio_np) == 0:
            return

        n_samples = len(audio_np) // CHANNELS
        missing = self._missing_samples(n_samples, rtp_timestamp)
        if missing:
            self.speech_detector.reset()
            self.voice_run = 0  # 連続していない音声は「連続した声」として数えない
        vad_speech = self.speech_detector.has_speech(pcm_data)
        is_voice = self._is_voice_frame(pcm_data, vad_speech)
        self.voice_run = self.voice_run + 1 if is_voice else 0
        now = time.monotonic()

        if not self.is_speaking:
            if self.voice_run < ONSET_FRAMES:
                # まだ声と言い切れない（物音・咳・息など）。頭出し用に取っておくだけで送信はしない
                if missing:
                    self.pre_roll.clear()  # 連続していない音声は頭出し用に使わない
                self.pre_roll.append(pcm_data)
                return
            # 発話開始: 直前の音声を付けて語頭が欠けないようにする
            self.is_speaking = True
            self.loud_frames = self.voice_run - 1  # 今回のフレーム分は下で数える
            self.last_speech_time = now
            for chunk in self.pre_roll:
                self.buffer.extend(chunk)
            self.pre_roll.clear()
            self.voiced_end = len(self.buffer)
        elif missing:
            # 発話中にパケットが届かなかった時間は無音で埋め、実時間どおりの長さにする
            self.buffer.extend(bytes(missing * FRAME_SIZE))

        if is_voice and self.voice_run >= CONFIRM_FRAMES:
            self.last_speech_time = now
            self.loud_frames += 1
            self.buffer.extend(pcm_data)
            self.voiced_end = len(self.buffer)
        elif now - self.last_speech_time <= HANGOVER_SEC:
            self.buffer.extend(pcm_data)  # 語尾・息継ぎはそのまま残す
        else:
            self.buffer.extend(bytes(len(pcm_data)))  # 声のない区間の雑音は無音に置き換える

    def should_transcribe(self) -> bool:
        if not self.is_speaking or len(self.buffer) == 0:
            return False
        return (
            time.monotonic() - self.last_speech_time > SILENCE_THRESHOLD_SEC
            or len(self.buffer) >= DISCORD_SAMPLE_RATE * FRAME_SIZE * MAX_UTTERANCE_SECONDS
        )

    def pop_audio(self) -> tuple[bytes, int] | None:
        """溜めた 48kHz PCM と声のあったフレーム数を返す（重い変換はここではやらない）"""
        if len(self.buffer) == 0:
            self.is_speaking = False
            self.loud_frames = 0
            self.voiced_end = 0
            return None

        # 最後の声より後ろ（無音・雑音）は余白だけ残して切り捨てる
        keep = min(len(self.buffer), self.voiced_end + int(TAIL_PAD_SEC / FRAME_SEC) * BYTES_PER_FRAME)
        pcm = bytes(self.buffer[:keep])
        loud_frames = self.loud_frames
        self.buffer.clear()
        self.is_speaking = False
        self.loud_frames = 0
        self.voiced_end = 0
        return pcm, loud_frames
