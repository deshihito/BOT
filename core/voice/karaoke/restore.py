from __future__ import annotations
import asyncio
import json
import logging
import os
import threading
import time
import re
from difflib import SequenceMatcher
import numpy as np
import aiohttp
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.legacy import Responder
from core import vc_feature_restore
from core.vosk_model import ensure_model
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED
from core.emojis import FAILED, MUSIC
try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    Model = None
    KaldiRecognizer = None

from core.voice.karaoke.common import *  # noqa: F401,F403 - shared constants/helpers

logger = logging.getLogger("cogs.sio_karaoke")


class RestoreMixin:
    def _save_resume_snapshot(self, guild_id: int, voice_channel, text_channel, user, target_lyrics: str) -> None:
        """再開に必要な情報だけを保存する（歌唱履歴・採点は保存しない）。"""
        vc_feature_restore.save_feature("karaoke", guild_id, vc_feature_restore.build_entry(
            voice_channel_id=getattr(voice_channel, "id", None),
            text_channel_id=getattr(text_channel, "id", None),
            user=user,
            settings={"target_lyrics": target_lyrics},
        ))


    async def restore_after_restart(self) -> None:
        """再起動前にカラオケ中だったギルドで、同じお題の新規セッションとして再開する。

        歌唱履歴（採点のもと）はプロセスと一緒に失われているため復元はしない。
        復旧できないギルド（ギルド・チャンネル消滅、人がいない、モデル不備）は
        スナップショットを掃除する。
        """
        entries = vc_feature_restore.feature_entries("karaoke")
        for guild_id, snapshot in entries.items():
            try:
                restored = await self._restore_session(guild_id, snapshot)
            except Exception:
                logger.exception("guild %s: カラオケの自動再開に失敗しました", guild_id)
                restored = False
            if not restored:
                vc_feature_restore.clear_feature("karaoke", guild_id)
        vc_feature_restore.flush_store()
