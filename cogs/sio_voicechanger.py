from __future__ import annotations

import asyncio
import logging
import threading
import time
import numpy as np

import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv

from core.legacy import Responder
from core.voice_session import VoiceBusy, get_manager

logger = logging.getLogger(__name__)

# ============================================================
# 定数定義
# ============================================================
SAMPLE_RATE = 48000          # 48kHz
CHANNELS = 2                 # ステレオ
SAMPLE_WIDTH = 2             # 16bit = 2byte
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH
BYTES_PER_SECOND = SAMPLE_RATE * FRAME_SIZE
CHUNK_DURATION = 0.02        # 20ms
CHUNK_BYTES = int(CHUNK_DURATION * BYTES_PER_SECOND)  # 3840 bytes

OPUS_SILENCE = b"\xf8\xff\xfe"

# 20ms 超低遅延モードのデフォルト値
DEFAULT_TARGET_BUFFER_MS = 20.0   # 目標バッファ量 (20ms)
DEFAULT_MAX_BUFFER_MS = 40.0      # 上限バッファ量 (40msを超えたらトリム)
DEFAULT_FADE_MS = 5.0             # 接続時のクロスフェード長 (5ms)


def we(description: str | None = None, title: str | None = None) -> discord.Embed:
    return discord.Embed(title=title, description=description, color=0x3498DB)


# ============================================================
# 境界クロスフェード付き WSOLA ピッチシフター
# ============================================================
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


# ============================================================
# 無音待機 ＆ クロスフェード接続バッファ (目標 20ms)
# ============================================================
class WaitAndConnectAudioSource(discord.AudioSource):
    """
    データ不足（無音期間）発生時はフェードアウトして「次のデータが来るまで待機」し、
    20ms分のデータが溜まった瞬間にフェードインで滑らかに復帰するソース。
    """
    def __init__(
        self,
        target_buffer_ms: float = DEFAULT_TARGET_BUFFER_MS,
        max_buffer_ms: float = DEFAULT_MAX_BUFFER_MS,
        fade_ms: float = DEFAULT_FADE_MS,
        shifter: AdaptiveWSOLAPitchShifter = None,
    ) -> None:
        self._buffer = bytearray()
        self._lock = threading.Lock()

        self.target_buffer_ms = target_buffer_ms
        self.max_buffer_ms = max_buffer_ms

        self.target_prebuffer_bytes = self._ms_to_frame_bytes(target_buffer_ms)
        self.max_buffer_bytes = self._ms_to_frame_bytes(max_buffer_ms)

        fade_bytes = self._ms_to_frame_bytes(fade_ms)
        self._fade_frames = max(1, fade_bytes // FRAME_SIZE)

        self.is_waiting_for_data = True
        self.shifter = shifter

        self._last_out_tail = np.zeros((self._fade_frames, CHANNELS), dtype=np.float32)
        self._was_playing = False

        self.underrun_count = 0

    @staticmethod
    def _ms_to_frame_bytes(ms: float) -> int:
        raw = int((ms / 1000.0) * BYTES_PER_SECOND)
        return max(FRAME_SIZE, (raw // FRAME_SIZE) * FRAME_SIZE)

    def update_settings(self, target_buffer_ms: float | None = None, max_buffer_ms: float | None = None) -> None:
        with self._lock:
            if target_buffer_ms is not None:
                self.target_buffer_ms = target_buffer_ms
                self.target_prebuffer_bytes = self._ms_to_frame_bytes(target_buffer_ms)
            if max_buffer_ms is not None:
                self.max_buffer_ms = max_buffer_ms
                self.max_buffer_bytes = self._ms_to_frame_bytes(max_buffer_ms)

    def feed(self, pcm: bytes) -> None:
        with self._lock:
            self._buffer.extend(pcm)

            # 遅延が積み重なって max_buffer_ms (40ms) を超えた場合はトリムして遅延増加を防ぐ
            overflow = len(self._buffer) - self.max_buffer_bytes
            if overflow > 0:
                trim_bytes = (overflow // FRAME_SIZE) * FRAME_SIZE
                self._crossfade_trim(trim_bytes)

            # 無音待機中、20ms分データが復帰したら即座に再生再開（read側でフェードイン）
            if self.is_waiting_for_data and len(self._buffer) >= self.target_prebuffer_bytes:
                self.is_waiting_for_data = False

    def _crossfade_trim(self, trim_bytes: int) -> None:
        if trim_bytes <= 0:
            return

        fade_bytes = self._fade_frames * FRAME_SIZE
        fade_bytes = min(fade_bytes, trim_bytes, len(self._buffer) - trim_bytes)

        if fade_bytes <= 0:
            del self._buffer[:trim_bytes]
            return

        pre = np.frombuffer(
            bytes(self._buffer[trim_bytes - fade_bytes:trim_bytes]), dtype=np.int16
        ).astype(np.float32).reshape(-1, CHANNELS)
        post = np.frombuffer(
            bytes(self._buffer[trim_bytes:trim_bytes + fade_bytes]), dtype=np.int16
        ).astype(np.float32).reshape(-1, CHANNELS)

        n = min(len(pre), len(post))
        fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
        fade_out = 1.0 - fade_in
        blended = (pre[:n] * fade_out + post[:n] * fade_in).clip(-32768, 32767).astype(np.int16)

        del self._buffer[:trim_bytes]
        self._buffer[:blended.nbytes] = blended.tobytes()

    def read(self) -> bytes:
        with self._lock:
            # 正常再生時: 20ms分（CHUNK_BYTES）以上のバッファがある場合
            if not self.is_waiting_for_data and len(self._buffer) >= CHUNK_BYTES:
                chunk = bytes(self._buffer[:CHUNK_BYTES])
                del self._buffer[:CHUNK_BYTES]

                out = np.frombuffer(chunk, dtype=np.int16).astype(np.float32).reshape(-1, CHANNELS)

                if not self._was_playing:
                    # 無音待機状態からの復帰時: フェードインして「プチッ」音を防ぐ
                    n = min(self._fade_frames, out.shape[0])
                    fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
                    out[:n] = out[:n] * fade_in

                self._was_playing = True
                if out.shape[0] >= self._fade_frames:
                    self._last_out_tail = out[-self._fade_frames:].copy()
                else:
                    pad = self._fade_frames - out.shape[0]
                    self._last_out_tail = np.pad(out, ((pad, 0), (0, 0)))

                return out.astype(np.int16).tobytes()

            # データ不足時: 次のバッファが届くまで待機（無音を出力しつつフェードアウト処理）
            if self.shifter:
                self.shifter.mark_gap()

            silence = np.zeros((CHUNK_BYTES // FRAME_SIZE, CHANNELS), dtype=np.float32)

            if self._was_playing:
                # 音声再生から無音状態への突入時: 末尾をフェードアウト
                self.underrun_count += 1
                n = min(self._fade_frames, silence.shape[0])
                fade_out = np.linspace(1.0, 0.0, n, dtype=np.float32)[:, None]
                silence[:n] = self._last_out_tail[-n:] * fade_out

            self.is_waiting_for_data = True
            self._was_playing = False

            return silence.astype(np.int16).tobytes()

    @property
    def buffered_ms(self) -> float:
        with self._lock:
            return (len(self._buffer) / BYTES_PER_SECOND) * 1000.0

    def is_opus(self) -> bool:
        return False


# ============================================================
# 音声受信 & 変換 Sink
# ============================================================
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

        self.shifter = AdaptiveWSOLAPitchShifter(sample_rate=SAMPLE_RATE)
        self.audio_source = WaitAndConnectAudioSource(
            target_buffer_ms=DEFAULT_TARGET_BUFFER_MS,
            max_buffer_ms=DEFAULT_MAX_BUFFER_MS,
            fade_ms=DEFAULT_FADE_MS,
            shifter=self.shifter,
        )

        if self.vc and self.vc.is_connected():
            try:
                self.vc.play(self.audio_source)
            except Exception as e:
                logger.error("[VC_CHANGER] play() 開始失敗: %r", e)

    def set_semitones(self, semitones: float) -> None:
        with self._lock:
            self.semitones = float(semitones)

    def wants_opus(self) -> bool:
        return True

    def write(self, user, data: voice_recv.VoiceData) -> None:
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


# ============================================================
# ボイスチェンジャー Cog 本体
# ============================================================
class VoiceChangerCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.vc_sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)

    # --------------------------------------------------
    # 実装（/voice effects）
    # --------------------------------------------------
    async def _changer_impl(self, r: Responder, action: str, pitch: float | None = None,
                            buffer_ms: float | None = None, max_ms: float | None = None):
        """action: start / status / stop

        pitch・buffer_ms・max_ms を付けると、動作中ならその設定を変える（start でも status でも）。
        """
        guild_id = r.guild.id
        session = self.vc_sessions.get(guild_id)
        has_options = pitch is not None or buffer_ms is not None or max_ms is not None

        if action == "stop":
            if session is None:
                return await r.send(embed=we("⚠️ ボイスチェンジャーは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(guild_id, "changer", reason="stop"):
                self._cleanup(guild_id)("stop")
            return await r.send(embed=we("🛑 ボイスチェンジャーを停止しました。"))

        if action == "start" and session is None:
            return await self._start(r, pitch, buffer_ms, max_ms)

        if has_options:
            if session is None:
                return await r.send(embed=we("⚠️ ボイスチェンジャーが開始されていません。"), ephemeral=True)
            return await self._apply(r, session, pitch, buffer_ms, max_ms)

        if action == "start":
            return await r.send(embed=we(
                "⚠️ 既にボイスチェンジャーが実行中です。設定を変えるときは `pitch` や `buffer_ms` を付けてください。"
            ), ephemeral=True)
        await self._send_status(r, session)

    @staticmethod
    def _resolve_buffer(current_target: float, buffer_ms: float | None, max_ms: float | None):
        """(目標ms, 上限ms, エラー文) を返す。"""
        target = current_target if buffer_ms is None else buffer_ms
        if target < 20:
            return None, None, "⚠️ 目標バッファは20ms以上を指定してください。"
        resolved_max = max_ms if max_ms is not None else target * 2
        if resolved_max < target:
            return None, None, "⚠️ 上限バッファは目標バッファ以上にしてください。"
        return target, resolved_max, None

    async def _apply(self, r: Responder, session: dict, pitch, buffer_ms, max_ms):
        sink: VoiceChangerSink = session["sink"]
        lines = []
        if buffer_ms is not None or max_ms is not None:
            target, resolved_max, error = self._resolve_buffer(sink.audio_source.target_buffer_ms, buffer_ms, max_ms)
            if error:
                return await r.send(embed=we(error), ephemeral=True)
            sink.audio_source.update_settings(target_buffer_ms=target, max_buffer_ms=resolved_max)
            lines.append(f"📦 バッファ: 目標 `{target:.0f} ms` / 上限 `{resolved_max:.0f} ms`")
        if pitch is not None:
            sink.set_semitones(pitch)
            lines.append(f"<:music:1561710964238450809> ピッチ: `{pitch:+.1f}` 半音")
        await r.send(embed=we("🔧 ボイスチェンジャーの設定を変更しました。\n" + "\n".join(lines)))

    async def _send_status(self, r: Responder, session: dict | None):
        if session is None:
            return await r.send(embed=we("<:Pause:1561700510447312916> ボイスチェンジャー停止中 (`/voice のパネルからボイスチェンジャー開始` で開始)"))
        sink: VoiceChangerSink = session["sink"]
        src = sink.audio_source

        proc_ms = sink.last_proc_time_ms
        avg_ms = sink.avg_proc_time_ms
        buf_ms = src.buffered_ms
        total_est_delay = avg_ms + src.target_buffer_ms + 20.0

        await r.send(embed=we(
            f"🎙️ **ボイスチェンジャー動作中 (20ms低遅延・無音待機再同期モード)**\n"
            f"<:music:1561710964238450809> 設定ピッチ: `{sink.semitones:+.1f}` 半音\n\n"
            f"📊 **遅延ステータス (数値)**\n"
            f"├ <:thu:1563559478220038175> 変換処理時間: `{proc_ms:.2f} ms` (平均: `{avg_ms:.2f} ms`)\n"
            f"├ 📦 バッファ滞留量: `{buf_ms:.1f} ms`\n"
            f"├ 🎯 目標プリバッファ: `{src.target_buffer_ms:.0f} ms` / 上限: `{src.max_buffer_ms:.0f} ms`\n"
            f"├ ⚠️ アンダーラン(待機発生)回数: `{src.underrun_count}` 回\n"
            f"├ 🩹 パケットロス補完(PLC): `{sink.concealed_count}` 回 (ロスト検出: `{sink.lost_packet_count}` 回)\n"
            f"└ ⏱️ **推定トータル遅延**: `~{total_est_delay:.1f} ms`\n\n"
            f"・設定変更: `/voice のパネルからボイスチェンジャー状態 pitch:<半音数> buffer_ms:<目標ms> max_ms:<上限ms>`\n"
            f"・停止: `/voice のパネルからボイスチェンジャー停止`"
        ))

    async def _start(self, r: Responder, pitch, buffer_ms, max_ms):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we("⚠️ ボイスチャンネルに参加してから実行してください。"), ephemeral=True)
        pitch = 0.0 if pitch is None else pitch
        buffer = None
        if buffer_ms is not None or max_ms is not None:
            target, resolved_max, error = self._resolve_buffer(DEFAULT_TARGET_BUFFER_MS, buffer_ms, max_ms)
            if error:
                return await r.send(embed=we(error), ephemeral=True)
            buffer = (target, resolved_max)

        guild_id = r.guild.id
        target_channel = voice.channel
        await r.defer()

        # 別の機能が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, target_channel, "changer", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=True, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)), ephemeral=True)
        except Exception as e:
            return await r.send(embed=we(f"<:failed:1490986584676368535> ボイス接続に失敗しました: `{e}`"))

        sink = VoiceChangerSink(bot=self.bot, vc=vc, semitones=pitch)
        if buffer is not None:
            sink.audio_source.update_settings(target_buffer_ms=buffer[0], max_buffer_ms=buffer[1])
        vc.listen(sink)

        self.vc_sessions[guild_id] = {"sink": sink, "vc": vc}
        await r.send(embed=we(
            f"🎙️ **{target_channel.name}** でボイスチェンジャーを開始しました！\n"
            f"<:music:1561710964238450809> ピッチ: `{pitch:+.1f}` 半音\n"
            f"📦 プリバッファ: `{(buffer[0] if buffer else DEFAULT_TARGET_BUFFER_MS):.0f} ms` (超低遅延モード)\n"
            f"📊 `/voice のパネルからボイスチェンジャー状態` で遅延数値を確認できます。"
        ))

    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            session = self.vc_sessions.pop(guild_id, None)
            if not session:
                return
            vc = session["vc"]
            session["sink"].cleanup()
            try:
                vc.stop_listening()
                vc.stop()
            except Exception:
                pass
        return cleanup

async def setup(bot: commands.Bot):
    await bot.add_cog(VoiceChangerCog(bot))
