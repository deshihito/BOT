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
from core.support.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.support.emojis import CLOCK, FAILED, MUSIC, PAUSE

from core.vc.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.rec.common import CHANNELS, MIN_SAVE_BYTES, SAMPLE_RATE, SAMPLE_WIDTH  # noqa: F401
from core.vc.rec.sink import RecordingSink  # noqa: F401
from core.support.panel_v2 import as_embed_v2

logger = logging.getLogger("cogs.sio_rec")


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()




class DeliverMixin:
    async def _deliver(self, session: dict, audio: dict[str, bytes], reason: str) -> None:
        """録音結果を、録音を始めたチャンネルへ送る。"""
        channel = session["text_channel"]
        elapsed = int(time.time() - session["start"])
        headline = self.STOP_REASONS.get(reason, self.STOP_REASONS["stop"])
        try:
            await self._send_recording(channel, session["guild"], audio, elapsed, headline)
        except Exception:
            logger.exception("[REC] 録音ファイルの送信に失敗しました")


    async def _send_recording(self, ctx, guild, audio, elapsed, headline):
        await ctx.send(view=as_embed_v2(we(
            f"{headline}（録音時間: `{self.format_time(elapsed)}`）。ファイルを生成中..."
        )))

        if not audio:
            return await ctx.send(view=as_embed_v2(we(
                FAILED + ' 音声バッファが空でした。（発言が検知されなかったか、パケットが届いていません）'
            )))

        limit = getattr(guild, "filesize_limit", 8 * 1024 * 1024)
        if not isinstance(limit, int):
            limit = 8 * 1024 * 1024
        files, skipped = await self.build_files(audio, limit)

        if not files:
            note = f"{FAILED} 送信可能な録音データがありませんでした。"
            if skipped:
                note += "\n" + "\n".join(
                    f"・`{name}` はファイルサイズ超過 ({size / 1024 / 1024:.1f}MB) のため送信できません。"
                    for name, size in skipped
                )
            return await ctx.send(view=as_embed_v2(we(note)))

        for i in range(0, len(files), 10):
            chunk = files[i:i + 10]
            layout = discord.ui.LayoutView(timeout=None)
            items: list[discord.ui.Item] = [
                discord.ui.TextDisplay(
                    f"{MUSIC} **録音データ出力 ({i + 1}〜{i + len(chunk)}件 / 全{len(files)}件)**")
            ]
            items.extend(
                discord.ui.File(media=f"attachment://{f.filename}") for f in chunk)
            layout.add_item(discord.ui.Container(*items))
            await ctx.send(view=layout, files=chunk)

        if skipped:
            await ctx.send(view=as_embed_v2(we(
                f"{FAILED} 以下はサイズ超過のため送信できませんでした:\n" + "\n".join(
                    f"・`{name}` ({size / 1024 / 1024:.1f}MB)" for name, size in skipped
                )
            )))


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
