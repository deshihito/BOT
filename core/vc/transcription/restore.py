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

from core.vc.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.transcription.common import we  # noqa: F401
from core.vc.transcription.sink import TranscriptionSink  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class RestoreMixin:
    def _save_resume_snapshot(self, guild_id: int, voice_channel, text_channel, user, target_channel) -> None:
        """再開に必要な情報だけを保存する（発話中の音声バッファは保存しない）。"""
        vc_feature_restore.save_feature("transcribe", guild_id, vc_feature_restore.build_entry(
            voice_channel_id=getattr(voice_channel, "id", None),
            text_channel_id=getattr(text_channel, "id", None),
            user=user,
            settings={"target_channel_id": getattr(target_channel, "id", None)},
        ))


    async def restore_after_restart(self) -> None:
        """再起動前に文字起こし中だったギルドで、同じ送信先の新規セッションとして再開する。

        発話途中の音声はプロセスと一緒に失われているため復元はしない。
        復旧できないギルド（ギルド・チャンネル消滅、人がいない、APIキー不備）は
        スナップショットを掃除する。
        """
        entries = vc_feature_restore.feature_entries("transcribe")
        for guild_id, snapshot in entries.items():
            try:
                restored = await self._restore_session(guild_id, snapshot)
            except Exception:
                logger.exception("guild %s: 文字起こしの自動再開に失敗しました", guild_id)
                restored = False
            if not restored:
                vc_feature_restore.clear_feature("transcribe", guild_id)
        vc_feature_restore.flush_store()


    async def _restore_session(self, guild_id: int, snapshot: dict) -> bool:
        if not logfare.api_key():
            logger.info("guild %s: LOGFARE_API_KEY が無いため文字起こしを再開しません", guild_id)
            return False
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        channel_id = snapshot.get("voice_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            logger.info("guild %s: 復旧先の VC が見つからないため文字起こしを再開しません", guild_id)
            return False
        if not vc_feature_restore.has_humans(channel):
            logger.info("guild %s: VC に人がいないため文字起こしを再開しません", guild_id)
            return False
        settings = snapshot.get("settings")
        if settings is None:
            settings = {}
        elif not isinstance(settings, dict):
            return False  # settings が壊れているスナップショットは復旧対象にしない
        target_id = settings.get("target_channel_id") or snapshot.get("text_channel_id")
        target_channel = self.bot.get_channel(target_id) if target_id else None
        if target_channel is None:
            logger.info("guild %s: 送信先チャンネルが見つからないため文字起こしを再開しません", guild_id)
            return False
        notice_channel = None
        if snapshot.get("text_channel_id"):
            notice_channel = self.bot.get_channel(snapshot["text_channel_id"])
        if notice_channel is None:
            notice_channel = target_channel
        if guild_id in self.sessions:
            return False
        user = vc_feature_restore.resolve_user(guild, snapshot)
        try:
            vc = await self.voice_sessions.acquire(
                guild, channel, "transcribe", user,
                cleanup=self._cleanup(guild_id), text_channel=notice_channel, force=False, timeout=30.0,
            )
        except Exception:
            logger.warning("guild %s: VC へ再接続できないため文字起こしを再開しません", guild_id, exc_info=True)
            return False
        try:
            webhook = await self._get_or_create_webhook(target_channel)
        except Exception:
            logger.warning("guild %s: Webhook を用意できないため文字起こしを再開しません", guild_id, exc_info=True)
            await self.voice_sessions.release(guild_id, "transcribe", reason="webhook-error")
            return False

        sink = TranscriptionSink(
            bot=self.bot,
            vc=vc,
            callback_coro=self._build_sender(guild_id, webhook, notice_channel),
        )
        add_receive_sink(vc, "transcribe", sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "vc_channel_name": getattr(channel, "name", ""),
            "target_channel_id": getattr(target_channel, "id", None),
            "target_channel_mention": getattr(target_channel, "mention", ""),
        }
        self._save_resume_snapshot(guild_id, channel, notice_channel, user, target_channel)

        try:
            await notice_channel.send(embed=we(
                f"🎙️ **{getattr(channel, 'name', '')}** で Logfare {logfare.TRANSCRIPTION_MODEL} による文字起こしを再開しました（Botの再起動による自動再開）。\n"
                f"音声は無音区間ごとにLogfareへ送信され、結果を {getattr(target_channel, 'mention', '')} へ投稿します。\n"
                "音楽・GVC・読み上げと同時に利用できます。利用者の音声は外部サービスで処理されます。"
            ))
        except Exception:
            logger.debug("文字起こし: 再開通知の送信に失敗しました", exc_info=True)
        logger.info("guild %s: 文字起こしを自動再開しました", guild_id)
        return True
