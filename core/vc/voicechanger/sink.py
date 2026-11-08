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
from core.vc.voicechanger.common import DEFAULT_FADE_MS, DEFAULT_MAX_BUFFER_MS, DEFAULT_TARGET_BUFFER_MS, OPUS_SILENCE, SAMPLE_RATE  # noqa: F401
from core.vc.voicechanger.shifter import AdaptiveWSOLAPitchShifter  # noqa: F401
from core.vc.voicechanger.source import WaitAndConnectAudioSource  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class VoiceChangerSink(voice_recv.AudioSink):
    def __init__(self, bot: commands.Bot, vc: voice_recv.VoiceRecvClient, semitones: float = 0.0):
        super().__init__()
        self.bot = bot
        self.vc = vc
        self.semitones = semitones
        self._lock = threading.Lock()
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self.opus_available = discord.opus.is_loaded()
        self._running = True

        self.last_proc_time_ms: float = 0.0
        self.avg_proc_time_ms: float = 0.0
        self.proc_count: int = 0

        self.lost_packet_count: int = 0
        self.concealed_count: int = 0
        self.error_count: int = 0
        self._play_error_count: int = 0
        self._watchdog_task = None

        self.shifter = AdaptiveWSOLAPitchShifter(sample_rate=SAMPLE_RATE)
        self.audio_source = WaitAndConnectAudioSource(
            target_buffer_ms=DEFAULT_TARGET_BUFFER_MS,
            max_buffer_ms=DEFAULT_MAX_BUFFER_MS,
            fade_ms=DEFAULT_FADE_MS,
            shifter=self.shifter,
        )

        self._ensure_playing()
        # play() が開始時に失敗しても後から復旧できるよう、再生を監視する
        try:
            self._watchdog_task = self.bot.loop.create_task(self._playback_watchdog())
        except Exception:
            logger.debug("[VC_CHANGER] 再生ウォッチドッグの起動に失敗", exc_info=True)

    @property
    def playback_active(self) -> bool:
        """変換音声の再生が実際に流れているか（状態表示用）。"""
        try:
            return bool(self.vc and self.vc.is_connected() and self.vc.is_playing())
        except Exception:
            return False

    def _ensure_playing(self) -> None:
        """再生が止まっていたら変換ソースを (再) 開始する（自己修復）。"""
        try:
            if self.vc and self.vc.is_connected() and not self.vc.is_playing():
                self.vc.play(self.audio_source)
        except Exception as e:
            self._play_error_count += 1
            if self._play_error_count <= 3 or self._play_error_count % 50 == 0:
                logger.error("[VC_CHANGER] play() 開始失敗 (%d回目): %r", self._play_error_count, e)

    async def _playback_watchdog(self) -> None:
        import asyncio

        while self._running:
            try:
                await asyncio.sleep(2.0)
                self._ensure_playing()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[VC_CHANGER] 再生ウォッチドッグでエラー（継続します）")

    def set_semitones(self, semitones: float) -> None:
        with self._lock:
            self.semitones = float(semitones)

    def wants_opus(self) -> bool:
        return True

    def write(self, user, data: voice_recv.VoiceData) -> None:
        # 1フレームの失敗で受信パイプライン全体を止めない（フレームを落として継続）
        try:
            self._write_inner(user, data)
        except Exception:
            self.error_count += 1
            if self.error_count <= 3 or self.error_count % 50 == 0:
                logger.exception("[VC_CHANGER] write 処理でエラー（%d回目、フレームを破棄）", self.error_count)

    def _write_inner(self, user, data: voice_recv.VoiceData) -> None:
        start_time = time.perf_counter()

        user_id = getattr(user, 'id', 0) if user else 0
        pcm = self._resolve_pcm(user_id, data)
        if not pcm:
            return

        with self._lock:
            current_pitch = self.semitones

        processed_pcm = self.shifter.process(pcm, current_pitch)
        self.audio_source.feed(processed_pcm)

        proc_time = (time.perf_counter() - start_time) * 1000.0
        self.last_proc_time_ms = proc_time
        self.proc_count += 1
        self.avg_proc_time_ms += (proc_time - self.avg_proc_time_ms) / min(self.proc_count, 50)

    def _resolve_pcm(self, user_id: int, data: voice_recv.VoiceData) -> bytes | None:
        raw_opus = getattr(data, 'opus', None)

        if raw_opus:
            pcm = self._decode_opus(user_id, bytes(raw_opus))
            if pcm:
                return pcm
            self.concealed_count += 1
            return self._conceal(user_id)

        self.lost_packet_count += 1
        self.concealed_count += 1
        return self._conceal(user_id)

    def _conceal(self, user_id: int) -> bytes | None:
        if not self.opus_available:
            return None

        decoder = self.decoders.get(user_id)
        if decoder is None:
            return None

        try:
            return decoder.decode(None, fec=False)
        except discord.opus.OpusError:
            return None

    def _decode_opus(self, user_id: int, raw_opus: bytes) -> bytes | None:
        if not self.opus_available:
            return None

        if raw_opus != OPUS_SILENCE and hasattr(self.vc, "dave_decrypt"):
            try:
                payload = self.vc.dave_decrypt(user_id, raw_opus)
            except Exception:
                return None
        else:
            payload = raw_opus

        if not payload:
            return None

        decoder = self.decoders.get(user_id)
        if decoder is None:
            decoder = discord.opus.Decoder()
            self.decoders[user_id] = decoder

        try:
            return decoder.decode(payload, fec=False)
        except discord.opus.OpusError:
            return None

    def cleanup(self) -> None:
        self._running = False
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            self._watchdog_task = None
