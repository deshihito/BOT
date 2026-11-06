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
from core.vc import vc_feature_restore
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_session import VoiceBusy, get_manager
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU
from functools import partial as _partial
from core.vc.voicechanger.common import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, logger, SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, FRAME_SIZE, BYTES_PER_SECOND, CHUNK_DURATION, CHUNK_BYTES, OPUS_SILENCE, DEFAULT_TARGET_BUFFER_MS, DEFAULT_MAX_BUFFER_MS, DEFAULT_FADE_MS, _partial, _shared_we, we  # noqa: F401
from core.vc.voicechanger.restore import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, _partial, logger, RestoreMixin  # noqa: F401
from core.vc.voicechanger.session import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, _partial, logger, SessionMixin  # noqa: F401
from core.vc.voicechanger.shifter import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, _partial, logger, AdaptiveWSOLAPitchShifter  # noqa: F401
from core.vc.voicechanger.sink import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, _partial, logger, VoiceChangerSink  # noqa: F401
from core.vc.voicechanger.source import annotations, logging, threading, time, np, discord, commands, voice_recv, Responder, vc_feature_restore, VOICE_NOT_JOINED, voice_connection_failed, VoiceBusy, get_manager, CLOCK, FAILED, MUSIC, PAUSE, THU, _partial, logger, WaitAndConnectAudioSource  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class VoiceChangerCog(SessionMixin, RestoreMixin, commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.vc_sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)


async def setup(bot: commands.Bot):
    await bot.add_cog(VoiceChangerCog(bot))
