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
from core.vc.transcription.buffer import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, UserAudioBuffer  # noqa: F401
from core.vc.transcription.common import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, DISCORD_SAMPLE_RATE, TRANSCRIPTION_SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, FRAME_SIZE, SILENCE_THRESHOLD_SEC, MIN_UTTERANCE_SECONDS, MAX_UTTERANCE_SECONDS, MIN_LOUD_FRAMES, VAD_AGGRESSIVENESS, ONSET_FRAMES, CONFIRM_FRAMES, HANGOVER_SEC, TAIL_PAD_SEC, MIN_VOICE_RMS, VOICE_SNR_RATIO, VOICE_BAND_HZ, MIN_VOICE_BAND_RATIO, MIN_VOICE_RATIO, HIGHPASS_HZ, PRE_ROLL_SEC, MAX_GAP_FILL_SEC, TARGET_PEAK, MAX_GAIN, DEBUG_DUMP_DIR, FRAME_SEC, BYTES_PER_FRAME, OPUS_SILENCE, _partial, _shared_we, we  # noqa: F401
from core.vc.transcription.debug import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, DebugMixin  # noqa: F401
from core.vc.transcription.dsp import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, _lowpass_taps, _LPF_TAPS, _spectrum_masks, _frame_features, _highpass, resample_48k_to_16k  # noqa: F401
from core.vc.transcription.restore import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, RestoreMixin  # noqa: F401
from core.vc.transcription.session import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, SessionMixin  # noqa: F401
from core.vc.transcription.sink import annotations, asyncio, functools, io, logging, os, threading, time, wave, deque, np, aiohttp, discord, commands, voice_recv, Responder, logfare, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, voice_connection_failed, add_receive_sink, remove_receive_sink, SpeechDetector, FAILED, LOADING, LOUPE, PAUSE, logger, TranscriptionSink  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class TranscriptionCog(SessionMixin, DebugMixin, RestoreMixin, commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)
        self._start_lock = asyncio.Lock()
        # サーバーごとの直近の発話 (表示名, 16kHz WAV, 時刻)。!sttdebug が使う
        self.last_audio: dict[int, tuple[str, bytes, float]] = {}

    async def cog_load(self):
        logger.info("文字起こしデバッグコマンド !sttdebug を登録しました")


async def setup(bot: commands.Bot):
    await bot.add_cog(TranscriptionCog(bot))
