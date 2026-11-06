"""
Discord ボイスチャンネル録音 Cog

使用方法 (メインファイル側):
    await bot.load_extension("recording_cog")
    # または
    await bot.add_cog(RecordingCog(bot))

必要なライブラリ:
    pip install -U discord.py discord-ext-voice-recv davey
"""

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

from core.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE

logger = logging.getLogger("cogs.sio_rec")

# ============================================================
# 定数
# ============================================================
SAMPLE_RATE = 48000          # Discord の音声は 48kHz 固定
CHANNELS = 2                 # ステレオ
SAMPLE_WIDTH = 2             # 16bit = 2byte
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH          # 1サンプルフレーム = 4byte
BYTES_PER_SECOND = SAMPLE_RATE * FRAME_SIZE   # 192000 byte/s

# これより短い録音はノイズとみなして出力しない (0.2秒)
MIN_SAVE_BYTES = int(0.2 * BYTES_PER_SECOND)

# ステータスメッセージの更新間隔(秒)。Discord のレートリミット回避。
STATUS_UPDATE_INTERVAL = 5.0

# 録音の上限時間(秒)。PCM をメモリに溜め続けるので、これを超えたら自動で停止してファイルを送る。
RECORD_LIMIT_SECONDS = 30 * 60

# RTP タイムスタンプ由来の位置と壁時計由来の位置が離れた場合の再同期閾値
RESYNC_THRESHOLD_BYTES = 5 * BYTES_PER_SECOND

# voice_recv が無音パケットの代わりに流してくる Opus フレーム
OPUS_SILENCE = b"\xf8\xff\xfe"


from core.embeds import we  # noqa: F401  (共通の白 embed 工場)


# ============================================================
# DAVE (Discord E2EE) 対応パッチ（本体は core.vc.voice_recv_patch に集約）
# ============================================================
patch_voice_recv_client()

NOTE_NAMES_SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
NOTE_NAMES_FLAT  = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"]
