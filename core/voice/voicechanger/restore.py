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
from core import vc_feature_restore
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice_session import VoiceBusy, get_manager
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU
from functools import partial as _partial

from core.voice.voicechanger.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.voicechanger.common import DEFAULT_TARGET_BUFFER_MS, we  # noqa: F401
from core.voice.voicechanger.sink import VoiceChangerSink  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class RestoreMixin:
    def _save_resume_snapshot(self, guild_id: int, voice_channel, text_channel, user, sink) -> None:
        """再開に必要な設定だけを保存する（変換中バッファや統計は保存しない）。"""
        vc_feature_restore.save_feature("changer", guild_id, vc_feature_restore.build_entry(
            voice_channel_id=getattr(voice_channel, "id", None),
            text_channel_id=getattr(text_channel, "id", None),
            user=user,
            settings={
                "semitones": sink.semitones,
                "target_buffer_ms": sink.audio_source.target_buffer_ms,
                "max_buffer_ms": sink.audio_source.max_buffer_ms,
            },
        ))


    async def restore_after_restart(self) -> None:
        """再起動前にボイスチェンジャー使用中だったギルドで、同じ設定の新規セッションとして再開する。

        変換途中の音声バッファや統計はプロセスと一緒に失われているため復元はしない。
        復旧できないギルド（ギルド・チャンネル消滅、人がいない）はスナップショットを掃除する。
        """
        entries = vc_feature_restore.feature_entries("changer")
        for guild_id, snapshot in entries.items():
            try:
                restored = await self._restore_session(guild_id, snapshot)
            except Exception:
                logger.exception("guild %s: ボイスチェンジャーの自動再開に失敗しました", guild_id)
                restored = False
            if not restored:
                vc_feature_restore.clear_feature("changer", guild_id)
        vc_feature_restore.flush_store()


    async def _restore_session(self, guild_id: int, snapshot: dict) -> bool:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return False
        channel_id = snapshot.get("voice_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            logger.info("guild %s: 復旧先の VC が見つからないためボイスチェンジャーを再開しません", guild_id)
            return False
        if not vc_feature_restore.has_humans(channel):
            logger.info("guild %s: VC に人がいないためボイスチェンジャーを再開しません", guild_id)
            return False
        if guild_id in self.vc_sessions:
            return False
        settings = snapshot.get("settings")
        if settings is None:
            settings = {}
        elif not isinstance(settings, dict):
            return False  # settings が壊れているスナップショットは復旧対象にしない
        try:
            pitch = float(settings.get("semitones") or 0.0)
        except (TypeError, ValueError):
            pitch = 0.0
        buffer = None
        if settings.get("target_buffer_ms") is not None or settings.get("max_buffer_ms") is not None:
            target, resolved_max, error = self._resolve_buffer(
                DEFAULT_TARGET_BUFFER_MS, settings.get("target_buffer_ms"), settings.get("max_buffer_ms"))
            if error is None:
                buffer = (target, resolved_max)
        text_channel = None
        if snapshot.get("text_channel_id"):
            text_channel = self.bot.get_channel(snapshot["text_channel_id"])
        user = vc_feature_restore.resolve_user(guild, snapshot)
        try:
            vc = await self.voice_sessions.acquire(
                guild, channel, "changer", user,
                cleanup=self._cleanup(guild_id), text_channel=text_channel, timeout=30.0,
            )
        except Exception:
            logger.warning("guild %s: VC へ再接続できないためボイスチェンジャーを再開しません", guild_id, exc_info=True)
            return False

        sink = VoiceChangerSink(bot=self.bot, vc=vc, semitones=pitch)
        if buffer is not None:
            sink.audio_source.update_settings(target_buffer_ms=buffer[0], max_buffer_ms=buffer[1])
        vc.listen(sink)

        self.vc_sessions[guild_id] = {"sink": sink, "vc": vc}
        self._save_resume_snapshot(guild_id, channel, text_channel, user, sink)

        if text_channel is not None:
            try:
                await text_channel.send(embed=we(
                    f"🎙️ **{getattr(channel, 'name', '')}** でボイスチェンジャーを再開しました（Botの再起動による自動再開）。\n"
                    f"{MUSIC} ピッチ: `{pitch:+.1f}` 半音\n"
                    f"📦 プリバッファ: `{(buffer[0] if buffer else DEFAULT_TARGET_BUFFER_MS):.0f} ms` (超低遅延モード)\n"
                    f"📊 `/vc のパネルからボイスチェンジャー状態` で遅延数値を確認できます。"
                ))
            except Exception:
                logger.debug("ボイスチェンジャー: 再開通知の送信に失敗しました", exc_info=True)
        logger.info("guild %s: ボイスチェンジャーを自動再開しました", guild_id)
        return True
