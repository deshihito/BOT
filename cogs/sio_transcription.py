from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
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
from core.voice_session import VoiceBusy, get_manager
from core.voice_media import add_receive_sink, remove_receive_sink

try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# ============================================================
# 定数設定
# ============================================================
DISCORD_SAMPLE_RATE = 48000  # Discord 音声 (48kHz)
TRANSCRIPTION_SAMPLE_RATE = 16000  # Logfareへ送る音声 (16kHz)
CHANNELS = 2
SAMPLE_WIDTH = 2
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH

# 無音判定の閾値（秒）
SILENCE_THRESHOLD_SEC = 0.8
MIN_UTTERANCE_SECONDS = 0.4
MAX_UTTERANCE_SECONDS = 20
# 音量判定の閾値（RMS値）
RMS_SILENCE_THRESHOLD = 300
# 発話として扱うために必要な「声のあるフレーム」数（1フレーム=20ms）。咳やクリックノイズ除外用
MIN_LOUD_FRAMES = 6
# 発話の頭が欠けないよう、発話開始の直前から付け足す音声（秒）
PRE_ROLL_SEC = 0.3
# パケットが届かなかった区間（DTX・ロス）を無音で埋める上限（秒）
MAX_GAP_FILL_SEC = 1.0
# 小さい声を持ち上げる（ピークがこの割合になるまで、最大 MAX_GAIN 倍）
TARGET_PEAK = 0.9
MAX_GAIN = 8.0
# 環境変数にディレクトリを入れると、Logfareへ送った音声をWAVで保存する（原因調査用）
DEBUG_DUMP_DIR = os.environ.get("STT_DEBUG_DIR")

FRAME_SEC = 0.02  # Discord の Opus 1フレーム

# voice_recv が無音時に渡してくる Opus パケット
OPUS_SILENCE = b"\xf8\xff\xfe"


def we(description: str | None = None, title: str | None = None) -> discord.Embed:
    return discord.Embed(title=title, description=description, color=0x2ECC71)


# ============================================================
# DAVE (Discord E2EE) 対応パッチ
# ============================================================
try:
    import davey  # type: ignore
except Exception:
    davey = None  # type: ignore[assignment]

_UNSET = object()
_media_type_audio = _UNSET


def _media_type_classes(session=None) -> list:
    found: list = []
    def _add(cls) -> None:
        if cls is not None and not any(cls is f for f in found):
            found.append(cls)

    if davey is not None:
        _add(getattr(davey, "MediaType", None))
    if session is not None:
        mod = sys.modules.get(type(session).__module__)
        if mod is not None:
            _add(getattr(mod, "MediaType", None))
    for name, mod in list(sys.modules.items()):
        if mod is None or "dave" not in name.lower():
            continue
        _add(getattr(mod, "MediaType", None))
    return found


def _media_type_candidates(session=None) -> list:
    candidates: list = []
    seen: set = set()
    def _add(value) -> None:
        if value is None:
            return
        key = (id(type(value)), repr(value))
        if key in seen:
            return
        seen.add(key)
        candidates.append(value)

    for cls in _media_type_classes(session):
        for attr in ("audio", "Audio", "AUDIO"):
            _add(getattr(cls, attr, None))
        try:
            _add(cls(0))
        except Exception:
            pass
    _add(0)
    return candidates


def _patch_voice_recv_client() -> None:
    vc_cls = voice_recv.VoiceRecvClient
    if getattr(vc_cls, "_dave_patch_applied", False):
        return
    vc_cls._dave_patch_applied = True

    def _get_dave_session(self):
        connection = getattr(self, "_connection", None)
        return getattr(connection, "dave_session", None) if connection else None

    def dave_is_active(self) -> bool:
        return _get_dave_session(self) is not None

    def dave_decrypt(self, user_id: int, data: bytes) -> bytes:
        global _media_type_audio
        session = _get_dave_session(self)
        if session is None:
            return data

        cached = _media_type_audio
        if cached is not _UNSET:
            try:
                return session.decrypt(user_id, cached, data)
            except TypeError:
                _media_type_audio = _UNSET

        last_error: Exception | None = None
        for candidate in _media_type_candidates(session):
            try:
                result = session.decrypt(user_id, candidate, data)
            except TypeError as e:
                last_error = e
                continue
            _media_type_audio = candidate
            return result

        try:
            return session.decrypt(user_id, data)
        except TypeError as e:
            last_error = e

        raise RuntimeError(f"DAVE decrypt 失敗: {last_error!r}")

    vc_cls.dave_is_active = dave_is_active
    vc_cls.dave_decrypt = dave_decrypt


_patch_voice_recv_client()


# ============================================================
# 音声リサンプル関数 (48kHz ステレオ -> 16kHz モノラル 16bit PCM)
# ============================================================
def _lowpass_taps(num_taps: int = 95, cutoff_hz: float = 7200.0, fs: float = DISCORD_SAMPLE_RATE) -> np.ndarray:
    """間引き前に折り返し雑音を消すための FIR ローパス（窓付き sinc）"""
    n = np.arange(num_taps) - (num_taps - 1) / 2
    h = np.sinc(2.0 * cutoff_hz / fs * n) * np.hamming(num_taps)
    return (h / h.sum()).astype(np.float32)


_LPF_TAPS = _lowpass_taps()


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

    # 小さい声はピークが TARGET_PEAK になるまで持ち上げる（持ち上げのみ、MAX_GAIN 倍まで）
    peak = float(np.max(np.abs(audio_16k))) if audio_16k.size else 0.0
    if peak > 0:
        gain = min(MAX_GAIN, TARGET_PEAK * 32767.0 / peak)
        if gain > 1.0:
            audio_16k = audio_16k * gain

    return np.clip(audio_16k, -32768, 32767).astype(np.int16).tobytes()


# ============================================================
# ユーザー別音声バッファ
# ============================================================
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

    def append(self, pcm_data: bytes, rtp_timestamp: int | None = None):
        audio_np = np.frombuffer(pcm_data, dtype=np.int16)
        if len(audio_np) == 0:
            return

        n_samples = len(audio_np) // CHANNELS
        missing = self._missing_samples(n_samples, rtp_timestamp)
        rms = float(np.sqrt(np.mean(audio_np.astype(np.float32) ** 2)))
        now = time.monotonic()
        loud = rms > RMS_SILENCE_THRESHOLD

        if not self.is_speaking:
            if not loud:
                if missing:
                    self.pre_roll.clear()  # 連続していない音声は頭出し用に使わない
                self.pre_roll.append(pcm_data)
                return
            # 発話開始: 直前の音声を付けて語頭が欠けないようにする
            self.is_speaking = True
            for chunk in self.pre_roll:
                self.buffer.extend(chunk)
            self.pre_roll.clear()
        elif missing:
            # 発話中にパケットが届かなかった時間は無音で埋め、実時間どおりの長さにする
            self.buffer.extend(bytes(missing * FRAME_SIZE))

        if loud:
            self.last_speech_time = now
            self.loud_frames += 1
        self.buffer.extend(pcm_data)

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
            return None

        pcm = bytes(self.buffer)
        loud_frames = self.loud_frames
        self.buffer.clear()
        self.is_speaking = False
        self.loud_frames = 0
        return pcm, loud_frames


# ============================================================
# Logfare 文字起こし AudioSink
# ============================================================
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
            if loud_frames < MIN_LOUD_FRAMES:
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


# ============================================================
# 文字起こし Cog 本体
# ============================================================
class TranscriptionCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)
        self._start_lock = asyncio.Lock()
        # サーバーごとの直近の発話 (表示名, 16kHz WAV, 時刻)。!sttdebug が使う
        self.last_audio: dict[int, tuple[str, bytes, float]] = {}

    async def cog_load(self):
        logger.info("文字起こしデバッグコマンド !sttdebug を登録しました")

    async def _get_or_create_webhook(self, channel: discord.TextChannel) -> discord.Webhook:
        webhooks = await channel.webhooks()
        for wh in webhooks:
            if wh.token:
                return wh

        return await channel.create_webhook(name="STT-Transcriber")

    # --------------------------------------------------
    # 実装（/voice studio）
    # --------------------------------------------------
    async def _transcribe_impl(self, r: Responder, action: str, target_channel: discord.TextChannel | None = None):
        """action: start / stop / status"""
        if action == "start":
            return await self._start(r, target_channel)
        if action == "stop":
            if r.guild.id not in self.sessions:
                return await r.send(embed=we("⚠️ 現在文字起こしは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(r.guild.id, "transcribe", reason="stop"):
                self._cleanup(r.guild.id)("stop")
            return await r.send(embed=we("🛑 文字起こしを停止しました。"))
        session = self.sessions.get(r.guild.id)
        if session:
            await r.send(embed=we(
                f"🎙️ **Logfare {logfare.TRANSCRIPTION_MODEL} 文字起こし実行中**\n"
                f"ボイスチャンネル: **{session['vc_channel_name']}**\n"
                f"送信先チャンネル: {session['target_channel_mention']}\n"
                f"停止コマンド: `/voice のパネルから文字起こし停止`"
            ))
        else:
            await r.send(embed=we("<:Pause:1561700510447312916> 文字起こし停止中 (`/voice のパネルから文字起こし開始` で開始)"))

    async def _start(self, r: Responder, target_channel: discord.TextChannel | None):
        async with self._start_lock:
            return await self._start_once(r, target_channel)

    async def _start_once(self, r: Responder, target_channel: discord.TextChannel | None):
        if not logfare.api_key():
            return await r.send(embed=we(
                "<:failed:1490986584676368535> `LOGFARE_API_KEY` が設定されていないため、文字起こしを開始できません。"
            ), ephemeral=True)
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we("⚠️ 先にボイスチャンネルに参加してから実行してください。"), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we("⚠️ 既に文字起こしが実行中です。"), ephemeral=True)

        vc_channel = voice.channel
        await r.defer()
        send_channel: discord.TextChannel = target_channel or r.channel

        # 共有対象の機能には同じ接続で合流する。競合時は先に拒否してから
        # webhook を作ることで、不要なAPI/Discord操作を避ける。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, vc_channel, "transcribe", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=False, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(
                f"⚠️ いまVCは **{busy.session.label}** が使用中です。先にその機能を停止してから文字起こしを開始してください。\n"
                "文字起こしは、実行中のVC機能を自動停止・切り替えしません。"
            ))
        except Exception as e:
            return await r.send(embed=we(f"<:failed:1490986584676368535> ボイス接続に失敗しました: `{e}`"))

        try:
            webhook = await self._get_or_create_webhook(send_channel)
        except discord.Forbidden:
            await self.voice_sessions.release(r.guild.id, "transcribe", reason="webhook-error")
            return await r.send(embed=we(f"<:failed:1490986584676368535> Botに {send_channel.mention} の `ウェブフックの管理 (Manage Webhooks)` 権限がありません。"))
        except Exception as e:
            await self.voice_sessions.release(r.guild.id, "transcribe", reason="webhook-error")
            return await r.send(embed=we(f"<:failed:1490986584676368535> Webhookの取得に失敗しました: `{e}`"))

        premium_notice_sent = False

        async def send_webhook(display_name: str, avatar_url: str | None, audio_wav: bytes):
            nonlocal premium_notice_sent
            self.last_audio[guild_id] = (display_name, audio_wav, time.time())
            try:
                text = await logfare.transcribe_audio(audio_wav)
            except logfare.LogfareHTTPError as ex:
                logger.warning("Logfare transcription API returned HTTP %s", ex.status)
                if ex.status == 403 and not premium_notice_sent:
                    premium_notice_sent = True
                    await r.channel.send(
                        "Logfareの文字起こしモデルが利用できません。モデルのトレーニング利用へのオプトインと、APIキーの利用権限を確認してください。"
                    )
                return
            except RuntimeError as ex:
                if "文字起こし結果がありません" in str(ex):
                    # 雑音・息・短すぎる発話などで認識結果が空だっただけ。エラー扱いにしない
                    logger.info("Logfare: 認識結果が空でした (user=%s)", display_name)
                else:
                    logger.exception("Logfare transcription request failed")
                return
            except Exception:
                logger.exception("Logfare transcription request failed")
                return
            if not text or not text.strip():
                return
            async with aiohttp.ClientSession() as session:
                wh_obj = discord.Webhook.from_url(webhook.url, session=session)
                try:
                    await wh_obj.send(
                        content=text,
                        username=display_name,
                        avatar_url=avatar_url
                    )
                except Exception as ex:
                    logger.error("[Webhook Send Error] %s", ex)

        sink = TranscriptionSink(
            bot=self.bot,
            vc=vc,
            callback_coro=send_webhook
        )
        add_receive_sink(vc, "transcribe", sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "vc_channel_name": vc_channel.name,
            "target_channel_mention": send_channel.mention
        }

        await r.send(embed=we(
            f"🎙️ **{vc_channel.name}** で Logfare {logfare.TRANSCRIPTION_MODEL} による文字起こしを開始しました。\n"
            f"音声は無音区間ごとにLogfareへ送信され、結果を {send_channel.mention} へ投稿します。\n"
            "音楽・GVC・読み上げと同時に利用できます。利用者の音声は外部サービスで処理されます。"
        ))

    # --------------------------------------------------
    # デバッグ: 言語指定の比較（誰でも実行可。スラッシュコマンドは増やさずプレフィックスで提供）
    # 1回で外部APIを8回呼ぶので、サーバーごとに30秒に1回までに制限している
    # --------------------------------------------------
    @commands.command(name="sttdebug")
    @commands.guild_only()
    @commands.cooldown(1, 30.0, commands.BucketType.guild)
    async def stt_debug(self, ctx: commands.Context, model: str | None = None):
        """`!sttdebug [モデル名]` 直近の文字起こし音声（またはWAV添付）を、言語指定の8パターンでLogfareに送って結果を比べる。"""
        audio: bytes | None = None
        source = ""
        for attachment in ctx.message.attachments:
            if attachment.filename.lower().endswith(".wav") and attachment.size <= 5 * 1024 * 1024:
                audio = await attachment.read()
                source = f"添付ファイル `{attachment.filename}`"
                break
        if audio is None and ctx.guild is not None:
            last = self.last_audio.get(ctx.guild.id)
            if last:
                name, audio, ts = last
                source = f"**{name}** の直近の発話（{int(time.time() - ts)}秒前）"
        if audio is None:
            return await ctx.send(embed=we(
                "⚠️ 調べる音声がありません。文字起こし中のVCで話してからもう一度実行するか、"
                "WAVファイル(5MBまで)を添付して `!sttdebug` を実行してください。"
            ))

        try:
            with wave.open(io.BytesIO(audio), "rb") as wav:
                channels, rate, width = wav.getnchannels(), wav.getframerate(), wav.getsampwidth()
                frames = wav.readframes(wav.getnframes())
                seconds = wav.getnframes() / rate
            fmt = f"{rate}Hz / {channels}ch / {width * 8}bit"
            if width == 2:
                samples = np.frombuffer(frames, dtype=np.int16)
                rms = int(np.sqrt(np.mean(samples.astype(np.float32) ** 2))) if len(samples) else 0
                peak = int(np.max(np.abs(samples.astype(np.int32)))) if len(samples) else 0
                stats = f"{seconds:.2f}秒 / {fmt} / rms={rms} / peak={peak}"
            else:
                stats = f"{seconds:.2f}秒 / {fmt}（16bitではないので音量は計測しません）"
        except Exception:
            stats = "WAVを解析できませんでした"

        used_model = (model or logfare.TRANSCRIPTION_MODEL).strip()
        async with ctx.typing():
            try:
                results = await logfare.probe_transcription_languages(audio, used_model)
            except Exception as e:
                logger.exception("sttdebug failed")
                return await ctx.send(embed=we(f"<:failed:1490986584676368535> 実行に失敗しました: `{e}`"))
            try:
                available = await logfare.fetch_transcription_models()
            except Exception:
                available = []

        lines = [f"`{label}`\n→ {outcome[:150]}" for label, outcome in results]
        models_line = (
            "Logfareの音声認識モデル候補: " + ", ".join(f"`{m}`" for m in available[:12])
            + "\n他のモデルを試すには `!sttdebug モデル名`"
            if available else "Logfareの音声認識モデル候補を取得できませんでした"
        )
        text = (
            f"<:loupe:1563559480069853245> **文字起こし言語指定テスト** — {used_model}\n"
            f"音声: {source}（{stats}）\n\n" + "\n".join(lines) + f"\n\n{models_line}"
        )
        try:
            await ctx.send(embed=we(text))
        except (discord.Forbidden, discord.HTTPException):
            # 「埋め込みリンク」権限が無いチャンネルでは埋め込みが表示されないので、普通のテキストで送り直す
            await ctx.send(text[:1900])

    @stt_debug.error
    async def stt_debug_error(self, ctx: commands.Context, error: commands.CommandError):
        """失敗しても必ず何か返す（以前は無言になるだけだった）。"""
        if isinstance(error, commands.CommandOnCooldown):
            message = f"⏳ `!sttdebug` は続けて実行できません。{error.retry_after:.0f}秒後にもう一度お試しください。"
        elif isinstance(error, commands.NoPrivateMessage):
            message = "⚠️ `!sttdebug` はサーバーのテキストチャンネルで実行してください。"
        else:
            logger.error("sttdebug でエラー", exc_info=error)
            message = f"⚠️ `!sttdebug` でエラーが発生しました: `{error!r}`"[:1900]
        try:
            await ctx.send(message)
        except Exception:
            logger.exception("sttdebug のエラー通知を送れませんでした")

    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            self.last_audio.pop(guild_id, None)
            session = self.sessions.pop(guild_id, None)
            if not session:
                return
            remove_receive_sink(session["vc"], "transcribe")
        return cleanup


async def setup(bot: commands.Bot):
    await bot.add_cog(TranscriptionCog(bot))
