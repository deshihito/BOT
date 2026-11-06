from __future__ import annotations
import array
import asyncio
import dataclasses
import io
import logging
import re
import sys
import threading
import time
import types
from typing import Optional
import discord
import discord.opus
from discord.ext import commands, tasks
from discord.ext import voice_recv
from core.voice import voice_restore
from core.legacy import Responder
from core.voice.voice_session import VoiceBusy, get_manager
from core.voice.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.voice.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.globalvc.audio import GlobalAudioSink, GlobalAudioSource, _JoinRefused, _start_room_playback  # noqa: F401
from core.voice.globalvc.rooms import GLOBAL_ROOMS, ROOMS, _clear_join, _disconnect_and_cleanup, _persist_join, _prune_dead_clients, _remove_vc_from_rooms  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class ConnectMixin:
    @staticmethod
    def _cleanup(guild_id: int):
        """VC を手放すとき（/voice community の退出・ルーム削除・自動退出・外部切断）にルーム管理から外す。

        外部から切断されたときもここが呼ばれるので、GLOBAL_ROOMS に古い接続が残らない。
        """
        def cleanup(reason: str) -> None:
            _clear_join(guild_id)
            for clients in list(GLOBAL_ROOMS.values()):
                for vc in list(clients):
                    if getattr(getattr(vc, "guild", None), "id", None) != guild_id:
                        continue
                    _remove_vc_from_rooms(vc)
                    remove_receive_sink(vc, "gvc")
                    remove_audio_source(vc, "gvc")
                    if hasattr(vc, "global_source"):
                        delattr(vc, "global_source")
        return cleanup


    async def _connect_room(self, guild: discord.Guild, vc_channel, user, text_channel, room_name: str):
        """VC に接続し、受信Sink・再生Sourceを付けてルームへ登録する。ルーム作成時と参加時で共通。"""
        lock = self._join_locks.setdefault(guild.id, asyncio.Lock())
        async with lock:  # 同じサーバーからの同時参加で二重に接続しないようにする
            _prune_dead_clients()
            room = ROOMS.get(room_name)
            if room is None:
                raise _JoinRefused(f"ルーム **{room_name}** は存在しません。")
            for name, clients in GLOBAL_ROOMS.items():
                if any(c.guild and c.guild.id == guild.id for c in clients):
                    raise _JoinRefused(f"このサーバーはすでにルーム **{name}** に参加しています。")
            if room.max_servers and len(GLOBAL_ROOMS.get(room_name, [])) >= room.max_servers:
                raise _JoinRefused(f"ルーム **{room_name}** は満員です ({room.max_servers}サーバーまで)。")

            # 音楽・読み上げ・文字起こしとは同じVC接続を共有し、それ以外は VoiceBusy になる
            vc = await self.voice_sessions.acquire(
                guild, vc_channel, "global", user,
                cleanup=self._cleanup(guild.id), text_channel=text_channel, force=True, timeout=30.0,
            )

            try:
                vc.global_source = GlobalAudioSource()
                add_receive_sink(vc, "gvc", GlobalAudioSink(room_name, vc))
            except Exception:
                remove_receive_sink(vc, "gvc")
                remove_audio_source(vc, "gvc")
                if hasattr(vc, "global_source"):
                    delattr(vc, "global_source")
                # 途中で失敗したら VC を掴んだままにせず手放す (接続だけ残って無音になるのを防ぐ)
                await self._leave_room(vc, reason="error")
                raise

            vc._gvc_down_since = None
            members = GLOBAL_ROOMS.setdefault(room_name, [])
            if vc not in members:
                members.append(vc)
            _persist_join(
                guild.id, room_name, getattr(vc_channel, "id", None),
                getattr(text_channel, "id", None), user,
            )

            # 参加してきたサーバー自身はもちろん、すでに接続中の他サーバーも、止まっていれば再生を始める
            _start_room_playback(room_name)
            self._sync_watchdog_interval()
            return vc


    async def _leave_room(self, vc, *, reason: str = "stop", notice=None) -> None:
        guild = getattr(vc, "guild", None)
        if guild is None or not await self.voice_sessions.release(guild.id, "global", reason=reason, notice=notice):
            await _disconnect_and_cleanup(vc)
