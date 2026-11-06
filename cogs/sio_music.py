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
from core.vc.music.common import logger, YTDL_OPTIONS, YTDL_COOKIE_FILE, BASE62, MAX_QUEUE_SIZE, MAX_PLAYLIST_ITEMS, SPOTIFY_PLAYLIST_RE, SOUNDCLOUD_URL_RE, soundcloud_url_kind, NICOVIDEO_URL_RE, niconico_url_kind, MAX_TTS_CHARS, LOOP_CHOICES, PLAYLIST_ACTION_CHOICES, PLAYLIST_SCOPE_CHOICES, MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED, PANEL_TIMEOUT_SECONDS, SNAPSHOT_INTERVAL_SECONDS, SAFE_CUSTOM_AUDIO_FILTERS, build_atempo_filters, is_safe_custom_audio_filter, EQ_SETTINGS, FFMPEG_REALTIME_PRESETS, build_ffmpeg_headers, FFmpegPCMAudioDiagnostics, encode_full_id, decode_full_id, we  # noqa: F401
from core.vc.music.connection import logger, ConnectionMixin  # noqa: F401
from core.vc.music.loader import logger, LoaderMixin  # noqa: F401
from core.vc.music.panel import logger, PanelMixin  # noqa: F401
from core.vc.music.playback import logger, PlaybackMixin  # noqa: F401
from core.vc.music.playlists import logger, PlaylistsMixin  # noqa: F401
from core.vc.music.restore import logger, RestoreMixin  # noqa: F401
from core.vc.music.search import logger, SearchMixin  # noqa: F401
from core.vc.music.sink import logger, RECORDING_ENABLED, BYTES_PER_SECOND, FRAME_SIZE, MAX_GAP_SECONDS, AudioSink  # noqa: F401
from core.vc.music.sources import logger, SourcesMixin  # noqa: F401
from core.vc.music.spatial import logger, PythonSpatialAudioSource, SpatialControlView  # noqa: F401
from core.vc.music.state import logger, StateMixin  # noqa: F401
from core.vc.music.ui import logger, SearchModal, CustomEQModal, VoiceControlView, build_music_panel_layout, PlaylistNameModal, PlaylistLibraryView  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class VoiceCog(StateMixin, LoaderMixin, ConnectionMixin, PanelMixin, SourcesMixin, SearchMixin, PlaybackMixin, PlaylistsMixin, RestoreMixin, commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.reaction_enabled = {}
        self.emoji_sounds = {}
        self.states = {} 
        self.ir_l_id = "d424KTRkAlaetACCuFZOCjUtFNjho1t5" 
        self.ir_r_id = "d424KTRkAlaetACCuFZOCjUtFO0p0TMN"
        self.default_volume = 1.0
        self.default_speed = 1.0
        self.default_eq = "flat"
        self.recorders = {}
        # VC の持ち主管理と、誰もいないときの自動退出は core/vc/voice_session.py に集約した。
        self.voice_sessions = get_manager(bot)


    # ==================================================================
    # /music は引数なしで操作パネルを表示する。
    MUSIC_ACTIONS = [
        app_commands.Choice(name="再生", value="play"),
        app_commands.Choice(name="操作パネル", value="panel"),
        app_commands.Choice(name="一時停止/再開", value="pause"),
        app_commands.Choice(name="スキップ", value="skip"),
        app_commands.Choice(name="停止", value="stop"),
        app_commands.Choice(name="シーク", value="seek"),
        app_commands.Choice(name="キュー表示", value="queue"),
        app_commands.Choice(name="ループ", value="loop"),
        app_commands.Choice(name="シャッフル切替", value="shuffle"),
        app_commands.Choice(name="音量", value="volume"),
        app_commands.Choice(name="再生速度", value="speed"),
        app_commands.Choice(name="EQ", value="eq"),
        app_commands.Choice(name="立体音響", value="spatial"),
        app_commands.Choice(name="検索", value="search"),
        app_commands.Choice(name="プレイリスト", value="playlist"),
        app_commands.Choice(name="音声ファイルID一覧", value="files"),
    ]


#↓落ちた原因これね
async def setup(bot):
    await bot.add_cog(VoiceCog(bot))
