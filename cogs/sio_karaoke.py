from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import sys
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
from core.vosk_model import ensure_model
from core.voice_session import VoiceBusy, get_manager

try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    Model = None
    KaldiRecognizer = None

logger = logging.getLogger(__name__)

DISCORD_SAMPLE_RATE = 48000
VOSK_SAMPLE_RATE = 16000
CHANNELS = 2

# カラオケ用に無音判定を少し短めに設定 (0.5秒)
SILENCE_THRESHOLD_SEC = 0.5
RMS_SILENCE_THRESHOLD = 350
MODEL_PATH = "model"
OPUS_SILENCE = b"\xf8\xff\xfe"


def we(description: str | None = None, title: str | None = None, color: int = 0xFF69B4) -> discord.Embed:
    """カラオケ風のピンク色 Embed"""
    return discord.Embed(title=title, description=description, color=color)


# ============================================================
# DAVE (Discord E2EE) パッチ
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


def resample_48k_to_16k(pcm_data: bytes) -> bytes:
    audio_16bit = np.frombuffer(pcm_data, dtype=np.int16)
    if len(audio_16bit) == 0:
        return b""
    audio_stereo = audio_16bit.reshape(-1, CHANNELS)
    audio_mono = audio_stereo.mean(axis=1)
    audio_16k = audio_mono[::3].astype(np.int16)
    return audio_16k.tobytes()


def clean_text(text: str) -> str:
    """比較のために記号やスペースを排除"""
    return re.sub(r'[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]', '', text)


# ============================================================
# カラオケ用 AudioSink
# ============================================================
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


# ============================================================
# カラオケ Cog 本体
# ============================================================
class KaraokeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)

        self.vosk_model = None
        if Model is None:
            logger.warning("Voskが未インストールのため、カラオケ機能を無効化します。")
        elif not os.path.exists(MODEL_PATH):
            logger.warning("Voskモデルが見つからないため、カラオケ機能を無効化します: %s", MODEL_PATH)
        else:
            self.vosk_model = Model(MODEL_PATH)

    async def _get_or_create_webhook(self, channel: discord.TextChannel) -> discord.Webhook:
        webhooks = await channel.webhooks()
        for wh in webhooks:
            if wh.token:
                return wh
        return await channel.create_webhook(name="Karaoke-Lyrics")

    # --------------------------------------------------
    # 実装（/voice studio）
    # --------------------------------------------------
    async def _karaoke_impl(self, r: Responder, action: str, target_lyrics: str | None = None):
        """action: start / score / stop / help"""
        if action == "start":
            return await self._start(r, target_lyrics)
        if action == "score":
            return await self._score(r)
        if action == "stop":
            if r.guild.id not in self.sessions:
                return await r.send(embed=we("⚠️ 現在カラオケは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(r.guild.id, "karaoke", reason="stop"):
                self._cleanup(r.guild.id)("stop")
            return await r.send(embed=we("🛑 カラオケモードを終了しました！"))
        await r.send(embed=we(
            "🎤 **カラオケ機能の使い方**\n"
            "1. `/voice のパネルからカラオケ開始 lyrics:<お題の歌詞>` : 歌詞をセットして採点＆字幕開始\n"
            "2. `/voice のパネルからカラオケ採点` : 現在の歌唱スコアを表示\n"
            "3. `/voice のパネルからカラオケ終了` : カラオケを終了"
        ))

    async def _start(self, r: Responder, target_lyrics: str | None):
        if not target_lyrics or not target_lyrics.strip():
            return await r.send(embed=we("⚠️ お題の歌詞を `lyrics` に入れてください。"), ephemeral=True)
        # モデルが無いときは VC に入る前に断る。
        problem = await ensure_model(self, Model, MODEL_PATH)
        if problem:
            return await r.send(embed=we(problem), ephemeral=True)
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we("⚠️ ボイスチャンネルに参加してから実行してください。"), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we("⚠️ 既にカラオケ機能が実行中です。"), ephemeral=True)

        vc_channel = voice.channel
        await r.defer()
        webhook = await self._get_or_create_webhook(r.channel)

        # 別の機能が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, vc_channel, "karaoke", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=True, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)))
        except Exception as e:
            return await r.send(embed=we(f"<:failed:1490986584676368535> VC接続に失敗しました: `{e}`"))

        async def send_lyrics_subtitle(display_name: str, avatar_url: str | None, text: str):
            async with aiohttp.ClientSession() as session:
                wh_obj = discord.Webhook.from_url(webhook.url, session=session)
                try:
                    await wh_obj.send(
                        content=f"<:music:1561710964238450809> {text}",
                        username=f"🎤 {display_name}",
                        avatar_url=avatar_url,
                        _agobot_skip_localization=True,
                    )
                except Exception as ex:
                    logger.error(f"[Webhook Error] {ex}")

        sink = KaraokeSink(bot=self.bot, vc=vc, vosk_model=self.vosk_model, callback_coro=send_lyrics_subtitle)
        vc.listen(sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "target_lyrics": target_lyrics,
            "start_time": time.time()
        }

        await r.send(embed=we(
            f"🎤 **{vc_channel.name}** でカラオケを開始しました！\n\n"
            f"📜 **お題の歌詞:**\n```\n{target_lyrics}\n```\n"
            "歌った声がリアルタイムで字幕表示されます。終わったら `/voice のパネルからカラオケ採点` で採点！"
        ), skip_localization=True)

    async def _score(self, r: Responder):
        session = self.sessions.get(r.guild.id)
        if not session:
            return await r.send(embed=we("⚠️ 現在カラオケは実行されていません。"), ephemeral=True)

        sink: KaraokeSink = session["sink"]
        target = clean_text(session["target_lyrics"])

        if not target:
            return await r.send(embed=we("<:failed:1490986584676368535> お題の歌詞が登録されていません。"), ephemeral=True)

        embed = discord.Embed(title="🏆 カラオケ採点結果", color=0xFFD700)

        with sink._lock:
            for user_id, ubuf in sink.user_buffers.items():
                sung_text = clean_text("".join(ubuf["history"]))
                if not sung_text:
                    continue

                # 一致率の計算 (0.0 〜 1.0)
                matcher = SequenceMatcher(None, target, sung_text)
                ratio = matcher.ratio()
                score = round(ratio * 100, 1)

                comment = "🥇 PERFECT!" if score >= 85 else ("🥈 GOOD!" if score >= 60 else "🥉 KEEP TRYING!")

                embed.add_field(
                    name=f"👤 {ubuf['display_name']} さんのスコア",
                    value=f"点数: **{score} 点** / 100点\n評価: {comment}\n認識結果: `{sung_text[:30]}...`",
                    inline=False
                )

        if not embed.fields:
            embed.description = "まだ歌声が検知されていません！"

        await r.send(embed=embed)

    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            session = self.sessions.pop(guild_id, None)
            if not session:
                return
            session["sink"].cleanup()
            try:
                session["vc"].stop_listening()
            except Exception:
                pass
        return cleanup


async def setup(bot: commands.Bot):
    await bot.add_cog(KaraokeCog(bot))
