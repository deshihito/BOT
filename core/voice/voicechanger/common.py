from __future__ import annotations

import logging
import threading
import time
import numpy as np

import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv

from core.legacy import Responder
from core import vc_feature_restore
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice_session import VoiceBusy, get_manager
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU

logger = logging.getLogger("cogs.sio_voicechanger")

# ============================================================
# 定数定義
# ============================================================
SAMPLE_RATE = 48000          # 48kHz
CHANNELS = 2                 # ステレオ
SAMPLE_WIDTH = 2             # 16bit = 2byte
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH
BYTES_PER_SECOND = SAMPLE_RATE * FRAME_SIZE
CHUNK_DURATION = 0.02        # 20ms
CHUNK_BYTES = int(CHUNK_DURATION * BYTES_PER_SECOND)  # 3840 bytes

OPUS_SILENCE = b"\xf8\xff\xfe"

# 20ms 超低遅延モードのデフォルト値
DEFAULT_TARGET_BUFFER_MS = 20.0   # 目標バッファ量 (20ms)
DEFAULT_MAX_BUFFER_MS = 40.0      # 上限バッファ量 (40msを超えたらトリム)
DEFAULT_FADE_MS = 5.0             # 接続時のクロスフェード長 (5ms)


from functools import partial as _partial
from core.embeds import we as _shared_we
we = _partial(_shared_we, color=0x3498DB)
