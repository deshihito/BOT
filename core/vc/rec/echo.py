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
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE

from core.vc.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.rec.sink import RecordingSink  # noqa: F401

logger = logging.getLogger("cogs.sio_rec")


class EchoMixin:
    async def _echo_impl(self, r: Responder, action: str, delay: float | None = None):
        """action: start / delay / stop / status"""
        guild_id = r.guild.id
        if action == "start":
            return await self._echo_start(r, 2.0 if delay is None else delay)
        if action == "delay":
            session = self.echo_sessions.get(guild_id)
            if not session:
                return await r.send(embed=we(f"{FAILED} 現在やまびこは実行されていません。"), ephemeral=True)
            if delay is None or delay <= 0:
                return await r.send(embed=we(f"{FAILED} 遅延時間は 0 秒より大きく設定してください。"), ephemeral=True)
            session["sink"].set_echo_delay(delay)
            return await r.send(embed=we(f"{CLOCK} やまびこの遅延時間を `{delay}` 秒に変更しました。"))
        if action == "stop":
            if guild_id not in self.echo_sessions:
                return await r.send(embed=we(f"{FAILED} 現在やまびこは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(guild_id, "echo", reason="stop"):
                self._echo_cleanup(guild_id)("stop")
            return await r.send(embed=we("🛑 やまびこを停止しました。"))
        session = self.echo_sessions.get(guild_id)
        if session:
            await r.send(embed=we(
                f"🗣️ **やまびこ動作中**\n"
                f"{CLOCK} 遅延時間: `{session['sink'].echo_delay}`秒\n"
                f"遅延変更: `/vc のパネルからやまびこ遅延変更 delay:<秒数>`\n"
                f"停止: `/vc のパネルからやまびこ停止`"
            ))
        else:
            await r.send(embed=we(PAUSE + ' やまびこ停止中 (`/vc のパネルからやまびこ開始` で開始)'))


    async def _echo_start(self, r: Responder, delay: float):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.echo_sessions:
            return await r.send(embed=we(f"{FAILED} 既にやまびこが実行中です。"), ephemeral=True)
        if delay <= 0:
            return await r.send(embed=we(f"{FAILED} 遅延時間は 0 秒より大きく設定してください。"), ephemeral=True)

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
            f"{CLOCK} 遅延時間: `{delay}`秒\n"
            f"遅延変更: `/vc のパネルからやまびこ遅延変更 delay:3.0` | 停止: `/vc のパネルからやまびこ停止`"
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
                logger.debug("やまびこ: 後片付けの受信停止に失敗しました", exc_info=True)
            try:
                vc.stop()
            except Exception:
                logger.debug("やまびこ: 後片付けの再生停止に失敗しました", exc_info=True)
        return cleanup
