import discord
from core.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands, tasks
import asyncio
import time
import types
import logging
import string
import subprocess
import json
import io
import os
import shlex
import tempfile
import yt_dlp
import struct
import math  # 追加: Timerクラスのサイン波計算で必要
from discord.ext import voice_recv
import threading
import random
import numpy as np
from scipy import signal
import numpy as np
import re
import wave
import discord.opus
from core import voice_restore
from core.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import CLOCK, FAILED, MUSIC, SUCCESS, VOL
from core.music_activity import build_music_activity_snapshot

from core.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")


class ConnectionMixin:
    async def _join_impl(self, r: Responder):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we("先にボイスチャンネルに入ってください。"), ephemeral=True)

        # 接続処理が長引く可能性があるため defer（応答保留）を実行
        await r.defer()
        channel = voice.channel
        TIMEOUT_SECONDS = 45.0

        try:
            # 別の機能（録音など）が使用中なら追い出さずに断る。移動・新規接続ともにタイムアウトで保護する。
            await asyncio.wait_for(
                self._acquire_music(r.guild, channel, r.user, r.channel),
                timeout=TIMEOUT_SECONDS,
            )
            await r.send(embed=we(f"{VOL} **{channel.name}** に参加しました。"))
        except VoiceBusy as busy:
            await r.send(embed=we(str(busy)), ephemeral=True)
        except asyncio.TimeoutError:
            await r.send(embed=we(f"{CLOCK} タイムアウト: ボイスチャンネルへの接続応答時間が超過しました。Botの権限やネットワーク状態をご確認ください。"))
        except Exception as e:
            logger.exception("Voice channel join failed")
            await r.send(embed=we(f"{FAILED} 接続失敗: {e}"))


    async def _leave_impl(self, r: Responder):
        guild_id = r.guild_id
        session = self.voice_sessions.get(guild_id)
        voice_client = r.voice_client
        if session is not None:
            # 音楽は今までどおり誰でも止められる。録音などは開始した人・管理者（または開始した人が不在）のみ。
            if not self.voice_sessions.can_leave(session, r.user):
                return await r.send(
                    embed=we(f"{FAILED} いまは **{session.label}**（{session.user_name} さんが開始）で使用中です。"
                              f"止められるのは開始した人か管理者だけです（`{self._stop_hint(session.feature)}`）。"),
                    ephemeral=True,
                )
            await r.defer()
            await self.voice_sessions.release(
                guild_id, reason='stop' if session.feature == 'music' else 'leave', by=r.user,
            )
            await r.send(embed=we("👋 退出しました。"))
        elif voice_client:
            # 持ち主の記録がない古い接続
            self._reset_playback(guild_id)
            await voice_client.disconnect(force=True)
            await r.send(embed=we("👋 退出しました。"))
        else:
            await r.send(embed=we("ボットはボイスチャンネルに参加していません。"), ephemeral=True)


    @staticmethod
    def _stop_hint(feature: str) -> str:
        from core.voice_session import stop_hint
        return stop_hint(feature)


    @commands.command()
    async def ffversion(self, ctx):
        """FFmpegのバージョン情報を取得して表示します"""
        try:
            # 非同期プロセスで 'ffmpeg -version' を実行
            proc = await asyncio.create_subprocess_exec(
                'ffmpeg', '-version',
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, _ = await proc.communicate()
            
            if stdout:
                # 出力の最初の一行（通常ここにバージョンが記載されています）を取得
                first_line = stdout.decode('utf-8', errors='ignore').split('\n')[0]
                await ctx.send(embed=we(title="FFmpeg Version Info", description=f"```\n{first_line}\n```"))
            else:
                await ctx.send(embed=we(FAILED + ' FFmpegのバージョン情報を取得できませんでした。'))
                
        except FileNotFoundError:
            await ctx.send(embed=we(FAILED + ' システムに `ffmpeg` コマンドが見つかりません。パスが通っているか確認してください。'))
        except Exception as e:
            logger.exception("ffversion command failed")
            await ctx.send(embed=we(f"{FAILED} エラーが発生しました: {e}"))


    async def _ensure_music_connection(self, r: Responder) -> str | None:
        """音楽を流せる状態にする。だめなときは理由（そのまま返信できる文）を返す。

        - 共有対象外の機能（録音など）が VC を使っているときは断る
        - Bot が VC にいなければ、実行した人の VC に「音楽」として入る（VoiceSessionManager 経由）
        """
        guild = r.guild
        if guild is None:
            return "サーバーの中で実行してください。"
        if busy := self._busy_message(guild):
            return busy
        vc = guild.voice_client
        if vc is not None and vc.is_connected():
            session = self.voice_sessions.get(guild.id)
            if session is not None and session.feature != "music" and "music" not in session.shared_leases:
                try:
                    await self._acquire_music(guild, vc.channel, r.user, r.channel)
                except VoiceBusy as busy:
                    return str(busy)
                except Exception as exc:
                    logger.exception("Failed to join shared music session")
                    return f"共有ボイスセッションに参加できませんでした: {exc}"
            return None
        voice = getattr(r.user, 'voice', None)
        channel = getattr(voice, 'channel', None)
        if channel is None:
            return "先にボイスチャンネルに参加してください。"
        try:
            await asyncio.wait_for(self._acquire_music(guild, channel, r.user, r.channel), timeout=45.0)
        except VoiceBusy as busy:
            return str(busy)
        except asyncio.TimeoutError:
            return f"{CLOCK} タイムアウト: ボイスチャンネルへの接続応答時間が超過しました。Botの権限やネットワーク状態をご確認ください。"
        except Exception as exc:
            logger.exception("Failed to connect for music")
            return f"ボイスチャンネルへ接続できませんでした: {exc}"
        return None
