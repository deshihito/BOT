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
from core.voice.globalvc.rooms import ROOMS, _clear_join, _load_rooms  # noqa: F401
from core.voice.globalvc.textlink import _restore_text_links  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class RestoreMixin:
    async def restore_after_restart(self) -> None:
        """再起動前のルーム参加状態をスナップショットから復旧する（main.py の on_ready から呼ばれる）。

        前回正常終了したかは問わない。保存済みの参加状態があれば常に
        reconcile し、復旧できないギルド（ルーム・チャンネル消滅、人がいない、
        再接続失敗）は参加スナップショットを掃除する。通知は送らない。
        ルーム定義自体は cog_load で _load_rooms() が復元済みの前提。
        """
        _load_rooms()
        # グロチャのテキスト連携は VC 参加と独立に復旧する（中継は参加が無くても成立する）
        try:
            await _restore_text_links(self.bot)
        except Exception:
            logger.exception("グローバルVC: グロチャ連携の復旧に失敗しました")
        try:
            joins = voice_restore.get_store().section("gvc_joins")
        except Exception:
            logger.exception("グローバルVC: 参加状態の読み込みに失敗しました")
            return
        for guild_key, info in joins.items():
            try:
                guild_id = int(guild_key)
            except (TypeError, ValueError):
                continue
            try:
                restored = await self._restore_join(guild_id, info)
            except Exception:
                logger.exception("グローバルVC: guild %s の復旧に失敗しました", guild_key)
                restored = False
            if not restored:
                _clear_join(guild_id)
        try:
            voice_restore.get_store().flush()
        except Exception:
            logger.debug("グローバルVC: 復旧後の保存に失敗しました", exc_info=True)


    async def _restore_join(self, guild_id: int, info: dict) -> bool:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        room_name = info.get("room_name")
        if not room_name or room_name not in ROOMS:
            logger.info("グローバルVC: guild %s のルーム %s は存在しないため復旧しません", guild_id, room_name)
            return False
        channel = None
        if info.get("voice_channel_id"):
            channel = guild.get_channel(info["voice_channel_id"])
        if channel is None:
            logger.info("グローバルVC: guild %s の復旧先 VC が見つからないため復旧しません", guild_id)
            return False
        members = getattr(channel, "members", None) or []
        if not any(not getattr(m, "bot", False) for m in members):
            logger.info("グローバルVC: guild %s の VC に人がいないため復旧しません", guild_id)
            return False
        text_channel = None
        if info.get("text_channel_id"):
            text_channel = self.bot.get_channel(info["text_channel_id"])
        user = None
        user_id = info.get("user_id")
        if user_id:
            get_member = getattr(guild, "get_member", None)
            user = get_member(user_id) if callable(get_member) else None
        if user is None:
            user = types.SimpleNamespace(
                id=user_id or 0,
                name=info.get("user_name") or "だれか",
                display_name=info.get("user_name") or "だれか",
            )
        try:
            await self._connect_room(guild, channel, user, text_channel or channel, room_name)
        except Exception:
            logger.warning("グローバルVC: guild %s のルーム %s へ再接続できないため復旧しません",
                           guild_id, room_name, exc_info=True)
            return False
        logger.info("グローバルVC: guild %s のルーム %s 参加を復旧しました", guild_id, room_name)
        return True
