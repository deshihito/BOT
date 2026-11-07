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
from core.support.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.support.emojis import CLOCK, FAILED, MUSIC, PAUSE

from core.vc.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.rec.common import RECORD_LIMIT_SECONDS  # noqa: F401
from core.vc.rec.sink import RecordingSink  # noqa: F401

logger = logging.getLogger("cogs.sio_rec")


class RestoreMixin:
    def _save_resume_snapshot(self, guild_id: int, voice_channel, text_channel, user) -> None:
        """再開に必要な情報だけを保存する（録音データそのものは保存しない）。"""
        vc_feature_restore.save_feature("record", guild_id, vc_feature_restore.build_entry(
            voice_channel_id=getattr(voice_channel, "id", None),
            text_channel_id=getattr(text_channel, "id", None),
            user=user,
            settings={},
        ))


    async def restore_after_restart(self) -> None:
        """再起動前に録音中だったギルドで、同じ設定の新規録音として再開する。

        録音済みの音声はプロセスと一緒に失われているため復元はしない。
        復旧できないギルド（ギルド・チャンネル消滅、人がいない、告知先が無い）は
        スナップショットを掃除する。
        """
        entries = vc_feature_restore.feature_entries("record")
        for guild_id, snapshot in entries.items():
            try:
                restored = await self._restore_session(guild_id, snapshot)
            except Exception:
                logger.exception("guild %s: 録音の自動再開に失敗しました", guild_id)
                restored = False
            if not restored:
                vc_feature_restore.clear_feature("record", guild_id)
        vc_feature_restore.flush_store()


    async def _restore_session(self, guild_id: int, snapshot: dict) -> bool:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        channel_id = snapshot.get("voice_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            logger.info("guild %s: 復旧先の VC が見つからないため録音を再開しません", guild_id)
            return False
        if not vc_feature_restore.has_humans(channel):
            logger.info("guild %s: VC に人がいないため録音を再開しません", guild_id)
            return False
        text_channel = None
        if snapshot.get("text_channel_id"):
            text_channel = self.bot.get_channel(snapshot["text_channel_id"])
        if text_channel is None:
            # 録音中であることを告知できない構成では再開しない（開始時と同じポリシー）
            logger.info("guild %s: 告知先のテキストチャンネルが見つからないため録音を再開しません", guild_id)
            return False
        if not discord.opus.is_loaded():
            logger.info("guild %s: Opus が使えないため録音を再開しません", guild_id)
            return False
        if guild_id in self.sessions:
            return False
        user = vc_feature_restore.resolve_user(guild, snapshot)
        try:
            vc = await self.voice_sessions.acquire(
                guild, channel, "record", user,
                cleanup=self._record_cleanup(guild_id), text_channel=text_channel,
                timeout=30.0,      # DAVE暗号化応答待ちのためタイムアウトを延長
            )
        except Exception:
            logger.warning("guild %s: VC へ再接続できないため録音を再開しません", guild_id, exc_info=True)
            return False

        sink = RecordingSink(bot=self.bot, vc=vc)
        try:
            vc.listen(sink)
        except Exception:
            logger.warning("guild %s: 受信を開始できないため録音を再開しません", guild_id, exc_info=True)
            await self.voice_sessions.release(guild_id, "record", reason="stop")
            return False

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "start": time.time(),
            "channel_name": getattr(channel, "name", ""),
            "status_msg": None,
            "text_channel": text_channel,
            "guild": guild,
            "limit_task": asyncio.create_task(self._stop_at_limit(guild_id)),
        }
        self._save_resume_snapshot(guild_id, channel, text_channel, user)

        # 録音中であることの告知を兼ねた再開通知（開始時の _announce_recording と同じ流儀）
        try:
            await text_channel.send(
                "🔴 **録音を再開しました**（Bot の再起動による自動再開）\n"
                f"ボイスチャンネル **{getattr(channel, 'name', '')}** の音声が録音されます（最長 {RECORD_LIMIT_SECONDS // 60} 分）。"
                "録音されたくない人は退出してください。\n"
                "※ 再起動前に録音していた音声は失われています。新規の録音として開始します。",
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception:
            logger.warning("[REC] 録音再開のお知らせを送れませんでした", exc_info=True)
        logger.info("guild %s: 録音を自動再開しました", guild_id)
        return True
