from __future__ import annotations

import asyncio
import functools
import io
import logging
import os
import threading
import time
import wave
from collections import deque

import numpy as np

import aiohttp
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv

from core.support.legacy import Responder
from core.general.ai import logfare
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import voice_connection_failed
from core.vc.voice_media import add_receive_sink, remove_receive_sink
from core.vc.transcription.speech_vad import SpeechDetector
from core.support.emojis import FAILED, LOADING, LOUPE, PAUSE

try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

logger = logging.getLogger("cogs.sio_transcription")

# ============================================================
# 定数設定
# ============================================================
DISCORD_SAMPLE_RATE = 48000  # Discord 音声 (48kHz)
TRANSCRIPTION_SAMPLE_RATE = 16000  # Logfareへ送る音声 (16kHz)
CHANNELS = 2
SAMPLE_WIDTH = 2
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH

# 無音判定の閾値（秒）
SILENCE_THRESHOLD_SEC = 0.8
MIN_UTTERANCE_SECONDS = 0.4
MAX_UTTERANCE_SECONDS = 20
# 発話として扱うために必要な「声のあるフレーム」数（1フレーム=20ms）。咳やクリックノイズ除外用
MIN_LOUD_FRAMES = 10

# ------------------------------------------------------------
# 雑音カット（声だけを残す）設定。誤反応が多ければ厳しく、声が欠けるなら緩くする
# ------------------------------------------------------------
VAD_AGGRESSIVENESS = 3            # 0〜3。大きいほど声以外を厳しく弾く（SpeechDetector が受け付けない場合は 2 に戻す）
ONSET_FRAMES = 5                  # 発話開始に必要な「連続した声フレーム」数（5×20ms=100ms）。単発のクリック・物音を除外
CONFIRM_FRAMES = 2                # 発話中に「声」と認める連続フレーム数。物音で無音判定が延びるのを防ぐ
HANGOVER_SEC = 0.25               # 声が途切れた後もそのまま残す長さ（語尾・息継ぎ用）。超えた雑音は無音に置換する
TAIL_PAD_SEC = 0.2                # 送信時、最後の声のあとに残す余白
MIN_VOICE_RMS = 120               # これ未満の音量は声とみなさない（int16換算）
VOICE_SNR_RATIO = 3.0             # 背景ノイズ量のこの倍以上の音だけ声とみなす（約+9.5dB）
VOICE_BAND_HZ = (120.0, 4000.0)   # 声の帯域
MIN_VOICE_BAND_RATIO = 0.5        # 全エネルギーのうち声の帯域が占める割合の下限（ファン・風・キーボード対策）
MIN_VOICE_RATIO = 0.2             # 送信する区間のうち声フレームが占める割合の下限
HIGHPASS_HZ = 80.0                # これ未満（ゴロゴロ音・吹かれ）を除去
# 発話の頭が欠けないよう、発話開始の直前から付け足す音声（秒）
PRE_ROLL_SEC = 0.3
# パケットが届かなかった区間（DTX・ロス）を無音で埋める上限（秒）
MAX_GAP_FILL_SEC = 1.0
# 小さい声を持ち上げる（ピークがこの割合になるまで、最大 MAX_GAIN 倍）
TARGET_PEAK = 0.9
MAX_GAIN = 8.0
# 環境変数にディレクトリを入れると、Logfareへ送った音声をWAVで保存する（原因調査用）
DEBUG_DUMP_DIR = os.environ.get("STT_DEBUG_DIR")

FRAME_SEC = 0.02  # Discord の Opus 1フレーム
BYTES_PER_FRAME = int(DISCORD_SAMPLE_RATE * FRAME_SEC) * FRAME_SIZE  # 48kHz ステレオ 16bit の 20ms 分

# voice_recv が無音時に渡してくる Opus パケット
OPUS_SILENCE = b"\xf8\xff\xfe"


from functools import partial as _partial
from core.support.embeds import we as _shared_we
we = _partial(_shared_we, color=0x2ECC71)
