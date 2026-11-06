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
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import voice_connection_failed
from core.vc.voice_media import add_receive_sink, remove_receive_sink
from core.vc.speech_vad import SpeechDetector
from core.emojis import FAILED, LOADING, LOUPE, PAUSE
try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

from core.vc.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.transcription.common import we  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class DebugMixin:
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
                f"{FAILED} 調べる音声がありません。文字起こし中のVCで話してからもう一度実行するか、"
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
                return await ctx.send(embed=we(f"{FAILED} 実行に失敗しました: `{e}`"))
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
            f"{LOUPE} **文字起こし言語指定テスト** — {used_model}\n"
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
            message = f"{LOADING} `!sttdebug` は続けて実行できません。{error.retry_after:.0f}秒後にもう一度お試しください。"
        elif isinstance(error, commands.NoPrivateMessage):
            message = f"{FAILED} `!sttdebug` はサーバーのテキストチャンネルで実行してください。"
        else:
            logger.error("sttdebug でエラー", exc_info=error)
            message = f"{FAILED} `!sttdebug` でエラーが発生しました: `{error!r}`"[:1900]
        try:
            await ctx.send(message)
        except Exception:
            logger.exception("sttdebug のエラー通知を送れませんでした")
