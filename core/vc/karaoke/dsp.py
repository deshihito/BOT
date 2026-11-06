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

from core.vc.karaoke.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.karaoke.common import CHANNELS  # noqa: F401

logger = logging.getLogger("cogs.sio_karaoke")


patch_voice_recv_client()


def resample_48k_to_16k(pcm_data: bytes) -> bytes:
    audio_16bit = np.frombuffer(pcm_data, dtype=np.int16)
    if len(audio_16bit) == 0:
        return b""
    audio_stereo = audio_16bit.reshape(-1, CHANNELS)
    audio_mono = audio_stereo.mean(axis=1)
    audio_16k = audio_mono[::3].astype(np.int16)
    return audio_16k.tobytes()


def clean_text(text: str) -> str:
    """比較のために記号やスペースを排除"""
    return re.sub(r'[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]', '', text)
