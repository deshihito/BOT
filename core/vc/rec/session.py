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

from core.vc.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.rec.common import RECORD_LIMIT_SECONDS  # noqa: F401
from core.vc.rec.sink import RecordingSink  # noqa: F401

logger = logging.getLogger("cogs.sio_rec")


class SessionMixin:
    async def _record_impl(self, r: Responder, action: str):
        """action: start / stop / status / pitch"""
        if action == "start":
            return await self.start_command(r)
        if action == "stop":
            return await self.stop_command(r)
        if action == "pitch":
            return await self.pitch_command(r)
        return await self.status_command(r)


    async def start_command(self, r: Responder):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)

        guild_id = r.guild.id
        if guild_id in self.sessions:
            return await r.send(embed=we(
                f"{FAILED} 既にこのサーバーで録音中です。`/vc のパネルから録音停止` で停止してください。"
            ), ephemeral=True)

        if not discord.opus.is_loaded():
            return await r.send(embed=we(
                FAILED + ' Opus ライブラリがロードされていません。サーバーに libopus をインストールしてください。'
            ))

        target_channel = voice.channel
        await r.defer()

        # 別の機能（音楽・やまびこなど）が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, target_channel, "record", r.user,
                cleanup=self._record_cleanup(guild_id), text_channel=r.channel, force=True,
                timeout=30.0,      # DAVE暗号化応答待ちのためタイムアウトを延長
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)))
        except Exception as e:
            logger.error(f"VC Connection Error: {e}", exc_info=True)
            return await r.send(embed=we(voice_connection_failed(e)))

        try:
            if vc.is_listening():
                vc.stop_listening()
        except Exception:
            logger.debug("録音: 既存の受信停止に失敗しました", exc_info=True)

        await asyncio.sleep(1.0)

        negotiated_mode = getattr(vc, "mode", "不明")
        dave_active = vc.dave_is_active() if hasattr(vc, "dave_is_active") else False
        dave_ready = vc.dave_is_ready() if hasattr(vc, "dave_is_ready") else dave_active

        if dave_active:
            dave_text = "有効" if dave_ready else "有効(鍵交換中)"
        else:
            dave_text = "無効"

        status_msg = await r.send(embed=we(
            f"🎙️ **{target_channel.name}** で録音を開始しました。\n"
            f"🔐 暗号化: `{negotiated_mode}` / DAVE(E2EE): `{dave_text}`\n"
            f"📦 受信パケット数: `0` 個\n"
            f"{CLOCK} 録音は最長 {RECORD_LIMIT_SECONDS // 60} 分です。超えると自動で停止してファイルを送ります。\n"
            f"停止するには `/vc のパネルから録音停止` を実行してください。"
        ), want_message=True)

        # 録音していることを、テキストチャンネルの全員に見える形で知らせる（Discord のポリシー）。
        await self._announce_recording(r, target_channel)

        # --------------------------------------------------
        # rec_start 内の on_packet_update (コールバック) を差し替え
        # --------------------------------------------------
        async def on_packet_update(count: int, notes: list[str]) -> None:
            try:
                notes_str = " / ".join([f"`{n}`" for n in notes]) if notes else "`解析中/発聲待機...`"
                await status_msg.edit(embed=we(
                    f"🔴 **リアルタイム音階演奏中...**\n"
                    f"🎙️ チャンネル: **{target_channel.name}**\n"
                    f"🎹 リアルタイム検出音階: {notes_str}\n"
                    f"📦 パケット数: `{count}` | 停止: `/vc のパネルから録音停止`"
                ))
            except Exception:
                logger.debug("録音: ステータス表示の更新に失敗しました", exc_info=True)

        sink = RecordingSink(bot=self.bot, vc=vc, update_callback=on_packet_update)

        try:
            vc.listen(sink)
        except Exception as e:
            await self.voice_sessions.release(guild_id, "record", reason="stop")
            return await r.send(embed=we(f"{FAILED} 録音の開始に失敗しました: `{e}`"))

        self.sessions[guild_id] = {
            "sink": sink,
            "vc": vc,
            "start": time.time(),
            "channel_name": target_channel.name,
            "status_msg": status_msg,
            "text_channel": r.channel,
            "guild": r.guild,
            "limit_task": asyncio.create_task(self._stop_at_limit(guild_id)),
        }
        self._save_resume_snapshot(guild_id, target_channel, r.channel, r.user)


    def _record_cleanup(self, guild_id: int):
        """VC を手放すとき（停止・上限・切り替え・自動退出・外部切断）に呼ばれる後片付け。

        受信を止めて音声を取り出し、ファイルの送信は切断後に別タスクで行う。
        """
        async def cleanup(reason: str) -> None:
            vc_feature_restore.clear_feature("record", guild_id)
            session = self.sessions.pop(guild_id, None)
            if session is None:
                return
            task = session.get("limit_task")
            if task is not None and task is not asyncio.current_task() and not task.done():
                task.cancel()
            sink: RecordingSink = session["sink"]
            try:
                session["vc"].stop_listening()
            except Exception as e:
                logger.error("[REC] stop_listening error: %r", e)
            audio = sink.snapshot()
            sink.cleanup()
            self._deliveries[guild_id] = asyncio.create_task(self._deliver(session, audio, reason))
        return cleanup


    async def _announce_recording(self, r: Responder, voice_channel) -> None:
        """録音開始を、テキストチャンネルに（ephemeral ではなく）全員に見えるメッセージで知らせる。"""
        user = r.user
        mention = getattr(user, "mention", None) or getattr(user, "display_name", "だれか")
        try:
            await r.channel.send(
                f"🔴 **録音を開始しました**（開始: {mention}）\n"
                f"ボイスチャンネル **{voice_channel.name}** の音声が録音されます（最長 {RECORD_LIMIT_SECONDS // 60} 分）。"
                "録音されたくない人は退出してください。",
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception:
            logger.warning("[REC] 録音開始のお知らせを送れませんでした", exc_info=True)


    async def stop_command(self, r: Responder):
        guild_id = r.guild.id
        if guild_id not in self.sessions:
            return await r.send(embed=we(f"{FAILED} 現在録音は行われていません。"), ephemeral=True)

        await r.defer()
        if not await self.voice_sessions.release(guild_id, "record", reason="stop"):
            await self._record_cleanup(guild_id)("stop")
        task = self._deliveries.get(guild_id)
        if task is not None:
            await task
        if r.is_interaction:
            await r.send(embed=we("🛑 録音を停止しました。ファイルはこのチャンネルに送りました。"))


    STOP_REASONS = {
        "stop": "💾 録音を停止しました",
        "time_limit": f"{CLOCK} 録音が上限の {RECORD_LIMIT_SECONDS // 60} 分に達したため自動で停止しました",
        "takeover": "💾 別の機能に切り替わったため録音を停止しました",
        "leave": "💾 /vc のパネルからVC退出 で退出したため録音を停止しました",
        "idle": "💾 ボイスチャンネルに誰もいなくなったため録音を停止しました",
        "disconnected": "💾 ボイスチャンネルから切断されたため録音を停止しました",
    }


    async def status_command(self, r: Responder):
        session = self.sessions.get(r.guild.id)

        if session:
            sink: RecordingSink = session["sink"]
            elapsed = int(time.time() - session["start"])
            embed = discord.Embed(
                title="🎙️ 録音中",
                description=(
                    f"チャンネル: **{session['channel_name']}**\n"
                    f"経過時間: **{self.format_time(elapsed)}**\n"
                    f"受信パケット数: **{sink.packet_count}** 個\n"
                    f"録音中の話者数: **{len(sink.buffers)}** 人"
                ),
                color=0x2ECC71,
            )
        else:
            embed = discord.Embed(
                title=PAUSE + ' 待機中',
                description=(
                    "現在このサーバーで録音は行われていません。\n"
                    "`/vc のパネルから録音開始` で開始できます。"
                ),
                color=0x95A5A6,
            )

        await r.send(embed=embed)
