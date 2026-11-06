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
from core.vc.karaoke.common import annotations, asyncio, json, logging, os, threading, time, re, SequenceMatcher, np, aiohttp, discord, commands, voice_recv, Responder, vc_feature_restore, ensure_model, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, FAILED, MUSIC, logger, DISCORD_SAMPLE_RATE, VOSK_SAMPLE_RATE, CHANNELS, SILENCE_THRESHOLD_SEC, RMS_SILENCE_THRESHOLD, MODEL_PATH, OPUS_SILENCE, _partial, _shared_we, we  # noqa: F401
from core.vc.karaoke.dsp import annotations, asyncio, json, logging, os, threading, time, re, SequenceMatcher, np, aiohttp, discord, commands, voice_recv, Responder, vc_feature_restore, ensure_model, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, FAILED, MUSIC, logger, resample_48k_to_16k, clean_text  # noqa: F401
from core.vc.karaoke.restore import annotations, asyncio, json, logging, os, threading, time, re, SequenceMatcher, np, aiohttp, discord, commands, voice_recv, Responder, vc_feature_restore, ensure_model, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, FAILED, MUSIC, logger, RestoreMixin  # noqa: F401
from core.vc.karaoke.session import annotations, asyncio, json, logging, os, threading, time, re, SequenceMatcher, np, aiohttp, discord, commands, voice_recv, Responder, vc_feature_restore, ensure_model, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, FAILED, MUSIC, logger, SessionMixin  # noqa: F401
from core.vc.karaoke.sink import annotations, asyncio, json, logging, os, threading, time, re, SequenceMatcher, np, aiohttp, discord, commands, voice_recv, Responder, vc_feature_restore, ensure_model, VoiceBusy, get_manager, patch_voice_recv_client, VOICE_NOT_JOINED, FAILED, MUSIC, logger, KaraokeSink  # noqa: F401

logger = logging.getLogger("cogs.sio_karaoke")


class KaraokeCog(SessionMixin, RestoreMixin, commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sessions: dict[int, dict] = {}
        self.voice_sessions = get_manager(bot)

        self.vosk_model = None
        if Model is None:
            logger.warning("Voskが未インストールのため、カラオケ機能を無効化します。")
        elif not os.path.exists(MODEL_PATH):
            logger.warning("Voskモデルが見つからないため、カラオケ機能を無効化します: %s", MODEL_PATH)
        else:
            self.vosk_model = Model(MODEL_PATH)

    async def _start(self, r: Responder, target_lyrics: str | None):
        if not target_lyrics or not target_lyrics.strip():
            return await r.send(embed=we(f"{FAILED} お題の歌詞を `lyrics` に入れてください。"), ephemeral=True)
        # モデルが無いときは VC に入る前に断る。
        problem = await ensure_model(self, Model, MODEL_PATH)
        if problem:
            return await r.send(embed=we(problem), ephemeral=True)
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we(f"{FAILED} 既にカラオケ機能が実行中です。"), ephemeral=True)

        vc_channel = voice.channel
        await r.defer()
        webhook = await self._get_or_create_webhook(r.channel)

        # 別の機能が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, vc_channel, "karaoke", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=True, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)))
        except Exception as e:
            return await r.send(embed=we(f"{FAILED} VC接続に失敗しました: `{e}`"))

        sink = KaraokeSink(bot=self.bot, vc=vc, vosk_model=self.vosk_model,
                           callback_coro=self._make_subtitle_sender(webhook))
        vc.listen(sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "target_lyrics": target_lyrics,
            "start_time": time.time()
        }
        self._save_resume_snapshot(guild_id, vc_channel, r.channel, r.user, target_lyrics)

        await r.send(embed=we(
            f"🎤 **{vc_channel.name}** でカラオケを開始しました！\n\n"
            f"📜 **お題の歌詞:**\n```\n{target_lyrics}\n```\n"
            "歌った声がリアルタイムで字幕表示されます。終わったら `/vc のパネルからカラオケ採点` で採点！"
        ), skip_localization=True)

    async def _restore_session(self, guild_id: int, snapshot: dict) -> bool:
        settings = snapshot.get("settings")
        if settings is None:
            settings = {}
        elif not isinstance(settings, dict):
            return False  # settings が壊れているスナップショットは復旧対象にしない
        target_lyrics = settings.get("target_lyrics")
        if not target_lyrics or not str(target_lyrics).strip():
            return False
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        channel_id = snapshot.get("voice_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            logger.info("guild %s: 復旧先の VC が見つからないためカラオケを再開しません", guild_id)
            return False
        if not vc_feature_restore.has_humans(channel):
            logger.info("guild %s: VC に人がいないためカラオケを再開しません", guild_id)
            return False
        text_channel = None
        if snapshot.get("text_channel_id"):
            text_channel = self.bot.get_channel(snapshot["text_channel_id"])
        if text_channel is None:
            logger.info("guild %s: 字幕の送信先が見つからないためカラオケを再開しません", guild_id)
            return False
        if guild_id in self.sessions:
            return False
        # モデルが無いときは VC に入る前に断る（開始時と同じ）。
        problem = await ensure_model(self, Model, MODEL_PATH)
        if problem:
            logger.info("guild %s: 音声認識モデルが使えないためカラオケを再開しません", guild_id)
            return False
        user = vc_feature_restore.resolve_user(guild, snapshot)
        try:
            webhook = await self._get_or_create_webhook(text_channel)
            vc = await self.voice_sessions.acquire(
                guild, channel, "karaoke", user,
                cleanup=self._cleanup(guild_id), text_channel=text_channel, timeout=30.0,
            )
        except Exception:
            logger.warning("guild %s: VC へ再接続できないためカラオケを再開しません", guild_id, exc_info=True)
            return False

        sink = KaraokeSink(bot=self.bot, vc=vc, vosk_model=self.vosk_model,
                           callback_coro=self._make_subtitle_sender(webhook))
        vc.listen(sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "target_lyrics": target_lyrics,
            "start_time": time.time()
        }
        self._save_resume_snapshot(guild_id, channel, text_channel, user, target_lyrics)

        try:
            await text_channel.send(embed=we(
                f"🎤 **{getattr(channel, 'name', '')}** でカラオケを再開しました！（Botの再起動による自動再開）\n\n"
                f"📜 **お題の歌詞:**\n```\n{target_lyrics}\n```\n"
                "歌った声がリアルタイムで字幕表示されます。終わったら `/vc のパネルからカラオケ採点` で採点！\n"
                "※ 採点の履歴はリセットされています。"
            ))
        except Exception:
            logger.debug("カラオケ: 再開通知の送信に失敗しました", exc_info=True)
        logger.info("guild %s: カラオケを自動再開しました", guild_id)
        return True


async def setup(bot: commands.Bot):
    await bot.add_cog(KaraokeCog(bot))
