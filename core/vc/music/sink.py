import discord
from core.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands, tasks
import asyncio
import time
import types
import logging
import string
import subprocess
import json
import io
import os
import shlex
import tempfile
import yt_dlp
import struct
import math  # 追加: Timerクラスのサイン波計算で必要
from discord.ext import voice_recv
import threading
import random
import numpy as np
from scipy import signal
import numpy as np
import re
import wave
import discord.opus
from core.vc import voice_restore
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import FAILED, MUSIC, SUCCESS
from core.vc.music_activity import build_music_activity_snapshot

from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")




RECORDING_ENABLED = False
BYTES_PER_SECOND = 48_000 * 2 * 2
FRAME_SIZE = 960 * 2 * 2
MAX_GAP_SECONDS = 5.0

class AudioSink(voice_recv.AudioSink):
    def __init__(self, bot, vc, update_callback=None):
        super().__init__()
        self.disabled = not RECORDING_ENABLED
        self.buffers = {}
        self.user_start_time = {}
        self.decoders = {}
        if self.disabled:
            logger.warning("AudioSink was created while recording is disabled; ignoring all incoming audio.")
            return
        self.bot = bot
        self.vc = vc  # DAVE復号のためVoiceRecvClientへの参照を保持
        self.buffers = {}
        self.user_start_time = {}  # ユーザーごとの録音開始時刻(壁時計基準)
        # Opusはステートフル(フレーム間の予測)なコーデックのため、
        # ユーザー(SSRC)ごとにデコーダーインスタンスを使い回して継続性を保つ
        self.decoders = {}
        self.packet_count = 0
        self.update_callback = update_callback
        self.last_update_time = 0
 
        # --- 診断用カウンタ ---
        self.write_call_count = 0
        self.dave_error_count = 0
        self.opus_error_count = 0
        self.total_frame_count = 0
 
    def wants_opus(self) -> bool:
        # voice_recv標準のPCMデコード経路(DAVE非対応)は使わず、
        # 生のOpusフレームを受け取って自前で DAVE復号 → Opusデコードする
        return True
 
    def write(self, user, data: voice_recv.VoiceData):
        if self.disabled:
            return
        try:
            self._write_inner(user, data)
        except Exception as e:
            # ここに来る例外は DAVE復号/Opusデコード以外の想定外のバグ。
            # voice_recv 側が write() の例外を握りつぶすことがあるため、
            # 必ず自分でログに出して見えるようにしておく。
            logger.error(f"[REC] AudioSink.write() で予期せぬエラー: {e!r}", exc_info=True)
 
    def _write_inner(self, user, data: voice_recv.VoiceData):
        # write() が実際に呼ばれているかどうかを独立してカウント
        # (opusデータの有無に関わらず、呼び出された時点でカウントする)
        self.write_call_count += 1
 
        raw_opus = getattr(data, 'opus', None)
        if not raw_opus:
            return
 
        if user is not None:
            user_key = f"{user.name}_{user.id}"
            user_id = user.id
        elif hasattr(data, 'ssrc') and data.ssrc:
            user_key = f"Speaker_{data.ssrc}"
            user_id = data.ssrc
        else:
            user_key = "Unknown_Speaker"
            user_id = 0
 
        self.total_frame_count += 1
 
        # --- 1. DAVE(E2EE)復号 ---
        try:
            payload = self.vc.dave_decrypt(user_id, bytes(raw_opus))
        except Exception as e:
            self.dave_error_count += 1
            if self.dave_error_count <= 3:  # ログが埋め尽くされないよう最初の数回だけ詳細を出す
                logger.error(f"[REC] DAVE decrypt failed for {user_key}: {e!r}", exc_info=True)
            return
 
        # --- 2. Opusデコード(ユーザーごとにデコーダーを使い回す) ---
        if user_key not in self.decoders:
            self.decoders[user_key] = discord.opus.Decoder()
        try:
            pcm = self.decoders[user_key].decode(payload, fec=False)
        except discord.opus.OpusError as e:
            self.opus_error_count += 1
            logger.debug(f"Opus decode skipped corrupted packet: {e}")
            return
 
        if not pcm:
            return
 
        now = time.time()
        if user_key not in self.buffers:
            self.buffers[user_key] = bytearray()
            self.user_start_time[user_key] = now
 
        # --- 3. 無音区間のゼロ埋め補正 ---
        # Discordは無音区間(VAD/DTX)ではパケットを送信しないため、
        # 受信したPCMをただ連結するだけだと発話同士が押し詰められて
        # しまう。壁時計を基準に本来あるべきバッファ長を計算し、
        # 不足分を無音(ゼロ)で埋めてから新しいPCMを追加する。
        elapsed = now - self.user_start_time[user_key]
        expected_len = int(elapsed * BYTES_PER_SECOND)
        expected_len -= expected_len % FRAME_SIZE
 
        current_len = len(self.buffers[user_key])
        if expected_len > current_len:
            gap = expected_len - current_len
            max_gap_bytes = int(MAX_GAP_SECONDS * BYTES_PER_SECOND)
            if gap > max_gap_bytes:
                gap = max_gap_bytes
                self.user_start_time[user_key] = now - (current_len + gap) / BYTES_PER_SECOND
            self.buffers[user_key].extend(b'\x00' * gap)
 
        self.buffers[user_key].extend(pcm)
        self.packet_count += 1
 
        # 3秒以上経過した場合のみメッセージ編集を呼び出す（レートリミット回避）
        if now - self.last_update_time >= 3.0 and self.update_callback:
            self.last_update_time = now
            asyncio.run_coroutine_threadsafe(
                self.update_callback(self.packet_count),
                self.bot.loop
            )
 
    def cleanup(self):
        # 注意: voice_recv は listen 終了時にこの cleanup() を
        # ファイナライザとして自動的に呼び出す(AudioSource.cleanup()と同様の仕様)。
        # そのため stop_listening() を呼んだ後では buffers はすでに空になっている。
        self.buffers.clear()
        self.user_start_time.clear()
        self.decoders.clear()
