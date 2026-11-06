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
from core.vc import vc_feature_restore
from core.vc.vosk_model import ensure_model
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED
from core.emojis import FAILED, MUSIC

try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    Model = None
    KaldiRecognizer = None

logger = logging.getLogger("cogs.sio_karaoke")

DISCORD_SAMPLE_RATE = 48000
VOSK_SAMPLE_RATE = 16000
CHANNELS = 2

# カラオケ用に無音判定を少し短めに設定 (0.5秒)
SILENCE_THRESHOLD_SEC = 0.5
RMS_SILENCE_THRESHOLD = 350
MODEL_PATH = "model"
OPUS_SILENCE = b"\xf8\xff\xfe"


from functools import partial as _partial
from core.embeds import we as _shared_we
# カラオケ風のピンク色を基調色として共通工場を使う
we = _partial(_shared_we, color=0xFF69B4)
