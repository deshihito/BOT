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
from core import voice_restore
from core.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import FAILED, MUSIC, SUCCESS
from core.music_activity import build_music_activity_snapshot

from core.voice.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")


class PlaylistsMixin:
    def _serialize_personal_playlist(self, guild_id: int):
        """現在曲と待機キューを、再解析可能な入力だけで保存する。"""
        state = self.get_state(guild_id)
        tracks = []
        current = state.get('current_track')
        if current:
            stream_url, title, _duration, b62_id, is_yt = current
            source_input = state.get('current_yt_page_url') if is_yt else (b62_id or stream_url)
            if source_input:
                tracks.append({
                    'input': source_input,
                    'title': title,
                    'attachment_id': b62_id,
                    'is_youtube': bool(is_yt),
                })
        for source_input, title, b62_id, is_yt in list(state['queue']._queue):
            tracks.append({
                'input': source_input if is_yt else (b62_id or source_input),
                'title': title,
                'attachment_id': b62_id,
                'is_youtube': bool(is_yt),
            })
        return tracks


    @staticmethod
    def _server_playlist_key(guild_id: int, name: str) -> str:
        return f"{guild_id}:{name}"


    def _server_playlist_ids(self, guild_id: int):
        """サーバー共有プレイリスト用に、現在曲とキューを再生可能な形で集める。

        旧形式の添付IDは文字列のまま保持し、YouTubeや直接添付URLなどIDを
        持たないトラックは辞書で保存する。既存の ``playlists.ids`` JSON列を
        そのまま利用しながら、通常の音楽プレイリストも共有できる。
        """
        state = self.get_state(guild_id)
        entries = []

        def add(track):
            if not track:
                return
            source_input, title, _duration, reference, is_yt = track
            source = state.get('current_yt_page_url') if is_yt and track is state.get('current_track') else source_input
            source = source or reference
            if not source:
                return
            if not is_yt and reference and not str(reference).startswith(('http://', 'https://')):
                entries.append(reference)
            else:
                entries.append({
                    'input': source,
                    'title': title,
                    'attachment_id': reference,
                    'is_youtube': bool(is_yt),
                })

        add(state.get('current_track'))
        for item in list(state['queue']._queue):
            add(item)
        return entries


    async def _playlist_impl(self, r: Responder, action: str, name: str | None = None, scope: str = 'me',
                             file: discord.Attachment | None = None):
        """プレイリストの保存・一覧・再生。

        scope='me'     : 自分専用（テーブル user_music_playlists。旧 /playlist・!plsave・!pllist・!plplay）
        scope='server' : サーバー共有（テーブル playlists。旧 !save_current・!plist。再生では ID の並びや JSON も受け付ける）
        """
        name = (name or '').strip()
        db = self.bot.db_api
        if action == 'play':
            await r.defer()
            if error := await self._ensure_music_connection(r):
                return await r.send(embed=we(error), ephemeral=True)
            if scope == 'server':
                return await self._play_server_playlist(r, name, file)
            if not db:
                return await r.send(embed=we("個人プレイリストを使うにはSupabaseを設定してください。"), ephemeral=True)
            if not name:
                return await r.send(embed=we("再生するプレイリスト名を指定してください。"), ephemeral=True)
            try:
                result = db.table('user_music_playlists').select('tracks').eq('guild_id', r.guild.id).eq(
                    'owner_user_id', r.user.id
                ).eq('name', name).limit(1).execute()
                rows = result.data or []
                if not rows:
                    return await r.send(embed=we(f"個人プレイリスト `{name}` が見つかりません。"), ephemeral=True)
                await self.start_playlist_load(r.source, rows[0].get('tracks') or [], name)
            except Exception:
                logger.exception("Failed to play personal playlist")
                await r.send(embed=we("個人プレイリストの読込に失敗しました。"), ephemeral=True)
            return

        if action == 'delete':
            if not name:
                return await r.send(embed=we("削除するプレイリスト名を指定してください。"), ephemeral=True)
            try:
                if scope == 'server':
                    result = db.table("playlists").delete().eq(
                        "name", self._server_playlist_key(r.guild.id, name)
                    ).execute()
                else:
                    result = db.table('user_music_playlists').delete().eq(
                        'guild_id', r.guild.id
                    ).eq('owner_user_id', r.user.id).eq('name', name).execute()
                if not result.data:
                    label = '共有' if scope == 'server' else '個人'
                    return await r.send(embed=we(f"{label}プレイリスト `{name}` が見つかりません。"), ephemeral=True)
                return await r.send(embed=we(f"プレイリスト `{name}` を削除しました。"))
            except Exception:
                logger.exception("Failed to delete playlist")
                return await r.send(embed=we("プレイリストの削除に失敗しました。"), ephemeral=True)

        if not db:
            return await r.send(embed=we("プレイリストを使うにはSupabaseを設定してください。"), ephemeral=True)

        if action == 'save':
            if not name:
                return await r.send(embed=we("保存するプレイリスト名を指定してください。"), ephemeral=True)
            if scope == 'server':
                ids = self._server_playlist_ids(r.guild.id)
                if not ids:
                    return await r.send(embed=we("保存できる曲がありません（サーバー共有に保存できるのは、アップロードした音声だけです）。"), ephemeral=True)
                try:
                    db.table("playlists").upsert({"name": self._server_playlist_key(r.guild.id, name), "ids": ids}).execute()
                    return await r.send(embed=we(f"{SUCCESS} このサーバー内のキューを `{name}` として保存しました（{len(ids)} 曲・サーバー共有）。"))
                except Exception as exc:
                    logger.exception("Failed to save server playlist")
                    return await r.send(embed=we(f"保存に失敗しました。({type(exc).__name__})"), ephemeral=True)
            tracks = self._serialize_personal_playlist(r.guild.id)
            if not tracks:
                return await r.send(embed=we("保存できる曲がありません。"), ephemeral=True)
            try:
                db.table('user_music_playlists').upsert(
                    {'guild_id': r.guild.id, 'owner_user_id': r.user.id, 'name': name, 'tracks': tracks},
                    on_conflict='guild_id,owner_user_id,name',
                ).execute()
                return await r.send(embed=we(f"個人プレイリスト `{name}` に {len(tracks)} 曲を保存しました。"))
            except Exception as exc:
                logger.exception("Failed to save personal playlist")
                detail = str(exc).lower()
                if 'row-level security' in detail or 'permission denied' in detail or '42501' in detail:
                    message = '保存権限がありません。SupabaseのRLSポリシーと、Botに設定したSupabaseキー（BOT_API_KEY / BOT_API_KEY）の権限を確認してください。'
                else:
                    message = f'保存に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。({type(exc).__name__})'
                return await r.send(embed=we(message), ephemeral=True)

        # 一覧
        try:
            if scope == 'server':
                prefix = f"{r.guild.id}:"
                result = db.table("playlists").select("name,ids").like("name", f"{prefix}%").execute()
                rows = [row for row in (result.data or []) if str(row.get('name', '')).startswith(prefix)]
                description = '\n'.join(
                    f"• **{row['name'][len(prefix):]}** — {len(row.get('ids') or [])} 曲" for row in rows[:25]
                ) or '登録されていません。'
                return await r.send(embed=we(title='このサーバーの共有プレイリスト', description=description))
            result = db.table('user_music_playlists').select('name,tracks,updated_at').eq(
                'guild_id', r.guild.id
            ).eq('owner_user_id', r.user.id).order('updated_at', desc=True).execute()
            rows = result.data or []
            description = '\n'.join(f"• **{row['name']}** — {len(row.get('tracks') or [])} 曲" for row in rows[:25]) or '登録されていません。'
            return await r.send(embed=we(title='あなたの個人プレイリスト', description=description))
        except Exception:
            logger.exception("Failed to list playlists")
            return await r.send(embed=we("一覧取得に失敗しました。"), ephemeral=True)


    async def _play_server_playlist(self, r: Responder, name: str, file: discord.Attachment | None):
        """サーバー共有プレイリスト名、ID の並び（空白・カンマ区切り）、または JSON ファイルを再生する。"""
        state = self.get_state(r.guild.id)
        state['current_ctx'] = r.source
        tokens = []
        attachment = file or (r.attachments[0] if r.attachments else None)
        if attachment is not None:
            try:
                content = await attachment.read()
                tokens = json.loads(content.decode('utf-8'))
                if not isinstance(tokens, list):
                    tokens = [str(tokens)]
            except Exception as e:
                logger.debug("Server playlist JSON parse failed", exc_info=True)
                return await r.send(embed=we(f"JSON解析エラー: {e}"))
        elif name:
            tokens = name.replace(',', ' ').split()
            if self.bot.db_api:
                try:
                    res = self.bot.db_api.table("playlists").select("ids").eq(
                        "name", self._server_playlist_key(r.guild.id, name)).execute()
                    if res.data:
                        tokens = res.data[0]["ids"]
                except Exception:
                    logger.warning("Server playlist DB lookup failed", exc_info=True)
        else:
            return await r.send(embed=we("プレイリスト名、ID、またはJSONファイルを指定してください。"), ephemeral=True)

        tracks = []
        for token in tokens:
            if isinstance(token, dict):
                tracks.append(token)
            elif isinstance(token, str) and token:
                tracks.append({'input': token, 'attachment_id': token, 'is_youtube': False})
        await self.start_playlist_load(r.source, tracks, name or 'JSONプレイリスト')
