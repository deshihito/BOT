"""
Discord ボイスチャンネル録音 Cog

使用方法 (メインファイル側):
    await bot.load_extension("recording_cog")
    # または
    await bot.add_cog(RecordingCog(bot))

必要なライブラリ:
    pip install -U discord.py discord-ext-voice-recv davey
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
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
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed

logger = logging.getLogger(__name__)

# ============================================================
# 定数
# ============================================================
SAMPLE_RATE = 48000          # Discord の音声は 48kHz 固定
CHANNELS = 2                 # ステレオ
SAMPLE_WIDTH = 2             # 16bit = 2byte
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH          # 1サンプルフレーム = 4byte
BYTES_PER_SECOND = SAMPLE_RATE * FRAME_SIZE   # 192000 byte/s

# これより短い録音はノイズとみなして出力しない (0.2秒)
MIN_SAVE_BYTES = int(0.2 * BYTES_PER_SECOND)

# ステータスメッセージの更新間隔(秒)。Discord のレートリミット回避。
STATUS_UPDATE_INTERVAL = 5.0

# 録音の上限時間(秒)。PCM をメモリに溜め続けるので、これを超えたら自動で停止してファイルを送る。
RECORD_LIMIT_SECONDS = 30 * 60

# RTP タイムスタンプ由来の位置と壁時計由来の位置が離れた場合の再同期閾値
RESYNC_THRESHOLD_BYTES = 5 * BYTES_PER_SECOND

# voice_recv が無音パケットの代わりに流してくる Opus フレーム
OPUS_SILENCE = b"\xf8\xff\xfe"


def we(description: str | None = None, title: str | None = None) -> discord.Embed:
    """白色 embed を生成するヘルパー"""
    return discord.Embed(title=title, description=description, color=0xFFFFFF)


# ============================================================
# DAVE (Discord E2EE) 対応パッチ（本体は core.voice_recv_patch に集約）
# ============================================================
patch_voice_recv_client()

NOTE_NAMES_SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
NOTE_NAMES_FLAT  = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"]

def midi_to_freq(midi_num: int) -> float:
    return 440.0 * (2.0 ** ((midi_num - 69) / 12.0))

def freq_to_notes(freq: float) -> tuple[str, str, int] | None:
    if freq < 27.5 or freq > 4186.0:  # A0 〜 C8
        return None
    midi_num = int(round(69 + 12 * math.log2(freq / 440.0)))
    idx = midi_num % 12
    octave = (midi_num // 12) - 1
    return NOTE_NAMES_SHARP[idx] + str(octave), NOTE_NAMES_FLAT[idx] + str(octave), midi_num

def analyze_pitch_layers(pcm_bytes: bytes, top_k: int = 4) -> list[tuple[str, str, int]]:
    """PCMから複数音階（和音・倍音層）を検出"""
    if len(pcm_bytes) < 3840:
        return []
    audio_data = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    mono = audio_data[::2]
    windowed = mono * np.hamming(len(mono))
    fft_spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(mono), d=1.0 / 48000)

    max_val = np.max(fft_spectrum)
    if max_val < 500:
        return []

    peaks, _ = find_peaks(fft_spectrum, height=max_val * 0.18, distance=max(1, int(30 / (48000 / len(mono)))))
    if len(peaks) == 0:
        return []

    sorted_peaks = sorted(peaks, key=lambda p: fft_spectrum[p], reverse=True)[:top_k]
    results, seen_midi = [], set()
    for p in sorted_peaks:
        res = freq_to_notes(freqs[p])
        if res and res[2] not in seen_midi:
            seen_midi.add(res[2])
            results.append(res)
    return results

def format_notes(detected: list[tuple[str, str, int]]) -> list[str]:
    """analyze_pitch_layers の結果を「C♯4/D♭4」のような表記にする（同じなら片方だけ）。"""
    return [sharp if sharp == flat else f"{sharp}/{flat}" for sharp, flat, _midi in detected]


def synthesize_piano_chord(midi_list: list[int], duration_sec: float = 0.25) -> bytes:
    """検出MIDIからピアノ波形(PCM 16bit stereo 48kHz)を生成"""
    num_samples = int(48000 * duration_sec)
    t = np.linspace(0, duration_sec, num_samples, endpoint=False)
    mixed_signal = np.zeros(num_samples, dtype=np.float32)

    for midi_num in midi_list:
        f0 = midi_to_freq(midi_num)
        note_wave = np.sin(2 * np.pi * f0 * t) + 0.5 * np.sin(2 * np.pi * f0 * 2 * t) + 0.25 * np.sin(2 * np.pi * f0 * 3 * t)
        decay = np.exp(-6.0 * t) * np.minimum(t / 0.005, 1.0)
        mixed_signal += note_wave * decay

    if len(midi_list) > 0:
        mixed_signal /= math.sqrt(len(midi_list))

    audio_int16 = (mixed_signal * 12000).clip(-32768, 32767).astype(np.int16)
    return np.column_stack((audio_int16, audio_int16)).flatten().tobytes()
# ============================================================
# 録音 Sink
# ============================================================
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
            pass

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


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()

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

# ============================================================
# 録音 Cog 本体
# ============================================================
class RecordingCog(commands.Cog):
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

    # --------------------------------------------------
    # 実装（/voice studio・/voice studio）
    # --------------------------------------------------
    async def _record_impl(self, r: Responder, action: str):
        """action: start / stop / status / pitch"""
        if action == "start":
            return await self.start_command(r)
        if action == "stop":
            return await self.stop_command(r)
        if action == "pitch":
            return await self.pitch_command(r)
        return await self.status_command(r)

    async def pitch_command(self, r: Responder):
        """直近の音声からピアノ音階（単音/和音/声の倍音層）を解析する。"""
        session = self.sessions.get(r.guild.id)
        if not session:
            return await r.send(embed=we("⚠️ 現在録音中ではありません。`/voice のパネルから録音開始` で開始してください。"), ephemeral=True)

        sink: RecordingSink = session["sink"]
        audio_snapshot = sink.snapshot()
        if not audio_snapshot:
            return await r.send(embed=we("<:music:1561710964238450809> 音声データがまだ蓄積されていません。話してから実行してください。"), ephemeral=True)

        embed = discord.Embed(title="🎹 リアルタイム音階解析 (Pitch Detection)", color=0x3498DB)
        found_any = False
        for speaker_label, pcm in list(audio_snapshot.items())[:25]:
            # 直近 0.5 秒分のデータ（192000 * 0.5 = 96000 bytes）を取り出して解析
            recent_pcm = pcm[-96000:] if len(pcm) > 96000 else pcm
            detected = analyze_pitch_layers(recent_pcm, top_k=4)
            if detected:
                found_any = True
                notes_str = " / ".join(f"`{n}`" for n in format_notes(detected))
                embed.add_field(name=f"🎙️ {speaker_label}"[:256], value=f"検出音階（層）: {notes_str}"[:1024], inline=False)

        if not found_any:
            embed.description = "現在明確なピッチ（音階）は検出されませんでした。"
        await r.send(embed=embed)

    async def _echo_impl(self, r: Responder, action: str, delay: float | None = None):
        """action: start / delay / stop / status"""
        guild_id = r.guild.id
        if action == "start":
            return await self._echo_start(r, 2.0 if delay is None else delay)
        if action == "delay":
            session = self.echo_sessions.get(guild_id)
            if not session:
                return await r.send(embed=we("⚠️ 現在やまびこは実行されていません。"), ephemeral=True)
            if delay is None or delay <= 0:
                return await r.send(embed=we("⚠️ 遅延時間は 0 秒より大きく設定してください。"), ephemeral=True)
            session["sink"].set_echo_delay(delay)
            return await r.send(embed=we(f"⏱️ やまびこの遅延時間を `{delay}` 秒に変更しました。"))
        if action == "stop":
            if guild_id not in self.echo_sessions:
                return await r.send(embed=we("⚠️ 現在やまびこは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(guild_id, "echo", reason="stop"):
                self._echo_cleanup(guild_id)("stop")
            return await r.send(embed=we("🛑 やまびこを停止しました。"))
        session = self.echo_sessions.get(guild_id)
        if session:
            await r.send(embed=we(
                f"🗣️ **やまびこ動作中**\n"
                f"⏱️ 遅延時間: `{session['sink'].echo_delay}`秒\n"
                f"遅延変更: `/voice のパネルからやまびこ遅延変更 delay:<秒数>`\n"
                f"停止: `/voice のパネルからやまびこ停止`"
            ))
        else:
            await r.send(embed=we("<:Pause:1561700510447312916> やまびこ停止中 (`/voice のパネルからやまびこ開始` で開始)"))

    async def _echo_start(self, r: Responder, delay: float):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.echo_sessions:
            return await r.send(embed=we("⚠️ 既にやまびこが実行中です。"), ephemeral=True)
        if delay <= 0:
            return await r.send(embed=we("⚠️ 遅延時間は 0 秒より大きく設定してください。"), ephemeral=True)

        target_channel = voice.channel
        await r.defer()

        # 別の機能（録音・音楽など）が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, target_channel, "echo", r.user,
                cleanup=self._echo_cleanup(guild_id), text_channel=r.channel, force=True,
                timeout=30.0,      # DAVE暗号化応答待ちのためタイムアウトを延長
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)), ephemeral=True)
        except Exception as e:
            logger.error(f"VC Connection Error: {e}", exc_info=True)
            return await r.send(embed=we(voice_connection_failed(e)))

        # 統合 RecordingSink を is_echo=True でインスタンス化
        sink = RecordingSink(bot=self.bot, vc=vc, is_echo=True, echo_delay=delay)
        vc.listen(sink)

        self.echo_sessions[guild_id] = {
            "sink": sink, "vc": vc, "start": time.time()
        }
        await r.send(embed=we(
            f"🗣️ **{target_channel.name}** でやまびこを開始しました！\n"
            f"⏱️ 遅延時間: `{delay}`秒\n"
            f"遅延変更: `/voice のパネルからやまびこ遅延変更 delay:3.0` | 停止: `/voice のパネルからやまびこ停止`"
        ))

    def _echo_cleanup(self, guild_id: int):
        """VC を手放すとき（停止・切り替え・自動退出・外部切断）に呼ばれる後片付け。"""
        def cleanup(reason: str) -> None:
            session = self.echo_sessions.pop(guild_id, None)
            if not session:
                return
            vc = session["vc"]
            session["sink"].cleanup()
            try:
                vc.stop_listening()
            except Exception:
                pass
            try:
                vc.stop()
            except Exception:
                pass
        return cleanup
    # --------------------------------------------------
    # コマンド処理の実装
    # --------------------------------------------------
    async def start_command(self, r: Responder):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we(
                "⚠️ 既にこのサーバーで録音中です。`/voice のパネルから録音停止` で停止してください。"
            ), ephemeral=True)

        if not discord.opus.is_loaded():
            return await r.send(embed=we(
                "<:failed:1490986584676368535> Opus ライブラリがロードされていません。サーバーに libopus をインストールしてください。"
            ))

        target_channel = voice.channel
        await r.defer()

        # 別の機能（音楽・やまびこなど）が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, target_channel, "record", r.user,
                cleanup=self._record_cleanup(guild_id), text_channel=r.channel, force=True,
                timeout=30.0,      # DAVE暗号化応答待ちのためタイムアウトを延長
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)))
        except Exception as e:
            logger.error(f"VC Connection Error: {e}", exc_info=True)
            return await r.send(embed=we(voice_connection_failed(e)))

        try:
            if vc.is_listening():
                vc.stop_listening()
        except Exception:
            pass

        await asyncio.sleep(1.0)

        negotiated_mode = getattr(vc, "mode", "不明")
        dave_active = vc.dave_is_active() if hasattr(vc, "dave_is_active") else False
        dave_ready = vc.dave_is_ready() if hasattr(vc, "dave_is_ready") else dave_active

        if dave_active:
            dave_text = "有効" if dave_ready else "有効(鍵交換中)"
        else:
            dave_text = "無効"

        status_msg = await r.send(embed=we(
            f"🎙️ **{target_channel.name}** で録音を開始しました。\n"
            f"🔐 暗号化: `{negotiated_mode}` / DAVE(E2EE): `{dave_text}`\n"
            f"📦 受信パケット数: `0` 個\n"
            f"⏱️ 録音は最長 {RECORD_LIMIT_SECONDS // 60} 分です。超えると自動で停止してファイルを送ります。\n"
            f"停止するには `/voice のパネルから録音停止` を実行してください。"
        ), want_message=True)

        # 録音していることを、テキストチャンネルの全員に見える形で知らせる（Discord のポリシー）。
        await self._announce_recording(r, target_channel)

        # --------------------------------------------------
        # rec_start 内の on_packet_update (コールバック) を差し替え
        # --------------------------------------------------
        async def on_packet_update(count: int, notes: list[str]) -> None:
            try:
                notes_str = " / ".join([f"`{n}`" for n in notes]) if notes else "`解析中/発聲待機...`"
                await status_msg.edit(embed=we(
                    f"🔴 **リアルタイム音階演奏中...**\n"
                    f"🎙️ チャンネル: **{target_channel.name}**\n"
                    f"🎹 リアルタイム検出音階: {notes_str}\n"
                    f"📦 パケット数: `{count}` | 停止: `/voice のパネルから録音停止`"
                ))
            except Exception:
                pass

        sink = RecordingSink(bot=self.bot, vc=vc, update_callback=on_packet_update)

        try:
            vc.listen(sink)
        except Exception as e:
            await self.voice_sessions.release(guild_id, "record", reason="stop")
            return await r.send(embed=we(f"<:failed:1490986584676368535> 録音の開始に失敗しました: `{e}`"))

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "start": time.time(),
            "channel_name": target_channel.name,
            "status_msg": status_msg,
            "text_channel": r.channel,
            "guild": r.guild,
            "limit_task": asyncio.create_task(self._stop_at_limit(guild_id)),
        }

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

    def _record_cleanup(self, guild_id: int):
        """VC を手放すとき（停止・上限・切り替え・自動退出・外部切断）に呼ばれる後片付け。

        受信を止めて音声を取り出し、ファイルの送信は切断後に別タスクで行う。
        """
        async def cleanup(reason: str) -> None:
            session = self.sessions.pop(guild_id, None)
            if session is None:
                return
            task = session.get("limit_task")
            if task is not None and task is not asyncio.current_task() and not task.done():
                task.cancel()
            sink: RecordingSink = session["sink"]
            try:
                session["vc"].stop_listening()
            except Exception as e:
                logger.error("[REC] stop_listening error: %r", e)
            audio = sink.snapshot()
            sink.cleanup()
            self._deliveries[guild_id] = asyncio.create_task(self._deliver(session, audio, reason))
        return cleanup

    async def _announce_recording(self, r: Responder, voice_channel) -> None:
        """録音開始を、テキストチャンネルに（ephemeral ではなく）全員に見えるメッセージで知らせる。"""
        user = r.user
        mention = getattr(user, "mention", None) or getattr(user, "display_name", "だれか")
        try:
            await r.channel.send(
                f"🔴 **録音を開始しました**（開始: {mention}）\n"
                f"ボイスチャンネル **{voice_channel.name}** の音声が録音されます（最長 {RECORD_LIMIT_SECONDS // 60} 分）。"
                "録音されたくない人は退出してください。",
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception:
            logger.warning("[REC] 録音開始のお知らせを送れませんでした", exc_info=True)

    async def stop_command(self, r: Responder):
        guild_id = r.guild.id
        if guild_id not in self.sessions:
            return await r.send(embed=we("⚠️ 現在録音は行われていません。"), ephemeral=True)

        await r.defer()
        if not await self.voice_sessions.release(guild_id, "record", reason="stop"):
            await self._record_cleanup(guild_id)("stop")
        task = self._deliveries.get(guild_id)
        if task is not None:
            await task
        if r.is_interaction:
            await r.send(embed=we("🛑 録音を停止しました。ファイルはこのチャンネルに送りました。"))

    STOP_REASONS = {
        "stop": "💾 録音を停止しました",
        "time_limit": f"⏱️ 録音が上限の {RECORD_LIMIT_SECONDS // 60} 分に達したため自動で停止しました",
        "takeover": "💾 別の機能に切り替わったため録音を停止しました",
        "leave": "💾 /voice のパネルからVC退出 で退出したため録音を停止しました",
        "idle": "💾 ボイスチャンネルに誰もいなくなったため録音を停止しました",
        "disconnected": "💾 ボイスチャンネルから切断されたため録音を停止しました",
    }

    async def _deliver(self, session: dict, audio: dict[str, bytes], reason: str) -> None:
        """録音結果を、録音を始めたチャンネルへ送る。"""
        channel = session["text_channel"]
        sink: RecordingSink = session["sink"]
        elapsed = int(time.time() - session["start"])
        total = sink.total_frame_count
        dave_rate = (sink.dave_error_count / total * 100) if total else 0.0
        opus_rate = (sink.opus_error_count / total * 100) if total else 0.0
        headline = self.STOP_REASONS.get(reason, self.STOP_REASONS["stop"])
        try:
            await self._send_recording(channel, session["guild"], audio, elapsed, total, dave_rate, opus_rate, sink, headline)
        except Exception:
            logger.exception("[REC] 録音ファイルの送信に失敗しました")

    async def _send_recording(self, ctx, guild, audio, elapsed, total, dave_rate, opus_rate, sink, headline):
        await ctx.send(embed=we(
            f"{headline}（録音時間: `{self.format_time(elapsed)}`）。ファイルを生成中...\n"
            f"🩺 診断: write() `{sink.write_call_count}` / 有効フレーム `{total}` / "
            f"DAVE復号失敗 `{sink.dave_error_count}` (`{dave_rate:.1f}%`) / "
            f"Opusデコード失敗 `{sink.opus_error_count}` (`{opus_rate:.1f}%`)"
        ))

        if not audio:
            return await ctx.send(embed=we(
                "<:failed:1490986584676368535> 音声バッファが空でした。（発言が検知されなかったか、パケットが届いていません）"
            ))

        limit = getattr(guild, "filesize_limit", 8 * 1024 * 1024)
        if not isinstance(limit, int):
            limit = 8 * 1024 * 1024
        files, skipped = await self.build_files(audio, limit)

        if not files:
            note = "⚠️ 送信可能な録音データがありませんでした。"
            if skipped:
                note += "\n" + "\n".join(
                    f"・`{name}` はファイルサイズ超過 ({size / 1024 / 1024:.1f}MB) のため送信できません。"
                    for name, size in skipped
                )
            return await ctx.send(embed=we(note))

        for i in range(0, len(files), 10):
            chunk = files[i:i + 10]
            await ctx.send(
                content=f"<:music:1561710964238450809> **録音データ出力 ({i + 1}〜{i + len(chunk)}件 / 全{len(files)}件)**",
                files=chunk,
            )

        if skipped:
            await ctx.send(embed=we(
                "⚠️ 以下はサイズ超過のため送信できませんでした:\n" + "\n".join(
                    f"・`{name}` ({size / 1024 / 1024:.1f}MB)" for name, size in skipped
                )
            ))

    async def status_command(self, r: Responder):
        session = self.sessions.get(r.guild.id)

        if session:
            sink: RecordingSink = session["sink"]
            elapsed = int(time.time() - session["start"])
            embed = discord.Embed(
                title="🎙️ 録音中",
                description=(
                    f"チャンネル: **{session['channel_name']}**\n"
                    f"経過時間: **{self.format_time(elapsed)}**\n"
                    f"受信パケット数: **{sink.packet_count}** 個\n"
                    f"録音中の話者数: **{len(sink.buffers)}** 人"
                ),
                color=0x2ECC71,
            )
        else:
            embed = discord.Embed(
                title="<:Pause:1561700510447312916> 待機中",
                description=(
                    "現在このサーバーで録音は行われていません。\n"
                    "`/voice のパネルから録音開始` で開始できます。"
                ),
                color=0x95A5A6,
            )

        await r.send(embed=embed)



    # --------------------------------------------------
    # エンコード処理
    # --------------------------------------------------
    async def build_files(self, audio: dict[str, bytes], limit: int):
        stamp = int(time.time())
        files: list[discord.File] = []
        skipped: list[tuple[str, int]] = []

        for label in sorted(audio):
            pcm = audio[label]
            if len(pcm) < MIN_SAVE_BYTES:
                continue

            data, ext = await self.encode(pcm)
            if data is None:
                continue

            safe = re.sub(r'[\\/*?:"<>|\s]+', "_", label)[:60] or "speaker"

            if len(data) > limit:
                skipped.append((safe, len(data)))
                continue

            files.append(discord.File(io.BytesIO(data), filename=f"rec_{safe}_{stamp}.{ext}"))

        return files, skipped

    async def encode(self, pcm: bytes) -> tuple[bytes | None, str]:
        mp3 = await self.to_mp3(pcm)
        if mp3:
            return mp3, "mp3"

        loop = asyncio.get_running_loop()
        wav = await loop.run_in_executor(None, _pcm_to_wav, pcm)
        return wav, "wav"

    async def to_mp3(self, pcm: bytes) -> bytes | None:
        if self._ffmpeg_available is False:
            return None

        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-i", "pipe:0",
            "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "64k",
            "-f", "mp3", "pipe:1",
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            self._ffmpeg_available = False
            logger.warning("[REC] ffmpeg が見つからないため WAV で出力します。")
            return None
        except Exception as e:
            logger.warning("[REC] ffmpeg 起動失敗: %r", e)
            return None

        try:
            stdout, stderr = await proc.communicate(input=pcm)
        except Exception as e:
            logger.warning("[REC] ffmpeg 実行失敗: %r", e)
            return None

        if proc.returncode != 0 or not stdout:
            logger.warning(
                "[REC] ffmpeg 変換失敗 (rc=%s): %s",
                proc.returncode,
                stderr.decode("utf-8", errors="ignore")[:300],
            )
            return None

        self._ffmpeg_available = True
        return stdout

    @staticmethod
    def format_time(seconds: int) -> str:
        m, s = divmod(int(seconds), 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# ラズパイ等で Opus が手動ロードされていない場合に自動検出・読み込みを行う関数
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

# Cog登録時の setup 関数で実行
async def setup(bot: commands.Bot):
    ensure_opus()  # Cog追加前に Opus をロード
    await bot.add_cog(RecordingCog(bot))
