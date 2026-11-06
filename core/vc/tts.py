from __future__ import annotations
import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from core.embeds import we
from core.emojis import FAILED
try:
    import encodec
    import soundfile as sf
    import torch

    # CPU 推論はスレッドを増やしすぎると逆に遅くなることがある。上限を絞る。
    torch.set_num_threads(min(4, os.cpu_count() or 4))

    VOICE_TRIGGER_AVAILABLE = True
except Exception:  # ImportError だけでなく共有ライブラリ不整合 (OSError) 等も捕捉
    encodec = None
    sf = None
    torch = None
    VOICE_TRIGGER_AVAILABLE = False
    logging.getLogger(__name__).warning(
        "EnCodec/torch/soundfile を読み込めなかったため、音声トリガー機能は無効になります",
        exc_info=True,
    )
from core import action_usage
from core.support import usage_stats
from core.legacy import Responder
from core.vc.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.vc.voice_media import add_audio_source, remove_audio_source
from core.panel_v2 import as_panel_v2, edit_panel_v2

from core.vc.common import *  # noqa: F401,F403 - shared constants

logger = logging.getLogger("cogs.sio_voice")


logger = logging.getLogger("cogs.sio_voice")


TTS_API_BASE = "https://api.tts.quest/v3/voicevox"


TTS_API_KEY = os.getenv("TTSQUEST_API_KEY")


TTS_DEFAULT_SPEAKER = 3


TTS_MAX_CHARS = 300


TTS_CHUNK_CHARS = 100


TTS_QUEUE_MAX = 10


TTS_PITCH_RANGE = (-12.0, 12.0)


TTS_SPEED_RANGE = (0.5, 2.0)


TTS_IGNORE_PREFIXES = ("/", ";", "；")


TTS_SETTINGS_PATH = Path(os.getenv("TTS_SETTINGS_PATH", "data/tts_settings.json"))


class TTSError(Exception):
    pass


@dataclass
class TTSSettings:
    speaker: int = TTS_DEFAULT_SPEAKER
    pitch: float = 0.0
    speed: float = 1.0


def _tempo_filters(tempo: float) -> list[str]:
    filters: list[str] = []
    while tempo > 2.0:
        filters.append("atempo=2.0")
        tempo /= 2.0
    while tempo < 0.5:
        filters.append("atempo=0.5")
        tempo /= 0.5
    filters.append(f"atempo={tempo:.6f}")
    return filters


def build_tts_filters(pitch: float, speed: float) -> str:
    factor = 2 ** (pitch / 12) if abs(pitch) >= 0.01 else 1.0
    filters: list[str] = []
    if factor != 1.0:
        filters += ["aresample=48000", f"asetrate={round(48000 * factor)}", "aresample=48000"]
    tempo = speed / factor
    if abs(tempo - 1.0) >= 0.001:
        filters += _tempo_filters(tempo)
    return ",".join(filters)


def split_tts_text(text: str, limit: int = TTS_CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current = ""
    for part in re.split(r"(?<=[。！？!?\n])", text[:TTS_MAX_CHARS]):
        part = part.strip()
        if not part:
            continue
        while len(part) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(part[:limit])
            part = part[limit:]
        if len(current) + len(part) <= limit:
            current += part
        else:
            chunks.append(current)
            current = part
    if current:
        chunks.append(current)
    return chunks


def clean_message_text(message: discord.Message) -> str:
    text = message.clean_content
    text = re.sub(r"```.*?```", "コード省略", text, flags=re.DOTALL)
    text = re.sub(r"\|\|.*?\|\|", "ネタバレ", text, flags=re.DOTALL)
    text = re.sub(r"https?://\S+", "URL", text)
    text = re.sub(r"<a?:\w+:\d+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text and message.attachments:
        text = "添付ファイル"
    return text


class TTSCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self.settings: dict[int, TTSSettings] = {}
        self.read_channels: dict[int, int] = {}
        self.queues: dict[int, asyncio.Queue] = {}
        self.workers: dict[int, asyncio.Task] = {}
        self._speakers: list | None = None
        self._session: aiohttp.ClientSession | None = None
        self._load_settings()

    async def cog_unload(self):
        for task in list(self.workers.values()):
            task.cancel()
        if self._session is not None and not self._session.closed:
            await self._session.close()

    def _load_settings(self):
        try:
            raw = json.loads(TTS_SETTINGS_PATH.read_text(encoding="utf-8"))
            for user_id, value in raw.items():
                self.settings[int(user_id)] = TTSSettings(
                    speaker=int(value.get("speaker", TTS_DEFAULT_SPEAKER)),
                    pitch=float(value.get("pitch", 0.0)),
                    speed=float(value.get("speed", 1.0)),
                )
        except FileNotFoundError:
            pass
        except Exception:
            logger.exception("TTS設定の読み込みに失敗しました")

    def _save_settings(self):
        try:
            TTS_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = TTS_SETTINGS_PATH.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({str(uid): asdict(cfg) for uid, cfg in self.settings.items()}, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(TTS_SETTINGS_PATH)
        except Exception:
            logger.exception("TTS設定の保存に失敗しました")

    def get_settings(self, user_id: int) -> TTSSettings:
        return self.settings.get(user_id) or TTSSettings()

    async def _speaker_name(self, speaker: int) -> str:
        speakers = await self._load_speakers()
        if 0 <= speaker < len(speakers) and speakers[speaker]:
            return str(speakers[speaker])
        return f"話者ID {speaker}"

    async def _apply_config(self, user_id: int, speaker: int | None, pitch: float | None,
                            speed: float | None) -> str:
        cfg = TTSSettings(**asdict(self.get_settings(user_id)))
        if speaker is not None:
            speakers = await self._load_speakers()
            if speakers and not (0 <= speaker < len(speakers) and speakers[speaker]):
                raise ValueError(f"話者ID {speaker} は使えません。設定画面では名前の一部（例: ずんだ）でも指定できます。")
            if speaker < 0:
                raise ValueError("話者IDは0以上で指定してください。")
            cfg.speaker = speaker
        if pitch is not None:
            if not TTS_PITCH_RANGE[0] <= pitch <= TTS_PITCH_RANGE[1]:
                raise ValueError(f"ピッチは {TTS_PITCH_RANGE[0]:g}〜{TTS_PITCH_RANGE[1]:g}（半音）で指定してください。")
            cfg.pitch = pitch
        if speed is not None:
            if not TTS_SPEED_RANGE[0] <= speed <= TTS_SPEED_RANGE[1]:
                raise ValueError(f"話速は {TTS_SPEED_RANGE[0]:g}〜{TTS_SPEED_RANGE[1]:g} で指定してください。")
            cfg.speed = speed
        self.settings[user_id] = cfg
        self._save_settings()
        return (f"🗣️ 読み上げ設定\n話者: **{await self._speaker_name(cfg.speaker)}**（ID {cfg.speaker}）\n"
                f"ピッチ: **{cfg.pitch:+g}** 半音 / 話速: **{cfg.speed:g}** 倍")

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        return self._session

    async def _load_speakers(self) -> list:
        if self._speakers is not None:
            return self._speakers
        try:
            session = await self._get_session()
            async with session.get(f"{TTS_API_BASE}/speakers_array") as resp:
                data = await resp.json(content_type=None)
            speakers = data.get("speakers")
            if isinstance(speakers, list):
                self._speakers = speakers
        except Exception:
            logger.warning("話者一覧を取得できませんでした", exc_info=True)
        return self._speakers or []

    async def _synthesize(self, text: str, speaker: int) -> str:
        session = await self._get_session()
        params = {"speaker": speaker, "text": text}
        if TTS_API_KEY:
            params["key"] = TTS_API_KEY

        data: dict = {}
        for _ in range(3):
            async with session.get(f"{TTS_API_BASE}/synthesis", params=params) as resp:
                data = await resp.json(content_type=None)
            if data.get("success"):
                break
            if data.get("retryAfter"):
                await asyncio.sleep(min(float(data["retryAfter"]), 10.0))
                continue
            raise TTSError(str(data.get("errorMessage") or data))
        else:
            raise TTSError("tts.quest がビジー状態です。少し待ってからもう一度お試しください。")

        for _ in range(60):
            async with session.get(data["audioStatusUrl"]) as resp:
                status = await resp.json(content_type=None)
            if status.get("isAudioError"):
                raise TTSError(f"合成に失敗しました: {status.get('status')}")
            if status.get("isAudioReady"):
                break
            await asyncio.sleep(0.5)
        else:
            raise TTSError("合成がタイムアウトしました。")

        audio = None
        for _ in range(5):
            async with session.get(data["mp3DownloadUrl"]) as resp:
                if resp.status == 200:
                    audio = await resp.read()
                    break
            await asyncio.sleep(0.4)
        if audio is None:
            raise TTSError("音声ファイルを取得できませんでした。")

        fd, path = tempfile.mkstemp(prefix="tts_", suffix=".mp3")
        with os.fdopen(fd, "wb") as fh:
            fh.write(audio)
        return path

    async def _synthesize_all(self, text: str, speaker: int) -> list[str]:
        chunks = split_tts_text(text)
        results = await asyncio.gather(*(self._synthesize(c, speaker) for c in chunks), return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            for r in results:
                if isinstance(r, str):
                    self._remove(r)
            raise errors[0]
        return list(results)

    @staticmethod
    def _remove(path: str):
        try:
            os.unlink(path)
        except OSError:
            logger.debug("読み上げ: 一時ファイルの削除に失敗しました: %s", path, exc_info=True)

    async def _play_file(self, vc: discord.VoiceClient, path: str, cfg: TTSSettings):
        options = "-vn -ar 48000 -ac 2"
        filters = build_tts_filters(cfg.pitch, cfg.speed)
        if filters:
            options += f" -af {shlex.quote(filters)}"
        source = discord.FFmpegPCMAudio(path, options=options)

        loop = asyncio.get_running_loop()
        done: asyncio.Future = loop.create_future()

        def after(error):
            loop.call_soon_threadsafe(lambda: done.done() or done.set_result(error))

        add_audio_source(vc, "tts", source, after=after)
        try:
            error = await asyncio.wait_for(done, timeout=120)
            if error:
                logger.warning("TTS再生エラー: %s", error)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            remove_audio_source(vc, "tts")
            raise

    async def enqueue(self, guild: discord.Guild, text: str, user_id: int) -> bool:
        queue = self.queues.setdefault(guild.id, asyncio.Queue(maxsize=TTS_QUEUE_MAX))
        try:
            queue.put_nowait((text, TTSSettings(**asdict(self.get_settings(user_id)))))
        except asyncio.QueueFull:
            return False
        worker = self.workers.get(guild.id)
        if worker is None or worker.done():
            self.workers[guild.id] = asyncio.create_task(self._worker(guild))
        return True

    async def _worker(self, guild: discord.Guild):
        queue = self.queues[guild.id]
        try:
            while not queue.empty():
                text, cfg = queue.get_nowait()
                vc = guild.voice_client
                if vc is None or not vc.is_connected():
                    while not queue.empty():
                        queue.get_nowait()
                    break
                try:
                    paths = await self._synthesize_all(text, cfg.speaker)
                except Exception as exc:
                    logger.warning("TTS合成に失敗: %s", exc)
                    continue
                try:
                    for path in paths:
                        await self._play_file(vc, path, cfg)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("TTS再生に失敗")
                finally:
                    for path in paths:
                        self._remove(path)
        finally:
            if self.read_channels.get(guild.id) is None:
                await self.voice_sessions.release(guild.id, "tts", reason="stop")

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        guild = message.guild
        if guild is None or message.author.bot:
            return
        if self.read_channels.get(guild.id) != message.channel.id:
            return
        vc = guild.voice_client
        if vc is None or not vc.is_connected():
            self.read_channels.pop(guild.id, None)
            return
        voice = getattr(message.author, "voice", None)
        if voice is None or voice.channel != vc.channel:
            return
        if message.content.startswith(TTS_IGNORE_PREFIXES):
            return
        text = clean_message_text(message)
        if text:
            await self.enqueue(guild, text, message.author.id)

    async def _ensure_connection(self, r: Responder) -> str | None:
        guild = r.guild
        if guild is None:
            return "サーバーの中で実行してください。"
        vc = getattr(guild, "voice_client", None)
        channel = getattr(vc, "channel", None) if vc is not None and vc.is_connected() else None
        if channel is None:
            voice = getattr(r.user, "voice", None)
            channel = getattr(voice, "channel", None)
        if channel is None:
            return "先にボイスチャンネルに参加してください。"
        try:
            await self.voice_sessions.acquire(
                guild, channel, "tts", r.user, cleanup=self._cleanup_tts(guild.id),
                text_channel=r.channel, force=False,
            )
        except VoiceBusy as busy:
            return str(busy)
        except Exception as exc:
            logger.exception("TTS voice-session acquisition failed")
            return f"ボイスチャンネルへ接続できませんでした: {exc}"
        return None

    def _cleanup_tts(self, guild_id: int):
        def cleanup(reason: str) -> None:
            self.read_channels.pop(guild_id, None)
            queue = self.queues.get(guild_id)
            if queue is not None:
                while not queue.empty():
                    queue.get_nowait()
            guild = self.bot.get_guild(guild_id)
            vc = getattr(guild, "voice_client", None) if guild else None
            if vc is not None:
                remove_audio_source(vc, "tts")
            worker = self.workers.get(guild_id)
            if worker is not None and worker is not asyncio.current_task() and not worker.done():
                worker.cancel()
        return cleanup

    async def _start_impl(self, r: Responder, channel: discord.abc.Messageable | None = None):
        await r.defer()
        if error := await self._ensure_connection(r):
            return await r.send(error, ephemeral=True)
        target = channel or r.channel
        self.read_channels[r.guild.id] = target.id
        cfg = self.get_settings(r.user.id)
        await r.send(embed=we(
            f"<#{target.id}>の発言を読み上げます（VC にいる人だけ）。\n"
            f"話者: **{await self._speaker_name(cfg.speaker)}** / ピッチ {cfg.pitch:+g} / 話速 {cfg.speed:g}倍",
            title="🗣️ 読み上げを開始しました",
        ))

    async def _stop_impl(self, r: Responder):
        guild_id = r.guild.id
        was_active = self.read_channels.pop(guild_id, None) is not None
        queue = self.queues.get(guild_id)
        if queue is not None:
            while not queue.empty():
                queue.get_nowait()
        worker = self.workers.get(guild_id)
        if worker is not None and not worker.done():
            worker.cancel()
            was_active = True
        guild = r.guild
        vc = getattr(guild, "voice_client", None) if guild else None
        if vc is not None:
            remove_audio_source(vc, "tts")
        await self.voice_sessions.release(guild_id, "tts", reason="stop")
        if was_active:
            await r.send(embed=we("🔇 読み上げを停止しました。VC には残っています（退出は `/vc` →「VC接続」の退出）。"))
        else:
            await r.send("読み上げは開始されていません。", ephemeral=True)

    async def _say_impl(self, r: Responder, text: str):
        text = text.strip()
        if not text:
            return await r.send(f"{FAILED} 読み上げる文章を入力してください。", ephemeral=True)
        await r.defer()
        if error := await self._ensure_connection(r):
            return await r.send(error, ephemeral=True)
        if not await self.enqueue(r.guild, text, r.user.id):
            return await r.send("読み上げ待ちがいっぱいです。少し待ってからもう一度どうぞ。", ephemeral=True)
        cfg = self.get_settings(r.user.id)
        await r.send(embed=we(f"🗣️ 読み上げます（{await self._speaker_name(cfg.speaker)}）"))

    async def _resolve_speaker(self, value: str) -> int:
        value = value.strip()
        if value.isdigit():
            return int(value)
        speakers = await self._load_speakers()
        if not speakers:
            raise ValueError("話者一覧を取得できませんでした。話者IDを数字で入力してください。")
        matches = [(i, str(n)) for i, n in enumerate(speakers) if n and value.lower() in str(n).lower()]
        if not matches:
            raise ValueError(f"「{value}」に当てはまる話者がいません。")
        if len(matches) == 1:
            return matches[0][0]
        listing = "\n".join(f"`{i}` {n}" for i, n in matches[:25])
        more = f"\n…ほか {len(matches) - 25} 件" if len(matches) > 25 else ""
        raise ValueError(f"「{value}」は {len(matches)} 件あります。IDで指定してください。\n{listing}{more}")


class TTSSettingsModal(discord.ui.Modal, title="読み上げ設定"):
    speaker = discord.ui.TextInput(label="話者（IDか名前の一部。例: 3 / ずんだ）", max_length=40)
    pitch = discord.ui.TextInput(label="ピッチ（半音 -12〜12、0が標準）", max_length=6)
    speed = discord.ui.TextInput(label="話速（0.5〜2.0、1.0が標準）", max_length=5)

    def __init__(self, cog: TTSCog, user_id: int):
        super().__init__()
        self.cog = cog
        cfg = cog.get_settings(user_id)
        self.speaker.default = str(cfg.speaker)
        self.pitch.default = f"{cfg.pitch:g}"
        self.speed.default = f"{cfg.speed:g}"

    async def on_submit(self, interaction: discord.Interaction):
        r = Responder(interaction)
        try:
            speaker = await self.cog._resolve_speaker(self.speaker.value)
            pitch = float(self.pitch.value)
            speed = float(self.speed.value)
            message = await self.cog._apply_config(interaction.user.id, speaker, pitch, speed)
        except ValueError as exc:
            text = str(exc)
            if text.startswith("could not convert"):
                text = "ピッチと話速は数値で入力してください。"
            return await r.send(f"{FAILED} {text}", ephemeral=True)
        await r.send(embed=we(message), ephemeral=True)


class TTSSayModal(discord.ui.Modal, title="1回だけ読み上げ"):
    text = discord.ui.TextInput(label="読み上げる文章", style=discord.TextStyle.paragraph,
                                max_length=TTS_MAX_CHARS)

    def __init__(self, cog: TTSCog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog._say_impl(Responder(interaction), self.text.value)
