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
from core.vc import voice_restore
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import FAILED, MUSIC, SUCCESS
from core.vc.music_activity import build_music_activity_snapshot

from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")


class StateMixin:
    def cog_unload(self):
        self._snapshot_loop.cancel()
        for state in self.states.values():
            for task_name in ('playlist_load_task', 'progress_task'):
                task = state.get(task_name)
                if task and not task.done():
                    task.cancel()


    def get_state(self, guild_id: int):
        if guild_id not in self.states:
            self.states[guild_id] = {
                'queue': asyncio.Queue(maxsize=MAX_QUEUE_SIZE),
                'current_ctx': None,
                'is_processing_queue': False,
                'current_track': None,
                'current_thumbnail_url': None,
                'start_time': 0,
                'elapsed_offset': 0,
                'retry_count': 0,
                'volume': self.default_volume,
                'speed': self.default_speed,
                'eq': self.default_eq,
                'custom_eq_filter': None,
                'is_paused': False,
                'is_changing_setting': False,
                'panel_message': None,
                # --- 録音用ステート ---
                'is_recording': False,
                'rec_start_time': 0,
                'sink': None,
                # YouTubeは再生用URLが短時間で失効するため、再取得用のページURLを別途保持する。
                'current_yt_page_url': None,
                # yt-dlpが取得したストリーム用HTTPヘッダーをFFmpegにも渡す。
                'current_yt_headers': {},
                'loop_mode': 'off',
                'shuffle_enabled': False,
                'playlist_load_task': None,
                'progress_task': None,
            }
        return self.states[guild_id]


    def activity_snapshot(self, guild_id: int, *, is_playing: bool, now: float | None = None) -> dict:
        """Return only the safe, read-only fields needed by the Music Activity."""
        return build_music_activity_snapshot(
            self.get_state(guild_id), is_playing=is_playing, now=now
        )


    def _reset_playback(self, guild_id: int):
        """キューと再生中の曲を空にし、裏で動いているタスクを止める（退出時の後片付け）。"""
        state = self.get_state(guild_id)
        for task_name in ('playlist_load_task', 'progress_task'):
            task = state.get(task_name)
            if task and not task.done():
                task.cancel()
        while not state['queue'].empty():
            state['queue'].get_nowait()
        state['current_track'] = None
        state['current_thumbnail_url'] = None
        state['current_yt_page_url'] = None
        state['elapsed_offset'] = 0
        state['is_paused'] = False
        state['is_processing_queue'] = False
        self._clear_music_snapshot(guild_id)


    def _music_cleanup(self, guild_id: int):
        def cleanup(reason: str):
            self._reset_playback(guild_id)
        return cleanup


    def _busy_message(self, guild) -> str | None:
        """音楽以外の機能が VC を使っているときの案内文。音楽が使える状態なら None。"""
        session = self.voice_sessions.get(guild.id) if guild else None
        if session is not None and session.feature not in SHARED_FEATURES:
            return self.voice_sessions.busy_message(session)
        return None


    async def _acquire_music(self, guild, channel, user, text_channel):
        """音楽として VC に入る（入っていれば移動）。別機能が使用中なら VoiceBusy。"""
        return await self.voice_sessions.acquire(
            guild, channel, 'music', user,
            cleanup=self._music_cleanup(guild.id), text_channel=text_channel, force=True,
        )


    def _start_progress_task(self, guild_id: int):
        state = self.get_state(guild_id)
        task = state.get('progress_task')
        if task and not task.done():
            return
        state['progress_task'] = asyncio.create_task(self._progress_loop(guild_id))


    async def _progress_loop(self, guild_id: int):
        try:
            while True:
                await asyncio.sleep(15)
                guild = self.bot.get_guild(guild_id)
                vc = guild.voice_client if guild else None
                state = self.get_state(guild_id)
                if not vc or not vc.is_connected() or not has_audio_source(vc, "music") or not state.get('current_track'):
                    return
                await self.update_panel(guild_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Progress update task failed for guild %s", guild_id)
        finally:
            self.get_state(guild_id)['progress_task'] = None
