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
from core.legacy import Responder
from core.voice import vc_feature_restore
from core.voice.voice_session import VoiceBusy, get_manager
from core.voice.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE

from core.voice.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.rec.common import BYTES_PER_SECOND, FRAME_SIZE, OPUS_SILENCE, RESYNC_THRESHOLD_BYTES, STATUS_UPDATE_INTERVAL  # noqa: F401

logger = logging.getLogger("cogs.sio_rec")


class RecordingSink(voice_recv.AudioSink):
    """途切れ・勝手な退出を防止した軽量統合 AudioSink"""

    def __init__(
        self,
        bot: commands.Bot,
        vc: voice_recv.VoiceRecvClient,
        update_callback=None,
        is_echo: bool = False,
        echo_delay: float = 2.0
    ):
        super().__init__()
        self.bot = bot
        self.vc = vc
        self.update_callback = update_callback
        self.is_echo = is_echo
        self.echo_delay = float(echo_delay)
        self.buffers: dict[str, bytearray] = {}
        self.packet_queue: collections.deque = collections.deque()
        self.packet_count = 0
        self._running = True

        # (前回追加した _lock, labels, decoders 等はそのまま維持)

        self.echo_source: _EchoAudioSource | None = None
        if self.is_echo:
            self.echo_source = _EchoAudioSource()
            if self.vc and self.vc.is_connected():
                try:
                    self.vc.play(self.echo_source)
                except Exception as e:
                    logger.error("[ECHO] play() 開始失敗: %r", e)
            self.bot.loop.create_task(self._echo_loop())
        # ↓ここから追加
        self._lock = threading.Lock()
        self.labels: dict = {}
        self.decoders: dict = {}
        self.opus_available = discord.opus.is_loaded()
        self.manual_decode = True
        self.dave_error_count = 0
        self.opus_error_count = 0
        self.total_frame_count = 0
        self.write_call_count = 0
        # ↑ここまで追加

        if self.is_echo:
            self.bot.loop.create_task(self._echo_loop())
    def set_echo_delay(self, delay: float) -> None:
        self.echo_delay = float(delay)

    def wants_opus(self) -> bool:
        # DAVE(E2EE)環境下では voice_recv の自動PCMデコードが機能しないため、
        # 生のOpusを受け取り、DAVE復号 → Opusデコードを自前で行う
        return True

    def write(self, user, data: voice_recv.VoiceData) -> None:
        """高速に処理を終わらせる (絶対ブロックしない)"""
        raw_opus = getattr(data, 'opus', None)
        if not raw_opus:
            return
        raw_opus = bytes(raw_opus)

        self.write_call_count += 1

        user_id = getattr(user, 'id', 0) if user else 0
        user_key = getattr(user, 'name', None) or f"Speaker_{user_id}"

        pcm = self._decode_opus(user_key, user_id, raw_opus)
        if not pcm:
            return

        self.total_frame_count += 1
        now = time.time()
        self.packet_count += 1

        with self._lock:
            if user_key not in self.buffers:
                self.buffers[user_key] = bytearray()
            self.buffers[user_key].extend(pcm)

        if self.is_echo:
            self.packet_queue.append((now + self.echo_delay, pcm))

    async def _echo_loop(self) -> None:
        """時間が来た音声データを連続再生ソースへ供給するだけのループ"""
        while self._running:
            await asyncio.sleep(0.01)
            if not self.packet_queue:
                continue
            now = time.time()
            while self.packet_queue and self.packet_queue[0][0] <= now:
                _, pcm_to_play = self.packet_queue.popleft()
                if self.echo_source is not None:
                    self.echo_source.feed(pcm_to_play)

    def cleanup(self) -> None:
        self._running = False
        self.packet_queue.clear()

    def snapshot(self) -> dict[str, bytes]:
        return {k: bytes(v) for k, v in self.buffers.items()}
    def _write_inner(self, user, data) -> None:
        self.write_call_count += 1
        key, label, user_id = self._identify(user, data)

        pcm = getattr(data, "pcm", None)
        if self.manual_decode or not pcm:
            raw_opus = getattr(data, "opus", None)
            if not raw_opus:
                return
            pcm = self._decode_opus(key, user_id, bytes(raw_opus))
            if not pcm:
                return

        if not pcm:
            return

        self.total_frame_count += 1
        now = time.perf_counter()
        position = self._resolve_position(key, data, now)
        self._store(key, label, position, pcm)

        self.packet_count += 1

        # ★ やまびこモードが有効な場合はキューに追加して再生処理
        if self.is_echo:
            play_at = time.time() + self.echo_delay
            self.packet_queue.append((play_at, pcm))
            self._process_echo()

        self._maybe_notify(now)

    def _process_echo(self) -> None:
        """再生予定時刻（遅延時間）を過ぎたパケットを VC へ再生"""
        if not self.packet_queue:
            return

        now = time.time()
        play_at, pcm_to_play = self.packet_queue[0]

        if now >= play_at:
            self.packet_queue.pop(0)
            if self.vc and self.vc.is_connected() and not self.vc.is_playing():
                audio_source = discord.PCMAudio(io.BytesIO(pcm_to_play))
                self.vc.play(audio_source)

    def _identify(self, user, data) -> tuple[int, str, int]:
        if user is not None:
            name = getattr(user, "display_name", None) or getattr(user, "name", "user")
            return user.id, f"{name}_{user.id}", user.id

        packet = getattr(data, "packet", None)
        ssrc = getattr(packet, "ssrc", None) or getattr(data, "ssrc", None)
        if ssrc:
            return int(ssrc), f"Speaker_{ssrc}", int(ssrc)

        return 0, "Unknown_Speaker", 0

    def _decode_opus(self, key: int, user_id: int, raw_opus: bytes) -> bytes | None:
        if not self.opus_available:
            return None

        if self.manual_decode and raw_opus != OPUS_SILENCE:
            try:
                payload = self.vc.dave_decrypt(user_id, raw_opus)
            except Exception as e:
                self.dave_error_count += 1
                if self.dave_error_count <= 3:
                    logger.error("[REC] DAVE decrypt 失敗 (key=%s): %r", key, e)
                return None
        else:
            payload = raw_opus

        if not payload:
            return None

        decoder = self.decoders.get(key)
        if decoder is None:
            decoder = discord.opus.Decoder()
            self.decoders[key] = decoder

        try:
            return decoder.decode(payload, fec=False)
        except discord.opus.OpusError as e:
            self.opus_error_count += 1
            if self.opus_error_count <= 3:
                logger.debug("[REC] Opus decode スキップ (key=%s): %s", key, e)
            return None

    def _resolve_position(self, key: int, data, now: float) -> int:
        wall_pos = int((now - self.start_time) * BYTES_PER_SECOND)
        wall_pos -= wall_pos % FRAME_SIZE
        wall_pos = max(0, wall_pos)

        packet = getattr(data, "packet", None)
        ts = getattr(packet, "timestamp", None)

        if key not in self._base_offset:
            self._base_offset[key] = wall_pos
            self._first_ts[key] = int(ts) if ts is not None else None
            return wall_pos

        first_ts = self._first_ts.get(key)
        if ts is None or first_ts is None:
            return wall_pos

        delta = (int(ts) - first_ts) & 0xFFFFFFFF
        if delta >= 0x80000000:
            delta = 0

        pos = self._base_offset[key] + delta * FRAME_SIZE

        if abs(pos - wall_pos) > RESYNC_THRESHOLD_BYTES:
            self._base_offset[key] = wall_pos
            self._first_ts[key] = int(ts)
            return wall_pos

        return max(0, pos)

    def _store(self, key: int, label: str, position: int, pcm: bytes) -> None:
        position -= position % FRAME_SIZE
        with self._lock:
            buf = self.buffers.get(key)
            if buf is None:
                buf = bytearray()
                self.buffers[key] = buf
                self.labels[key] = label

            end = position + len(pcm)
            if position >= len(buf):
                buf.extend(b"\x00" * (position - len(buf)))
                buf.extend(pcm)
            else:
                if end > len(buf):
                    buf.extend(b"\x00" * (end - len(buf)))
                buf[position:end] = pcm

    def _maybe_notify(self, now: float) -> None:
        if not self.update_callback:
            return
        if now - self._last_update_time < STATUS_UPDATE_INTERVAL:
            return
        self._last_update_time = now
        try:
            asyncio.run_coroutine_threadsafe(
                self.update_callback(self.packet_count), self.bot.loop
            )
        except Exception:
            logger.debug("録音: ステータス更新コールバックの呼び出しに失敗しました", exc_info=True)

    def snapshot(self) -> dict[str, bytes]:
        with self._lock:
            data = {self.labels.get(k, str(k)): bytes(v) for k, v in self.buffers.items()}

        if not data:
            return {}

        total = max(len(v) for v in data.values())
        total -= total % FRAME_SIZE

        result: dict[str, bytes] = {}
        for name, pcm in data.items():
            if len(pcm) < total:
                pcm = pcm + b"\x00" * (total - len(pcm))
            result[name] = pcm[:total]
        return result


class _EchoAudioSource(discord.AudioSource):
    """やまびこ用の連続再生ソース。
    パケット単位でplay()を呼び直すのではなく、これを一度だけplay()し、
    read()が20msごとにポーリングされ続ける形にすることで音切れを防ぐ。"""

    CHUNK_BYTES = int(0.02 * BYTES_PER_SECOND)  # 20ms分 = 3840byte

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._lock = threading.Lock()

    def feed(self, pcm: bytes) -> None:
        with self._lock:
            self._buffer.extend(pcm)

    def read(self) -> bytes:
        with self._lock:
            if len(self._buffer) >= self.CHUNK_BYTES:
                chunk = bytes(self._buffer[:self.CHUNK_BYTES])
                del self._buffer[:self.CHUNK_BYTES]
                return chunk
        # データが足りなくても無音を返して再生ループ自体は止めない(EOF扱いにしない)
        return b"\x00" * self.CHUNK_BYTES

    def is_opus(self) -> bool:
        return False
