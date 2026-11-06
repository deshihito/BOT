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
from core.emojis import FAILED, MUSIC, SUCCESS
from core.music_activity import build_music_activity_snapshot

from core.voice.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")


class LoaderMixin:
    async def _load_playlist_in_background(self, ctx, tracks, label: str, status_message):
        """大規模プレイリストを応答期限に縛られず、キュー空き枠へ順次追加する。"""
        guild_id = ctx.guild.id
        state = self.get_state(guild_id)
        total = len(tracks)
        added = skipped = 0
        last_status_update = 0.0
        try:
            for index, item in enumerate(tracks, start=1):
                guild = self.bot.get_guild(guild_id)
                vc = guild.voice_client if guild else None
                if not vc or not vc.is_connected():
                    break
                while state['queue'].full():
                    await asyncio.sleep(1)
                    if not vc.is_connected():
                        return

                if isinstance(item, str):
                    item = {'input': item, 'attachment_id': item, 'is_youtube': False}
                is_yt = bool(item.get('is_youtube'))
                source_input = item.get('input')
                title = item.get('title') or '不明なタイトル'
                b62_id = item.get('attachment_id')
                if is_yt:
                    if not source_input:
                        skipped += 1
                        continue
                    track = (source_input, title, b62_id, True)
                else:
                    token = b62_id or source_input
                    url, filename = await self.get_attachment_info(token, guild_id)
                    if not url:
                        skipped += 1
                        continue
                    track = (url, filename, token, False)

                if await self.enqueue_track(guild_id, track):
                    added += 1
                    if not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                        await self.check_queue(guild_id)
                else:
                    skipped += 1

                now = time.monotonic()
                if now - last_status_update >= 5:
                    last_status_update = now
                    try:
                        await status_message.edit(
                            content=f"プレイリスト `{label}` を読込中: {index}/{total} 件（追加 {added} / スキップ {skipped}）"
                        )
                    except discord.HTTPException:
                        logger.debug("Playlist load status update failed", exc_info=True)
                await asyncio.sleep(0)

            try:
                await status_message.edit(
                    content=f"プレイリスト `{label}` の読込完了: {total} 件中 {added} 件を追加、{skipped} 件をスキップしました。"
                )
            except discord.HTTPException:
                logger.debug("Playlist load status update failed", exc_info=True)
        except asyncio.CancelledError:
            try:
                await status_message.edit(content=f"プレイリスト `{label}` の読込を中止しました（追加済み: {added} 件）。")
            except discord.HTTPException:
                logger.debug("Playlist load status update failed", exc_info=True)
            raise
        except Exception:
            logger.exception("Playlist background load failed")
            try:
                await status_message.edit(content=f"プレイリスト `{label}` の読込中にエラーが発生しました（追加済み: {added} 件）。")
            except discord.HTTPException:
                logger.debug("Playlist load status update failed", exc_info=True)
        finally:
            state['playlist_load_task'] = None


    async def start_playlist_load(self, ctx, tracks, label: str):
        """ctx / interaction のどちらからでも呼べる。"""
        r = Responder(ctx)
        if not tracks:
            return await r.send(embed=we("有効な曲が見つかりませんでした。"))
        state = self.get_state(r.guild.id)
        state['current_ctx'] = ctx
        task = state.get('playlist_load_task')
        if task and not task.done():
            task.cancel()
        status_message = await r.send(f"プレイリスト `{label}` の読込を開始します（全 {len(tracks)} 件）。", want_message=True)
        state['playlist_load_task'] = asyncio.create_task(
            self._load_playlist_in_background(ctx, tracks, label, status_message)
        )


    async def get_duration(self, url):
        try:
            cmd = [
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', url
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                logger.warning("ffprobe timed out after 20 seconds")
                return 0
            data = json.loads(stdout)
            return float(data['format']['duration'])
        except Exception:
            logger.debug("ffprobe duration lookup failed", exc_info=True)
            return 0


    async def get_attachment_info(self, b62_id: str, requesting_guild_id: int | None = None):
        if isinstance(b62_id, str) and b62_id.startswith(('http://', 'https://')):
            filename = b62_id.rsplit('/', 1)[-1].split('?', 1)[0] or 'audio'
            return b62_id, filename
        try:
            guild_id, channel_id, message_id = decode_full_id(b62_id)
            if requesting_guild_id is not None and guild_id != requesting_guild_id:
                logger.warning("Cross-guild attachment access blocked: request=%s source=%s", requesting_guild_id, guild_id)
                return None, None
            guild = self.bot.get_guild(guild_id) or await self.bot.fetch_guild(guild_id)
            if not guild: return None, None
            channel = guild.get_channel(channel_id) or await guild.fetch_channel(channel_id)
            if not channel: return None, None
            msg = await channel.fetch_message(message_id)
            if msg.attachments:
                return msg.attachments[0].url, msg.attachments[0].filename
        except Exception as e:
            logging.debug(f"Universal ID format match but lookup failed ({b62_id}): {e}")
        return None, None


    async def enqueue_track(self, guild_id: int, track: tuple) -> bool:
        """ギルドごとのキュー上限を守ってトラックを追加する。"""
        queue = self.get_state(guild_id)['queue']
        if queue.full():
            return False
        await queue.put(track)
        self._save_music_snapshot(guild_id)
        return True
