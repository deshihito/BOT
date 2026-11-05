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

from core.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.music.common import SNAPSHOT_INTERVAL_SECONDS  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class RestoreMixin:
    async def cog_load(self):
        if not self._snapshot_loop.is_running():
            self._snapshot_loop.start()


    @tasks.loop(seconds=SNAPSHOT_INTERVAL_SECONDS)
    async def _snapshot_loop(self):
        """再生中ギルドのスナップショットを定期保存する。

        終了時保存ではなく使用中の継続保存が本命: プロセスが SIGKILL されても
        失う再生位置は最大でこの間隔分だけになる。
        """
        for guild_id in list(self.states):
            self._save_music_snapshot(guild_id)
        try:
            voice_restore.get_store().maybe_flush()
        except Exception:
            logger.debug("音楽スナップショットの定期保存に失敗しました", exc_info=True)


    def _serialize_music_state(self, guild_id: int) -> dict | None:
        """復旧スナップショット用に再生状態を JSON 化できる形へ変換する。

        - キュー要素は (入力, ファイル名, b62_id, is_yt) の4タプル。YouTube /
          SoundCloud の入力は再解析可能なページ URL（既存の前提どおり）。
        - current_track は (ストリームURL, ファイル名, 長さ, b62_id, is_yt) の
          5タプル。YouTube のストリーム URL は短時間で失効するため保存せず、
          ページ URL（current_yt_page_url）から復旧時に再取得する。
        - 再生位置は保存時点の elapsed_offset として確定させる。
        復旧対象（再生中の曲もキューも無い）なら None を返す = 保存しない。
        """
        state = self.states.get(guild_id)
        if state is None:
            return None
        queue_items = []
        for item in list(state['queue']._queue):
            try:
                target_input, filename, b62_id, is_yt = item
            except (TypeError, ValueError):
                continue
            queue_items.append([target_input, filename, b62_id, bool(is_yt)])
        current = None
        track = state.get('current_track')
        if track:
            try:
                stream_url, filename, duration, b62_id, is_yt = track
            except (TypeError, ValueError):
                stream_url = None
            if stream_url is not None:
                elapsed = float(state.get('elapsed_offset', 0) or 0)
                if not state.get('is_paused') and state.get('start_time'):
                    elapsed += max(0.0, time.time() - float(state['start_time'])) * float(state.get('speed', 1.0) or 1.0)
                if duration:
                    elapsed = min(elapsed, float(duration))
                current = {
                    "filename": filename, "duration": duration, "b62_id": b62_id,
                    "is_yt": bool(is_yt),
                    "page_url": state.get('current_yt_page_url'),
                    "stream_url": None if is_yt else stream_url,
                    "elapsed": max(0.0, elapsed),
                }
        if current is None and not queue_items:
            return None
        session = self.voice_sessions.get(guild_id)
        panel = state.get('panel_message')
        panel_ref = None
        if panel is not None and getattr(panel, "id", None) is not None:
            panel_channel = getattr(panel, "channel", None)
            if panel_channel is not None:
                panel_ref = {"channel_id": getattr(panel_channel, "id", None),
                             "message_id": panel.id}
        return {
            "voice_channel_id": session.channel_id if session else None,
            "text_channel_id": getattr(session.text_channel, "id", None) if session else None,
            "user_id": session.user_id if session else None,
            "user_name": session.user_name if session else None,
            "queue": queue_items,
            "current": current,
            "is_paused": bool(state.get('is_paused')),
            "volume": state.get('volume', self.default_volume),
            "speed": state.get('speed', self.default_speed),
            "eq": state.get('eq', self.default_eq),
            "custom_eq_filter": state.get('custom_eq_filter'),
            "loop_mode": state.get('loop_mode', 'off'),
            "shuffle_enabled": bool(state.get('shuffle_enabled')),
            "panel": panel_ref,
            "saved_at": time.time(),
        }


    def _save_music_snapshot(self, guild_id: int) -> None:
        """現在の再生状態をスナップショットへ書く（対象が無ければエントリを消す）。"""
        try:
            store = voice_restore.get_store()
            store.set_entry("music", str(guild_id), self._serialize_music_state(guild_id))
            store.maybe_flush()
        except Exception:
            logger.debug("guild %s: 音楽スナップショットの保存に失敗しました", guild_id, exc_info=True)


    def _clear_music_snapshot(self, guild_id: int) -> None:
        try:
            store = voice_restore.get_store()
            store.set_entry("music", str(guild_id), None)
            store.maybe_flush()
        except Exception:
            logger.debug("guild %s: 音楽スナップショットの削除に失敗しました", guild_id, exc_info=True)


    async def restore_after_restart(self) -> None:
        """再起動前の再生状態をスナップショットから復旧する（main.py の on_ready から呼ばれる）。

        前回正常終了したかは問わない。スナップショットが存在すれば常に
        reconcile し、復旧できないギルド（ギルド・チャンネル消滅、人がいない、
        再接続失敗）はスナップショットを掃除する。ユーザーへの通知は送らない。
        """
        try:
            snapshots = voice_restore.get_store().section("music")
        except Exception:
            logger.exception("音楽スナップショットの読み込みに失敗しました")
            return
        for guild_key, snapshot in snapshots.items():
            try:
                guild_id = int(guild_key)
            except (TypeError, ValueError):
                continue
            try:
                restored = await self._restore_guild_music(guild_id, snapshot)
            except Exception:
                logger.exception("guild %s: 音楽の復旧に失敗しました", guild_key)
                restored = False
            if not restored:
                self._clear_music_snapshot(guild_id)
        try:
            voice_restore.get_store().flush()
        except Exception:
            logger.debug("音楽復旧後の保存に失敗しました", exc_info=True)


    async def _restore_guild_music(self, guild_id: int, snapshot: dict) -> bool:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        channel_id = snapshot.get("voice_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            logger.info("guild %s: 復旧先の VC が見つからないため音楽を復旧しません", guild_id)
            return False
        members = getattr(channel, "members", None) or []
        if not any(not getattr(m, "bot", False) for m in members):
            logger.info("guild %s: VC に人がいないため音楽を復旧しません", guild_id)
            return False
        text_channel = None
        if snapshot.get("text_channel_id"):
            text_channel = self.bot.get_channel(snapshot["text_channel_id"])
        user = None
        user_id = snapshot.get("user_id")
        if user_id:
            get_member = getattr(guild, "get_member", None)
            user = get_member(user_id) if callable(get_member) else None
        if user is None:
            user = types.SimpleNamespace(
                id=user_id or 0,
                name=snapshot.get("user_name") or "だれか",
                display_name=snapshot.get("user_name") or "だれか",
            )
        try:
            await self._acquire_music(guild, channel, user, text_channel or channel)
        except Exception:
            logger.warning("guild %s: VC へ再接続できないため音楽を復旧しません", guild_id, exc_info=True)
            return False

        state = self.get_state(guild_id)
        # check_queue の送信先ゲート（current_ctx / current_interaction）を復旧先で満たす。
        state['current_ctx'] = text_channel or channel
        for key in ('volume', 'speed', 'eq', 'custom_eq_filter', 'loop_mode'):
            if snapshot.get(key) is not None:
                state[key] = snapshot[key]
        state['shuffle_enabled'] = bool(snapshot.get('shuffle_enabled'))
        for item in snapshot.get('queue') or []:
            try:
                target_input, filename, b62_id, is_yt = item
            except (TypeError, ValueError):
                continue
            if state['queue'].full():
                break
            state['queue'].put_nowait((target_input, filename, b62_id, bool(is_yt)))

        # 音楽パネル復活: 保存済みメッセージを取り直して新しい View を付け直す。
        # 取れない場合は新規投稿しない（勝手に投稿しない）。
        panel_ref = snapshot.get('panel')
        if panel_ref:
            try:
                panel_channel = self.bot.get_channel(panel_ref.get("channel_id"))
                if panel_channel is not None:
                    state['panel_message'] = await panel_channel.fetch_message(panel_ref.get("message_id"))
            except Exception:
                logger.debug("guild %s: 音楽パネルの再取得に失敗しました", guild_id, exc_info=True)
                state['panel_message'] = None

        current = snapshot.get('current')
        if current:
            if not await self._restore_current_track(
                guild_id, state, current, paused=bool(snapshot.get('is_paused'))
            ):
                return False
        elif not state['queue'].empty():
            await self.check_queue(guild_id)
        else:
            await self.update_panel(guild_id)
        self._save_music_snapshot(guild_id)
        logger.info("guild %s: 音楽の再生状態を復旧しました", guild_id)
        return True


    async def _restore_current_track(self, guild_id: int, state: dict, current: dict, *, paused: bool) -> bool:
        """再生中だった曲を復旧する。

        - 再生中だった場合: 再解析可能な入力をキューの先頭へ戻し、elapsed_offset を
          保持したまま check_queue に任せる。YouTube はページ URL から新鮮な
          ストリームを取得し、既存の -ss シークで保存位置から再開する。
        - 一時停止中だった場合: その場で解決して current_track を組み立て直し、
          止めたままにする（再開操作は従来のパネル／コマンド経路に委ねる）。
        """
        is_yt = bool(current.get('is_yt'))
        filename = current.get('filename')
        b62_id = current.get('b62_id')
        elapsed = float(current.get('elapsed') or 0)
        if is_yt:
            page_url = current.get('page_url')
            if not page_url:
                return False
            if paused:
                info = await self.get_yt_info(page_url)
                state['current_yt_page_url'] = info['webpage_url']
                state['current_thumbnail_url'] = info.get('thumbnail') or None
                state['current_yt_headers'] = info['http_headers']
                state['current_track'] = (info['stream_url'], filename or info['title'],
                                          info['duration'], b62_id, True)
            else:
                state['queue']._queue.appendleft((page_url, filename, b62_id, True))
        else:
            url = current.get('stream_url')
            if b62_id and isinstance(b62_id, str) and not b62_id.startswith(('http://', 'https://')):
                fresh_url, _ = await self.get_attachment_info(b62_id, guild_id)
                if fresh_url:
                    url = fresh_url
            if not url:
                return False
            if paused:
                state['current_yt_page_url'] = None
                state['current_thumbnail_url'] = None
                state['current_yt_headers'] = {}
                state['current_track'] = (url, filename, current.get('duration'), b62_id, False)
            else:
                state['queue']._queue.appendleft((url, filename, b62_id, False))
        state['elapsed_offset'] = elapsed
        if paused:
            state['is_paused'] = True
            await self.update_panel(guild_id)
        else:
            state['is_paused'] = False
            await self.check_queue(guild_id)
        return True
