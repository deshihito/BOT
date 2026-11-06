from __future__ import annotations
import asyncio
import json
import logging
import os
import threading
import time
import re
from difflib import SequenceMatcher
import numpy as np
import aiohttp
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.vosk_model import ensure_model
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED
from core.emojis import FAILED, MUSIC
try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    Model = None
    KaldiRecognizer = None

from core.vc.karaoke.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.karaoke.common import OPUS_SILENCE, RMS_SILENCE_THRESHOLD, SILENCE_THRESHOLD_SEC, VOSK_SAMPLE_RATE  # noqa: F401
from core.vc.karaoke.dsp import resample_48k_to_16k  # noqa: F401

logger = logging.getLogger("cogs.sio_karaoke")


class KaraokeSink(voice_recv.AudioSink):
    def __init__(self, bot: commands.Bot, vc: voice_recv.VoiceRecvClient, vosk_model: Model, callback_coro):
        super().__init__()
        self.bot = bot
        self.vc = vc
        self.vosk_model = vosk_model
        self.callback_coro = callback_coro
        self.user_buffers: dict[int, dict] = {}
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self._lock = threading.Lock()
        self.opus_available = discord.opus.is_loaded()
        self._running = True

        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()

    def wants_opus(self) -> bool:
        return True

    def write(self, user, data: voice_recv.VoiceData) -> None:
        raw_opus = getattr(data, 'opus', None)
        if not raw_opus:
            return

        user_id = getattr(user, 'id', 0) if user else 0
        display_name = getattr(user, 'display_name', None) or getattr(user, 'name', f"User_{user_id}")
        avatar_url = str(user.display_avatar.url) if user and hasattr(user, 'display_avatar') else None

        if user_id == 0:
            return

        pcm = self._decode_opus(user_id, bytes(raw_opus))
        if not pcm:
            return

        with self._lock:
            if user_id not in self.user_buffers:
                self.user_buffers[user_id] = {
                    "display_name": display_name,
                    "avatar_url": avatar_url,
                    "buffer": bytearray(),
                    "last_speech": time.time(),
                    "is_speaking": False,
                    "history": []  # 認識された歌詞の履歴
                }
            
            ubuf = self.user_buffers[user_id]
            audio_np = np.frombuffer(pcm, dtype=np.int16)
            rms = np.sqrt(np.mean(audio_np.astype(np.float32) ** 2)) if len(audio_np) > 0 else 0

            if rms > RMS_SILENCE_THRESHOLD:
                ubuf["is_speaking"] = True
                ubuf["last_speech"] = time.time()
                ubuf["buffer"].extend(pcm)
            elif ubuf["is_speaking"]:
                ubuf["buffer"].extend(pcm)

    def _decode_opus(self, user_id: int, raw_opus: bytes) -> bytes | None:
        if not self.opus_available:
            return None
        payload = self.vc.dave_decrypt(user_id, raw_opus) if raw_opus != OPUS_SILENCE else raw_opus
        if not payload:
            return None
        decoder = self.decoders.setdefault(user_id, discord.opus.Decoder())
        try:
            return decoder.decode(payload, fec=False)
        except discord.opus.OpusError:
            return None

    def _monitor_loop(self):
        while self._running:
            time.sleep(0.15)
            with self._lock:
                for user_id, ubuf in list(self.user_buffers.items()):
                    if ubuf["is_speaking"] and (time.time() - ubuf["last_speech"] > SILENCE_THRESHOLD_SEC):
                        if len(ubuf["buffer"]) > 0:
                            pcm = bytes(ubuf["buffer"])
                            ubuf["buffer"].clear()
                            ubuf["is_speaking"] = False
                            
                            pcm_16k = resample_48k_to_16k(pcm)
                            if len(pcm_16k) > VOSK_SAMPLE_RATE * 2 * 0.3:
                                threading.Thread(
                                    target=self._run_vosk,
                                    args=(user_id, ubuf["display_name"], ubuf["avatar_url"], pcm_16k),
                                    daemon=True
                                ).start()

    def _run_vosk(self, user_id: int, display_name: str, avatar_url: str | None, pcm_16k: bytes):
        try:
            rec = KaldiRecognizer(self.vosk_model, VOSK_SAMPLE_RATE)
            rec.AcceptWaveform(pcm_16k)
            result = json.loads(rec.FinalResult())
            text = result.get("text", "").replace(" ", "").strip()

            if text:
                with self._lock:
                    if user_id in self.user_buffers:
                        self.user_buffers[user_id]["history"].append(text)

                asyncio.run_coroutine_threadsafe(
                    self.callback_coro(display_name, avatar_url, text),
                    self.bot.loop
                )
        except Exception as e:
            logger.error(f"[Karaoke Vosk Error] {e}")

    def cleanup(self):
        self._running = False
