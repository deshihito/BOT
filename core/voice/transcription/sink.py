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
from core import vc_feature_restore
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import voice_connection_failed
from core.voice_media import add_receive_sink, remove_receive_sink
from core.speech_vad import SpeechDetector
from core.emojis import FAILED, LOADING, LOUPE, PAUSE
try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

from core.voice.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.transcription.buffer import UserAudioBuffer  # noqa: F401
from core.voice.transcription.common import BYTES_PER_FRAME, DEBUG_DUMP_DIR, MIN_LOUD_FRAMES, MIN_UTTERANCE_SECONDS, MIN_VOICE_RATIO, OPUS_SILENCE, SAMPLE_WIDTH, TRANSCRIPTION_SAMPLE_RATE  # noqa: F401
from core.voice.transcription.dsp import resample_48k_to_16k  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class TranscriptionSink(voice_recv.AudioSink):
    def __init__(
        self,
        bot: commands.Bot,
        vc: voice_recv.VoiceRecvClient,
        callback_coro
    ):
        super().__init__()
        self.bot = bot
        self.vc = vc
        self.callback_coro = callback_coro

        self.user_buffers: dict[int, UserAudioBuffer] = {}
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self._lock = threading.Lock()
        self.opus_available = discord.opus.is_loaded()
        self._running = True
        self._decrypt_failures = 0
        self._decode_failures = 0

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

        rtp_timestamp = getattr(getattr(data, 'packet', None), 'timestamp', None)

        with self._lock:
            if user_id not in self.user_buffers:
                self.user_buffers[user_id] = UserAudioBuffer(user_id, display_name, avatar_url)
            self.user_buffers[user_id].append(pcm, rtp_timestamp)

    def _decode_opus(self, user_id: int, raw_opus: bytes) -> bytes | None:
        if not self.opus_available:
            return None

        if raw_opus != OPUS_SILENCE:
            try:
                payload = self.vc.dave_decrypt(user_id, raw_opus)
            except Exception as e:
                self._decrypt_failures += 1
                n = self._decrypt_failures
                if n in (1, 10, 100) or n % 1000 == 0:
                    logger.warning("DAVE 復号に失敗しました (累計 %d 件): %r", n, e)
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
        except discord.opus.OpusError as e:
            self._decode_failures += 1
            n = self._decode_failures
            if n in (1, 10, 100) or n % 1000 == 0:
                logger.warning("Opus デコードに失敗しました (累計 %d 件): %r", n, e)
            return None

    def _monitor_loop(self):
        while self._running:
            time.sleep(0.1)
            ready: list[tuple[str, str | None, bytes, int]] = []
            # ロックは「取り出すだけ」にする。重い変換中に write() をブロックすると受信が詰まり音が欠ける
            with self._lock:
                for ubuf in list(self.user_buffers.values()):
                    if ubuf.should_transcribe():
                        item = ubuf.pop_audio()
                        if item:
                            ready.append((ubuf.display_name, ubuf.avatar_url, item[0], item[1]))
            for display_name, avatar_url, pcm_48k, loud_frames in ready:
                threading.Thread(
                    target=self._run_transcription,
                    args=(display_name, avatar_url, pcm_48k, loud_frames),
                    daemon=True,
                ).start()

    def _run_transcription(self, display_name: str, avatar_url: str | None, pcm_48k: bytes, loud_frames: int):
        try:
            total_frames = len(pcm_48k) / BYTES_PER_FRAME
            if loud_frames < MIN_LOUD_FRAMES or loud_frames < total_frames * MIN_VOICE_RATIO:
                logger.debug(
                    "[STT] %s: 雑音として破棄 声フレーム=%d / 全体=%.0f",
                    display_name, loud_frames, total_frames,
                )
                return
            pcm_16k = resample_48k_to_16k(pcm_48k)
            if len(pcm_16k) < TRANSCRIPTION_SAMPLE_RATE * SAMPLE_WIDTH * MIN_UTTERANCE_SECONDS:
                return

            samples = np.frombuffer(pcm_16k, dtype=np.int16)
            logger.info(
                "[STT] %s: %.2f秒 rms=%d peak=%d 声フレーム=%d",
                display_name,
                len(samples) / TRANSCRIPTION_SAMPLE_RATE,
                int(np.sqrt(np.mean(samples.astype(np.float32) ** 2))),
                int(np.max(np.abs(samples.astype(np.int32)))),
                loud_frames,
            )

            audio_file = io.BytesIO()
            with wave.open(audio_file, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(SAMPLE_WIDTH)
                wav.setframerate(TRANSCRIPTION_SAMPLE_RATE)
                wav.writeframes(pcm_16k)
            wav_bytes = audio_file.getvalue()

            if DEBUG_DUMP_DIR:
                try:
                    os.makedirs(DEBUG_DUMP_DIR, exist_ok=True)
                    path = os.path.join(DEBUG_DUMP_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-{abs(hash(display_name)) % 10000:04d}.wav")
                    with open(path, "wb") as f:
                        f.write(wav_bytes)
                except Exception:
                    logger.exception("デバッグ用WAVの保存に失敗しました")

            future = asyncio.run_coroutine_threadsafe(
                self.callback_coro(display_name, avatar_url, wav_bytes),
                self.bot.loop,
            )
            future.add_done_callback(self._log_transcription_error)
        except Exception as e:
            logger.exception("[Logfare transcription error] %s", e)

    @staticmethod
    def _log_transcription_error(future):
        try:
            future.result()
        except Exception:
            logger.exception("Logfare 文字起こし処理に失敗しました")

    def cleanup(self):
        self._running = False
