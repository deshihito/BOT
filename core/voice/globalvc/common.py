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

logger = logging.getLogger("cogs.sio_globalVC")

DISCORD_SAMPLE_RATE = 48000
CHANNELS = 2
SAMPLE_WIDTH = 2
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH
FRAME_DURATION = 0.02  # 20ms
FRAME_BYTE_SIZE = int(DISCORD_SAMPLE_RATE * FRAME_DURATION * FRAME_SIZE)  # 3840 bytes
MAX_BUFFER_FRAMES = 50  # 話者ごとの再生バッファの上限 (20ms * 50 = 約1秒分)
JITTER_PREFILL_FRAMES = 3  # 話し始めにこの分(60ms)溜めてから流し、到着の揺れを吸収する
TAIL_FLUSH_SECONDS = 0.08  # 溜まりきらない端数も、新しい音声がこれだけ来なければ流しきる
TRACK_IDLE_SECONDS = 2.0   # 無音が続いた話者のバッファを破棄するまでの時間
PLAYBACK_WATCHDOG_SECONDS = 2.0  # 再生が止まっていないか見回る間隔 (接続中のルームがある間)
PLAYBACK_WATCHDOG_IDLE_SECONDS = 30.0  # 接続中のルームが無い間の見回り間隔 (見回す対象が無いので伸ばす)
STALE_VC_GRACE_SECONDS = 15.0    # 切断されたままの接続をルーム一覧から外すまでの猶予 (再接続中は消さない)
