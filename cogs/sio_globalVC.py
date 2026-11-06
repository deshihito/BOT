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
from core.vc import voice_restore
from core.legacy import Responder
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]
from core.vc.globalvc.audio import logger, GlobalAudioSink, _SILENCE, mix_pcm_frames, _Track, GlobalAudioSource, _log_play_end, _ensure_playing, _start_room_playback, _request_playback, _JoinRefused  # noqa: F401
from core.vc.globalvc.chat import logger, ChatMixin  # noqa: F401
from core.vc.globalvc.common import logger, DISCORD_SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, FRAME_SIZE, FRAME_DURATION, FRAME_BYTE_SIZE, MAX_BUFFER_FRAMES, JITTER_PREFILL_FRAMES, TAIL_FLUSH_SECONDS, TRACK_IDLE_SECONDS, PLAYBACK_WATCHDOG_SECONDS, PLAYBACK_WATCHDOG_IDLE_SECONDS, STALE_VC_GRACE_SECONDS  # noqa: F401
from core.vc.globalvc.connect import logger, ConnectMixin  # noqa: F401
from core.vc.globalvc.manage import logger, ManageMixin  # noqa: F401
from core.vc.globalvc.restore import logger, RestoreMixin  # noqa: F401
from core.vc.globalvc.rooms import logger, RoomConfig, ROOMS, GLOBAL_ROOMS, _room_to_dict, _room_from_dict, _persist_rooms, _load_rooms, _persist_join, _clear_join, _remove_vc_from_rooms, _prune_dead_clients, _disconnect_and_cleanup, _watchdog_interval_seconds, _WEBHOOK_BANNED_WORDS, _safe_webhook_username, _can_delete_room  # noqa: F401
from core.vc.globalvc.textlink import logger, TextLink, ROOM_TEXT_LINKS, CHANNEL_TO_ROOM, _text_link_to_dict, _persist_text_links, _restore_text_links, _remove_text_link  # noqa: F401
from core.vc.globalvc.ui import logger, _RoomJoinButton, _PrivateRoomJoinModal, GlobalRoomListView  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class GlobalVCCog(ConnectMixin, RestoreMixin, ManageMixin, ChatMixin, commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self._join_locks: dict[int, asyncio.Lock] = {}

    async def cog_load(self):
        _load_rooms()
        self._playback_watchdog.start()

    async def cog_unload(self):
        self._playback_watchdog.cancel()

    def _sync_watchdog_interval(self) -> None:
        """接続状況に合わせて watchdog の間隔を切り替える。

        change_interval は実行中のスリープにも即時反映されるので、ルームへの接続が
        来た直後から短い間隔に戻る。
        """
        interval = _watchdog_interval_seconds()
        loop = self._playback_watchdog
        if loop.seconds != interval:
            loop.change_interval(seconds=interval)

    @tasks.loop(seconds=PLAYBACK_WATCHDOG_SECONDS)
    async def _playback_watchdog(self):
        """再接続や外部からの stop などで再生が止まったサーバーを、定期的に見回って再開させる。"""
        _prune_dead_clients()
        for clients in list(GLOBAL_ROOMS.values()):
            for vc in list(clients):
                _ensure_playing(vc)
        self._sync_watchdog_interval()


async def setup(bot: commands.Bot):
    await bot.add_cog(GlobalVCCog(bot))
