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
from core.support.legacy import Responder
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]
from core.vc.globalvc.audio import logger, GlobalAudioSink, _SILENCE, mix_pcm_frames, _Track, GlobalAudioSource, _log_play_end, _ensure_playing, _start_room_playback, _request_playback, _JoinRefused  # noqa: F401
from core.vc.globalvc.chat import logger, ChatMixin  # noqa: F401
from core.vc.globalvc.common import logger, DISCORD_SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, FRAME_SIZE, FRAME_DURATION, FRAME_BYTE_SIZE, MAX_BUFFER_FRAMES, JITTER_PREFILL_FRAMES, TAIL_FLUSH_SECONDS, TRACK_IDLE_SECONDS, PLAYBACK_WATCHDOG_SECONDS, PLAYBACK_WATCHDOG_IDLE_SECONDS, STALE_VC_GRACE_SECONDS  # noqa: F401
from core.vc.globalvc.connect import logger, ConnectMixin  # noqa: F401
from core.vc.globalvc.manage import logger, ManageMixin, Responder  # noqa: F401
from core.vc.globalvc.restore import logger, RestoreMixin  # noqa: F401
from core.vc.globalvc.rooms import logger, RoomConfig, ROOMS, GLOBAL_ROOMS, _room_to_dict, _room_from_dict, _persist_rooms, _load_rooms, _persist_join, _clear_join, _remove_vc_from_rooms, _prune_dead_clients, _disconnect_and_cleanup, _watchdog_interval_seconds, _WEBHOOK_BANNED_WORDS, _safe_webhook_username, _can_delete_room, rotate_room_themes, _room_members, _room_user_count  # noqa: F401
from core.vc.globalvc.themes import THEME_POOL, theme_day, theme_for  # noqa: F401
from core.vc.globalvc.textlink import logger, TextLink, ROOM_TEXT_LINKS, CHANNEL_TO_ROOM, _text_link_to_dict, _persist_text_links, _restore_text_links, _remove_text_link  # noqa: F401
from core.vc.globalvc.ui import logger, _RoomJoinButton, _PrivateRoomJoinModal, GlobalRoomListView, _TextChatToggleView  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class GlobalVCCog(ConnectMixin, RestoreMixin, ManageMixin, ChatMixin, commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self._join_locks: dict[int, asyncio.Lock] = {}

    @commands.command(name="gvcperm", aliases=["常設ルーム作成"],
                      help="常設グローバルVCルームを作成します（Bot管理者のみ）。使い方: !gvcperm ルーム名 [テーマ]")
    async def gvcperm(self, ctx: commands.Context, room_name: str = "", *, theme: str = ""):
        """常設ルームの作成は誤操作防止のため、この ! コマンドからだけ行う。

        テーマを省略すると自動テーマ（日替わり）になる。最大参加サーバー数は
        無制限・公開・説明なしで作る（変えたい場合は通常ルームを使ってください）。
        """
        await self._room_create_impl(
            Responder(ctx), room_name, 0, "", "", theme=theme, permanent=True)

    async def cog_load(self):
        _load_rooms()
        rotate_room_themes()
        self._playback_watchdog.start()
        self._theme_rotation_loop.start()

    async def cog_unload(self):
        self._playback_watchdog.cancel()
        self._theme_rotation_loop.cancel()

    @tasks.loop(hours=1)
    async def _theme_rotation_loop(self):
        """常設ルームの自動テーマを日替わりで回す（JST の日付が変われば進む）。"""
        changed = rotate_room_themes()
        if changed:
            logger.info("グローバルVC: 常設ルームのテーマを更新しました: %s", ", ".join(changed))

    @_theme_rotation_loop.before_loop
    async def _before_theme_rotation_loop(self):
        await self.bot.wait_until_ready()

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
