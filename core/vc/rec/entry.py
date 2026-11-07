from __future__ import annotations
import asyncio
import io
import logging
import re
import subprocess
import threading
import time
import wave
import ctypes.util
import math
import numpy as np
from scipy.signal import find_peaks
import collections
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.support.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.support.emojis import CLOCK, FAILED, MUSIC, PAUSE
from core.vc.rec.common import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, FRAME_SIZE, BYTES_PER_SECOND, MIN_SAVE_BYTES, STATUS_UPDATE_INTERVAL, RECORD_LIMIT_SECONDS, RESYNC_THRESHOLD_BYTES, OPUS_SILENCE, we, NOTE_NAMES_SHARP, NOTE_NAMES_FLAT  # noqa: F401
from core.vc.rec.deliver import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, _pcm_to_wav, DeliverMixin  # noqa: F401
from core.vc.rec.echo import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, EchoMixin  # noqa: F401
from core.vc.rec.pitch import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, midi_to_freq, freq_to_notes, analyze_pitch_layers, format_notes, PitchMixin  # noqa: F401
from core.vc.rec.restore import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, RestoreMixin  # noqa: F401
from core.vc.rec.session import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, SessionMixin  # noqa: F401
from core.vc.rec.sink import annotations, asyncio, io, logging, re, subprocess, threading, time, wave, ctypes, math, np, find_peaks, collections, discord, commands, voice_recv, Responder, vc_feature_restore, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, voice_connection_failed, CLOCK, FAILED, MUSIC, PAUSE, logger, RecordingSink, _EchoAudioSource  # noqa: F401

logger = logging.getLogger("cogs.sio_rec")


def ensure_opus():
    if discord.opus.is_loaded():
        return True

    # 1. OS標準のライブラリ検索
    opus_path = ctypes.util.find_library("opus")
    if opus_path:
        try:
            discord.opus.load_opus(opus_path)
            return True
        except Exception:
            pass

    # 2. ラズパイOS (ARM64 / ARM32 / x86_64) の一般的なパスを順番に試す
    possible_paths = [
        "libopus.so.0",
        "libopus.so",
        "/usr/lib/aarch64-linux-gnu/libopus.so.0",  # Raspberry Pi OS 64-bit
        "/usr/lib/arm-linux-gnueabihf/libopus.so.0", # Raspberry Pi OS 32-bit
        "/usr/lib/x86_64-linux-gnu/libopus.so.0",
    ]

    for path in possible_paths:
        try:
            discord.opus.load_opus(path)
            return True
        except Exception:
            continue

    return False


class RecordingCog(SessionMixin, PitchMixin, EchoMixin, RestoreMixin, DeliverMixin, commands.Cog):
    """ギルドごとの録音セッションを管理する Cog"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sessions: dict[int, dict] = {}
        self.echo_sessions: dict[int, dict] = {}
        self._ffmpeg_available: bool | None = None
        self.voice_sessions = get_manager(bot)
        # 録音停止後のファイル送信タスク（/voice studio の停止はこれを待ってから終わる）
        self._deliveries: dict[int, asyncio.Task] = {}

    async def cog_unload(self) -> None:
        """Cog アンロード時に全セッションを停止"""
        for guild_id in list(self.sessions):
            await self.voice_sessions.release(guild_id, "record", reason="stop")
        for guild_id in list(self.echo_sessions):
            await self.voice_sessions.release(guild_id, "echo", reason="stop")

    async def _stop_at_limit(self, guild_id: int) -> None:
        """上限時間に達したら録音を止めてファイルを送る。"""
        try:
            await asyncio.sleep(RECORD_LIMIT_SECONDS)
        except asyncio.CancelledError:
            return
        session = self.sessions.get(guild_id)
        if session is None:
            return
        session["limit_task"] = None  # 自分自身を cancel しないように外す
        if not await self.voice_sessions.release(guild_id, "record", reason="time_limit"):
            await self._record_cleanup(guild_id)("time_limit")
        task = self._deliveries.get(guild_id)
        if task is not None:
            await task


async def setup(bot: commands.Bot):
    ensure_opus()  # Cog追加前に Opus をロード
    await bot.add_cog(RecordingCog(bot))
