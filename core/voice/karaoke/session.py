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
from core import vc_feature_restore
from core.vosk_model import ensure_model
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED
from core.emojis import FAILED, MUSIC
try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    Model = None
    KaldiRecognizer = None

from core.voice.karaoke.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.karaoke.common import we  # noqa: F401
from core.voice.karaoke.dsp import clean_text  # noqa: F401
from core.voice.karaoke.sink import KaraokeSink  # noqa: F401

logger = logging.getLogger("cogs.sio_karaoke")


class SessionMixin:
    async def _get_or_create_webhook(self, channel: discord.TextChannel) -> discord.Webhook:
        webhooks = await channel.webhooks()
        for wh in webhooks:
            if wh.token:
                return wh
        return await channel.create_webhook(name="Karaoke-Lyrics")


    async def _karaoke_impl(self, r: Responder, action: str, target_lyrics: str | None = None):
        """action: start / score / stop / help"""
        if action == "start":
            return await self._start(r, target_lyrics)
        if action == "score":
            return await self._score(r)
        if action == "stop":
            if r.guild.id not in self.sessions:
                return await r.send(embed=we(f"{FAILED} 現在カラオケは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(r.guild.id, "karaoke", reason="stop"):
                self._cleanup(r.guild.id)("stop")
            return await r.send(embed=we("🛑 カラオケモードを終了しました！"))
        await r.send(embed=we(
            "🎤 **カラオケ機能の使い方**\n"
            "1. `/vc のパネルからカラオケ開始 lyrics:<お題の歌詞>` : 歌詞をセットして採点＆字幕開始\n"
            "2. `/vc のパネルからカラオケ採点` : 現在の歌唱スコアを表示\n"
            "3. `/vc のパネルからカラオケ終了` : カラオケを終了"
        ))


    async def _score(self, r: Responder):
        session = self.sessions.get(r.guild.id)
        if not session:
            return await r.send(embed=we(f"{FAILED} 現在カラオケは実行されていません。"), ephemeral=True)

        sink: KaraokeSink = session["sink"]
        target = clean_text(session["target_lyrics"])

        if not target:
            return await r.send(embed=we(FAILED + ' お題の歌詞が登録されていません。'), ephemeral=True)

        embed = discord.Embed(title="🏆 カラオケ採点結果", color=0xFFD700)

        with sink._lock:
            for user_id, ubuf in sink.user_buffers.items():
                sung_text = clean_text("".join(ubuf["history"]))
                if not sung_text:
                    continue

                # 一致率の計算 (0.0 〜 1.0)
                matcher = SequenceMatcher(None, target, sung_text)
                ratio = matcher.ratio()
                score = round(ratio * 100, 1)

                comment = "🥇 PERFECT!" if score >= 85 else ("🥈 GOOD!" if score >= 60 else "🥉 KEEP TRYING!")

                embed.add_field(
                    name=f"👤 {ubuf['display_name']} さんのスコア",
                    value=f"点数: **{score} 点** / 100点\n評価: {comment}\n認識結果: `{sung_text[:30]}...`",
                    inline=False
                )

        if not embed.fields:
            embed.description = "まだ歌声が検知されていません！"

        await r.send(embed=embed)


    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            vc_feature_restore.clear_feature("karaoke", guild_id)
            session = self.sessions.pop(guild_id, None)
            if not session:
                return
            session["sink"].cleanup()
            try:
                session["vc"].stop_listening()
            except Exception:
                logger.debug("カラオケ: 後片付けの受信停止に失敗しました", exc_info=True)
        return cleanup


    def _make_subtitle_sender(self, webhook):
        """歌詞字幕を Webhook へ送るコールバック（開始時・再開時で共用）。"""
        async def send_lyrics_subtitle(display_name: str, avatar_url: str | None, text: str):
            async with aiohttp.ClientSession() as session:
                wh_obj = discord.Webhook.from_url(webhook.url, session=session)
                try:
                    await wh_obj.send(
                        content=f"{MUSIC} {text}",
                        username=f"🎤 {display_name}",
                        avatar_url=avatar_url,
                        _agobot_skip_localization=True,
                    )
                except Exception as ex:
                    logger.error(f"[Webhook Error] {ex}")
        return send_lyrics_subtitle
