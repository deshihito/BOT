from __future__ import annotations

import asyncio
import io
import logging
import sys
import threading
import time
import wave
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
RMS_SILENCE_THRESHOLD = 400

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
def resample_48k_to_16k(pcm_data: bytes) -> bytes:
    """PCMバイナリを高速に 16kHz モノラル 16bit PCM に変換"""
    audio_16bit = np.frombuffer(pcm_data, dtype=np.int16)
    if len(audio_16bit) == 0:
        return b""

    # ステレオ -> モノラル
    audio_stereo = audio_16bit.reshape(-1, CHANNELS)
    audio_mono = audio_stereo.mean(axis=1)

    # 48kHz -> 16kHz (3:1 スライスダウンサンプリングで超軽量化)
    audio_16k = audio_mono[::3].astype(np.int16)
    return audio_16k.tobytes()


# ============================================================
# ユーザー別音声バッファ
# ============================================================
class UserAudioBuffer:
    def __init__(self, user_id: int, display_name: str, avatar_url: str | None = None):
        self.user_id = user_id
        self.display_name = display_name
        self.avatar_url = avatar_url
        self.buffer = bytearray()
        self.last_speech_time = time.time()
        self.is_speaking = False

    def append(self, pcm_data: bytes):
        audio_np = np.frombuffer(pcm_data, dtype=np.int16)
        if len(audio_np) == 0:
            return

        rms = np.sqrt(np.mean(audio_np.astype(np.float32) ** 2))

        if rms > RMS_SILENCE_THRESHOLD:
            self.is_speaking = True
            self.last_speech_time = time.time()
            self.buffer.extend(pcm_data)
        elif self.is_speaking:
            self.buffer.extend(pcm_data)

    def should_transcribe(self) -> bool:
        if self.is_speaking and (
            time.time() - self.last_speech_time > SILENCE_THRESHOLD_SEC
            or len(self.buffer) >= DISCORD_SAMPLE_RATE * FRAME_SIZE * MAX_UTTERANCE_SECONDS
        ):
            return len(self.buffer) > 0
        return False

    def pop_audio_for_transcription(self) -> bytes | None:
        if len(self.buffer) == 0:
            return None

        pcm = bytes(self.buffer)
        self.buffer.clear()
        self.is_speaking = False

        return resample_48k_to_16k(pcm)


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
                self.user_buffers[user_id] = UserAudioBuffer(user_id, display_name, avatar_url)
            self.user_buffers[user_id].append(pcm)

    def _decode_opus(self, user_id: int, raw_opus: bytes) -> bytes | None:
        if not self.opus_available:
            return None

        if raw_opus != OPUS_SILENCE:
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

    def _monitor_loop(self):
        while self._running:
            time.sleep(0.2)
            with self._lock:
                for user_id, ubuf in list(self.user_buffers.items()):
                    if ubuf.should_transcribe():
                        pcm_16k = ubuf.pop_audio_for_transcription()
                        if pcm_16k and len(pcm_16k) >= TRANSCRIPTION_SAMPLE_RATE * 2 * MIN_UTTERANCE_SECONDS:
                            threading.Thread(
                                target=self._run_transcription,
                                args=(ubuf.display_name, ubuf.avatar_url, pcm_16k),
                                daemon=True
                            ).start()

    def _run_transcription(self, display_name: str, avatar_url: str | None, pcm_16k: bytes):
        try:
            audio_file = io.BytesIO()
            with wave.open(audio_file, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(SAMPLE_WIDTH)
                wav.setframerate(TRANSCRIPTION_SAMPLE_RATE)
                wav.writeframes(pcm_16k)
            future = asyncio.run_coroutine_threadsafe(
                self.callback_coro(display_name, avatar_url, audio_file.getvalue()),
                self.bot.loop,
            )
            future.add_done_callback(self._log_transcription_error)
        except Exception as e:
            logger.error("[Logfare transcription error] %s", e)

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
            except Exception:
                logger.exception("Logfare transcription request failed")
                return
            if not text:
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

    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            session = self.sessions.pop(guild_id, None)
            if not session:
                return
            remove_receive_sink(session["vc"], "transcribe")
        return cleanup


async def setup(bot: commands.Bot):
    await bot.add_cog(TranscriptionCog(bot))
