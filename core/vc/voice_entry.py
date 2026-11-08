"""/voice グループ: ボイスチャンネルを使う機能（参加・退出・録音・やまびこ・文字起こし・カラオケ・
ボイスチェンジャー・ランダム通話・グローバルVC・VOICEVOX読み上げ・音声トリガー）の入口。

それぞれの処理は各機能の cog にある実装関数（``_xxx_impl``）を呼ぶだけ。
VC を誰が使っているかは core/vc/voice_session.py が持つ。
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from core.vc.common import VOICE_TRIGGER_AVAILABLE, encodec, sf, torch  # noqa: F401
from core.general import action_usage
from core.support.usage_stats import usage_stats
from core.support.legacy import Responder
from core.vc.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.vc.voice_media import add_audio_source, remove_audio_source
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.vc.common import CONNECTION_ACTIONS, STUDIO_FEATURES, STUDIO_ACTIONS, EFFECT_ACTIONS, COMMUNITY_NETWORKS, COMMUNITY_ACTIONS, VOICE_GENRES, VOICE_ACTIONS_BY_GENRE, GVC_ROOM_FORMS, GVC_ROOM_ACTIONS, LAZY_EXTENSIONS, COGS, format_elapsed  # noqa: F401
from core.vc.hub import logger, VoiceHub, VoiceGenreSelect, VoiceActionSelect, VoicePanelView, GlobalRoomModal, GvcRoomModal  # noqa: F401
from core.vc.trigger import logger, VOICE_TRIGGER_DIR, VOICE_TRIGGER_MAX_SECONDS, VOICE_TRIGGER_MAX_PER_GUILD, VOICE_TRIGGER_SAMPLE_RATE, VOICE_TRIGGER_BANDWIDTH, _ENCODEC_MODEL, VoiceTriggerError, _get_encodec_model, _trim_to_wav, _encodec_compress, _encodec_decompress, VoiceTriggerCog, _AUDIO_EXTS, _scan_recent_audios, VoiceTriggerPickAudioSelect, VoiceTriggerWordModal, VoiceTriggerRegisterView, VoiceTriggerDeleteSelect, VoiceTriggerManageView  # noqa: F401
from core.vc.tts import logger, logger, TTS_API_BASE, TTS_API_KEY, TTS_DEFAULT_SPEAKER, TTS_MAX_CHARS, TTS_CHUNK_CHARS, TTS_QUEUE_MAX, TTS_PITCH_RANGE, TTS_SPEED_RANGE, TTS_IGNORE_PREFIXES, TTS_SETTINGS_PATH, TTSError, TTSSettings, _tempo_filters, build_tts_filters, split_tts_text, clean_message_text, TTSCog, TTSSettingsModal, TTSSayModal  # noqa: F401

logger = logging.getLogger("cogs.sio_voice")


async def setup(bot: commands.Bot):
    await bot.add_cog(VoiceHub(bot))
    await bot.add_cog(TTSCog(bot))
    await bot.add_cog(VoiceTriggerCog(bot))
