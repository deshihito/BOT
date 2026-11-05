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
from core import voice_restore
from core.legacy import Responder
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers

logger = logging.getLogger("cogs.sio_globalVC")


@dataclasses.dataclass
class TextLink:
    guild_id: int
    channel_id: int
    webhook: discord.Webhook


ROOM_TEXT_LINKS: dict[str, list[TextLink]] = {}


CHANNEL_TO_ROOM: dict[int, str] = {}


async def _remove_text_link(channel_id: int, *, delete_webhook: bool = True) -> Optional[str]:
    """指定チャンネルのグロチャ連携を解除する。所属していたルーム名を返す。"""
    room_name = CHANNEL_TO_ROOM.pop(channel_id, None)
    if room_name is None:
        return None

    links = ROOM_TEXT_LINKS.get(room_name, [])
    for link in list(links):
        if link.channel_id == channel_id:
            links.remove(link)
            if delete_webhook:
                try:
                    await link.webhook.delete(reason="グロチャ連携解除")
                except Exception:
                    logger.debug("webhook 削除失敗 (無視)", exc_info=True)
    if not links:
        ROOM_TEXT_LINKS.pop(room_name, None)
    return room_name
