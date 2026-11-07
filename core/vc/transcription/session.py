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
from core.general import logfare
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import voice_connection_failed
from core.vc.voice_media import add_receive_sink, remove_receive_sink
from core.vc.speech_vad import SpeechDetector
from core.support.emojis import FAILED, LOADING, LOUPE, PAUSE
try:  # あれば高品質なポリフェーズ・リサンプラーを使う（無くても numpy だけで動く）
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover
    resample_poly = None  # type: ignore[assignment]

from core.vc.transcription.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.transcription.common import we  # noqa: F401
from core.vc.transcription.sink import TranscriptionSink  # noqa: F401

logger = logging.getLogger("cogs.sio_transcription")


class SessionMixin:
    async def _get_or_create_webhook(self, channel: discord.TextChannel) -> discord.Webhook:
        webhooks = await channel.webhooks()
        for wh in webhooks:
            if wh.token:
                return wh

        return await channel.create_webhook(name="STT-Transcriber")


    async def _transcribe_impl(self, r: Responder, action: str, target_channel: discord.TextChannel | None = None):
        """action: start / stop / status"""
        if action == "start":
            return await self._start(r, target_channel)
        if action == "stop":
            if r.guild.id not in self.sessions:
                return await r.send(embed=we(f"{FAILED} 現在文字起こしは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(r.guild.id, "transcribe", reason="stop"):
                self._cleanup(r.guild.id)("stop")
            return await r.send(embed=we("🛑 文字起こしを停止しました。"))
        session = self.sessions.get(r.guild.id)
        if session:
            await r.send(embed=we(
                f"🎙️ **Logfare {logfare.TRANSCRIPTION_MODEL} 文字起こし実行中**\n"
                f"ボイスチャンネル: **{session['vc_channel_name']}**\n"
                f"送信先チャンネル: {session['target_channel_mention']}\n"
                f"停止コマンド: `/vc のパネルから文字起こし停止`"
            ))
        else:
            await r.send(embed=we(PAUSE + ' 文字起こし停止中 (`/vc のパネルから文字起こし開始` で開始)'))


    def _build_sender(self, guild_id: int, webhook, notice_channel):
        """文字起こし結果を Webhook へ送るコールバック（開始時・再開時で共用）。"""
        premium_notice_sent = False

        async def send_webhook(display_name: str, avatar_url: str | None, audio_wav: bytes):
            nonlocal premium_notice_sent
            self.last_audio[guild_id] = (display_name, audio_wav, time.time())
            try:
                text = await logfare.transcribe_audio(audio_wav)
            except logfare.LogfareHTTPError as ex:
                logger.warning("Logfare transcription API returned HTTP %s", ex.status)
                if ex.status == 403 and not premium_notice_sent:
                    premium_notice_sent = True
                    await notice_channel.send(
                        "Logfareの文字起こしモデルが利用できません。モデルのトレーニング利用へのオプトインと、APIキーの利用権限を確認してください。"
                    )
                return
            except RuntimeError as ex:
                if "文字起こし結果がありません" in str(ex):
                    # 雑音・息・短すぎる発話などで認識結果が空だっただけ。エラー扱いにしない
                    logger.info("Logfare: 認識結果が空でした (user=%s)", display_name)
                else:
                    logger.exception("Logfare transcription request failed")
                return
            except Exception:
                logger.exception("Logfare transcription request failed")
                return
            if not text or not text.strip():
                return
            async with aiohttp.ClientSession() as session:
                wh_obj = discord.Webhook.from_url(webhook.url, session=session)
                try:
                    await wh_obj.send(
                        content=text,
                        username=display_name,
                        avatar_url=avatar_url,
                        _agobot_skip_localization=True,
                    )
                except Exception as ex:
                    logger.error("[Webhook Send Error] %s", ex)

        return send_webhook


    async def _start(self, r: Responder, target_channel: discord.TextChannel | None):
        async with self._start_lock:
            return await self._start_once(r, target_channel)


    async def _start_once(self, r: Responder, target_channel: discord.TextChannel | None):
        if not logfare.api_key():
            return await r.send(embed=we(
                FAILED + ' `LOGFARE_API_KEY` が設定されていないため、文字起こしを開始できません。'
            ), ephemeral=True)
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(f"{FAILED} 先にボイスチャンネルに参加してから実行してください。"), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we(f"{FAILED} 既に文字起こしが実行中です。"), ephemeral=True)

        vc_channel = voice.channel
        await r.defer()
        send_channel: discord.TextChannel = target_channel or r.channel

        # 共有対象の機能には同じ接続で合流する。競合時は先に拒否してから
        # webhook を作ることで、不要なAPI/Discord操作を避ける。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, vc_channel, "transcribe", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=False, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(
                f"{FAILED} いまVCは **{busy.session.label}** が使用中です。先にその機能を停止してから文字起こしを開始してください。\n"
                "文字起こしは、実行中のVC機能を自動停止・切り替えしません。"
            ))
        except Exception as e:
            return await r.send(embed=we(voice_connection_failed(e)))

        try:
            webhook = await self._get_or_create_webhook(send_channel)
        except discord.Forbidden:
            await self.voice_sessions.release(r.guild.id, "transcribe", reason="webhook-error")
            return await r.send(embed=we(f"{FAILED} Botに {send_channel.mention} の `ウェブフックの管理 (Manage Webhooks)` 権限がありません。"))
        except Exception as e:
            await self.voice_sessions.release(r.guild.id, "transcribe", reason="webhook-error")
            return await r.send(embed=we(f"{FAILED} Webhookの取得に失敗しました: `{e}`"))

        send_webhook = self._build_sender(guild_id, webhook, r.channel)

        sink = TranscriptionSink(
            bot=self.bot,
            vc=vc,
            callback_coro=send_webhook
        )
        add_receive_sink(vc, "transcribe", sink)

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "vc_channel_name": vc_channel.name,
            "target_channel_id": send_channel.id,
            "target_channel_mention": send_channel.mention
        }
        self._save_resume_snapshot(guild_id, vc_channel, r.channel, r.user, send_channel)

        await r.send(embed=we(
            f"🎙️ **{vc_channel.name}** で Logfare {logfare.TRANSCRIPTION_MODEL} による文字起こしを開始しました。\n"
            f"音声は無音区間ごとにLogfareへ送信され、結果を {send_channel.mention} へ投稿します。\n"
            "音楽・GVC・読み上げと同時に利用できます。利用者の音声は外部サービスで処理されます。"
        ))


    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            vc_feature_restore.clear_feature("transcribe", guild_id)
            self.last_audio.pop(guild_id, None)
            session = self.sessions.pop(guild_id, None)
            if not session:
                return
            remove_receive_sink(session["vc"], "transcribe")
        return cleanup
