import discord
from core.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands
import asyncio
import time
import logging
import configparser
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
from core.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import FAILED, MUSIC, SUCCESS
from core.music_activity import build_music_activity_snapshot

from core.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.music.common import MAX_PLAYLIST_ITEMS, SPOTIFY_PLAYLIST_RE, YTDL_OPTIONS, soundcloud_url_kind  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class SourcesMixin:
    async def get_yt_info(self, url_or_search):
        loop = asyncio.get_running_loop()
        
        # 検索キーワードかURLかを判定（すでに ytsearch: 等がついている場合も考慮）
        if not url_or_search.startswith(('http://', 'https://', 'ytsearch:')) and not url_or_search.startswith('ytsearch1:'):
            target = f"ytsearch1:{url_or_search}"  # 最初の1件だけ取得するように明示
        else:
            target = url_or_search

        def _extract():
            with yt_dlp.YoutubeDL(YTDL_OPTIONS) as ydl:
                return ydl.extract_info(target, download=False)

        try:
            data = await loop.run_in_executor(None, _extract)
        except Exception as e:
            logging.error(f"yt-dlp extract error: {e}")
            raise Exception(f"YouTubeからの情報取得に失敗しました: {e}")

        if not data:
            raise Exception("データを得られませんでした。")

        # 検索結果（entries）の場合
        if 'entries' in data:
            entries = [e for e in data['entries'] if e is not None]
            if not entries:
                raise Exception("検索結果が見つかりませんでした。")
            data = entries[0]

        # 💡 [重要] 直接再生に使用する音声ストリームURL（stream_url / url）を優先取得
        play_url = data.get('url') or data.get('webpage_url')
        webpage_url = data.get('webpage_url') or data.get('url')

        return {
            'url': play_url,             # 再生で使うストリームURL
            'stream_url': play_url,      # 互換用
            'webpage_url': webpage_url,  # YouTube動画ページのURL
            'http_headers': data.get('http_headers') or {},
            'title': data.get('title', 'Unknown Title'),
            'duration': data.get('duration', 0)
        }


    @staticmethod
    def _spotify_playlist_id(value: str) -> str | None:
        """Spotifyの通常URLおよびintl付きURLからプレイリストIDを取得する。"""
        match = SPOTIFY_PLAYLIST_RE.search(value.strip())
        return match.group(1) if match else None


    async def get_spotify_playlist_entries(self, playlist_url: str):
        """公開プレイリストを認証不要のスクレイパーでYouTubeキュー形式へ変換する。"""
        if not self._spotify_playlist_id(playlist_url):
            raise ValueError('有効なSpotifyプレイリストURLを指定してください。')

        try:
            # 外部依存の未インストールで音楽Cog全体が読み込めなくならないよう、
            # Spotify URLを実際に処理する時だけ読み込む。
            from spotify_scraper import AsyncSpotifyClient

            async with AsyncSpotifyClient(locale='ja-JP') as client:
                playlist = await client.get_playlist(playlist_url, max_tracks=MAX_PLAYLIST_ITEMS)
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                'Spotifyスクレイパーが未インストールです。requirements.txtを再インストールしてください。'
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                'Spotifyプレイリストを読み込めませんでした。公開されているプレイリストURLを指定してください。'
            ) from exc

        tracks = []
        for playlist_track in playlist.tracks[:MAX_PLAYLIST_ITEMS]:
            track = playlist_track.track
            if not track.name:
                continue
            artists = ', '.join(artist.name for artist in track.artists if artist.name)
            query = f'{track.name} {artists}'.strip()
            tracks.append({
                'input': f'ytsearch1:{query}',
                'title': f'{track.name} — {artists}' if artists else track.name,
                'is_youtube': True,
            })
        return playlist.name or 'Spotifyプレイリスト', tracks


    async def _load_spotify_playlist_in_background(self, interaction, playlist_url: str, status_message):
        state = self.get_state(interaction.guild_id)
        try:
            await status_message.edit(content='Spotifyプレイリストの曲一覧を取得しています…')
            title, tracks = await self.get_spotify_playlist_entries(playlist_url)
            if not tracks:
                await status_message.edit(content='Spotifyプレイリストから再生可能な曲を取得できませんでした。')
                return
            await status_message.edit(content=f'Spotifyプレイリスト `{title}` を取得しました（全 {len(tracks)} 件）。キューへ追加します…')
            await self._load_playlist_in_background(interaction, tracks, title, status_message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception('Spotify playlist extraction failed')
            try:
                await status_message.edit(content=f'Spotifyプレイリストの取得に失敗しました: {exc}')
            except discord.HTTPException:
                logger.debug("Spotify playlist load status update failed", exc_info=True)
        finally:
            state['playlist_load_task'] = None


    async def start_spotify_playlist_load(self, interaction, playlist_url: str):
        state = self.get_state(interaction.guild_id)
        state['current_ctx'] = interaction
        existing = state.get('playlist_load_task')
        if existing and not existing.done():
            existing.cancel()
        status_message = await interaction.followup.send(
            'Spotifyプレイリストの読込を受け付けました。バックグラウンドで曲一覧を取得します。',
            wait=True,
        )
        state['playlist_load_task'] = asyncio.create_task(
            self._load_spotify_playlist_in_background(interaction, playlist_url, status_message)
        )


    async def get_youtube_playlist_entries(self, playlist_url: str):
        """個別の音声URLを解決せず、YouTubeプレイリストの曲ページURLだけを取得する。"""
        loop = asyncio.get_running_loop()
        options = YTDL_OPTIONS.copy()
        options.update({
            'noplaylist': False,
            'extract_flat': 'in_playlist',
            'lazy_playlist': True,
            'skip_download': True,
        })

        def _extract():
            with yt_dlp.YoutubeDL(options) as ydl:
                data = ydl.extract_info(playlist_url, download=False)
                entries = []
                for entry in data.get('entries') or []:
                    if not entry:
                        continue
                    webpage_url = entry.get('webpage_url') or entry.get('url')
                    if not webpage_url:
                        continue
                    entries.append({
                        'input': webpage_url,
                        'title': entry.get('title') or '不明なタイトル',
                        'is_youtube': True,
                    })
                return data.get('title') or 'YouTubeプレイリスト', entries

        return await loop.run_in_executor(None, _extract)


    async def _load_youtube_playlist_in_background(self, interaction, playlist_url: str, status_message):
        state = self.get_state(interaction.guild_id)
        try:
            await status_message.edit(content='YouTubeプレイリストの曲一覧を取得しています…')
            title, tracks = await self.get_youtube_playlist_entries(playlist_url)
            if not tracks:
                await status_message.edit(content='YouTubeプレイリストから再生可能な曲を取得できませんでした。')
                return
            await status_message.edit(content=f'プレイリスト `{title}` を取得しました（全 {len(tracks)} 件）。キューへ順次追加します…')
            await self._load_playlist_in_background(interaction, tracks, title, status_message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception('YouTube playlist extraction failed')
            try:
                await status_message.edit(content=f'YouTubeプレイリストの取得に失敗しました: {exc}')
            except discord.HTTPException:
                logger.debug("YouTube playlist load status update failed", exc_info=True)
        finally:
            state['playlist_load_task'] = None


    async def start_youtube_playlist_load(self, interaction, playlist_url: str):
        state = self.get_state(interaction.guild_id)
        state['current_ctx'] = interaction
        existing = state.get('playlist_load_task')
        if existing and not existing.done():
            existing.cancel()
        status_message = await interaction.followup.send(
            'YouTubeプレイリストの読込を受け付けました。バックグラウンドで曲一覧を取得します。',
            wait=True,
        )
        state['playlist_load_task'] = asyncio.create_task(
            self._load_youtube_playlist_in_background(interaction, playlist_url, status_message)
        )


    @staticmethod
    def _soundcloud_kind(value: str) -> str | None:
        """SoundCloud URLなら 'set' / 'track'、それ以外は None。"""
        return soundcloud_url_kind(value)


    async def get_soundcloud_playlist_entries(self, playlist_url: str):
        """個別の音声URLを解決せず、SoundCloudセットの曲ページURLだけを取得する。"""
        loop = asyncio.get_running_loop()
        options = YTDL_OPTIONS.copy()
        options.update({
            'noplaylist': False,
            'extract_flat': 'in_playlist',
            'lazy_playlist': True,
            'skip_download': True,
        })

        def _extract():
            with yt_dlp.YoutubeDL(options) as ydl:
                data = ydl.extract_info(playlist_url, download=False)
                entries = []
                for entry in data.get('entries') or []:
                    if not entry:
                        continue
                    webpage_url = entry.get('webpage_url') or entry.get('url')
                    if not webpage_url:
                        continue
                    title = entry.get('title')
                    if not title:
                        # フラット抽出ではタイトルが得られないため、URL末尾から仮タイトルを作る。
                        slug = webpage_url.rstrip('/').rsplit('/', 1)[-1]
                        title = slug.replace('-', ' ').strip() or '不明なタイトル'
                    entries.append({
                        'input': webpage_url,
                        'title': title,
                        'is_youtube': True,
                    })
                return data.get('title') or 'SoundCloudセット', entries

        return await loop.run_in_executor(None, _extract)


    async def _load_soundcloud_playlist_in_background(self, interaction, playlist_url: str, status_message):
        state = self.get_state(interaction.guild_id)
        try:
            await status_message.edit(content='SoundCloudセットの曲一覧を取得しています…')
            title, tracks = await self.get_soundcloud_playlist_entries(playlist_url)
            if not tracks:
                await status_message.edit(content='SoundCloudセットから再生可能な曲を取得できませんでした。')
                return
            await status_message.edit(content=f'セット `{title}` を取得しました（全 {len(tracks)} 件）。キューへ順次追加します…')
            await self._load_playlist_in_background(interaction, tracks, title, status_message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception('SoundCloud playlist extraction failed')
            try:
                await status_message.edit(content=f'SoundCloudセットの取得に失敗しました: {exc}')
            except discord.HTTPException:
                logger.debug("SoundCloud playlist load status update failed", exc_info=True)
        finally:
            state['playlist_load_task'] = None


    async def start_soundcloud_playlist_load(self, interaction, playlist_url: str):
        state = self.get_state(interaction.guild_id)
        state['current_ctx'] = interaction
        existing = state.get('playlist_load_task')
        if existing and not existing.done():
            existing.cancel()
        status_message = await interaction.followup.send(
            'SoundCloudセットの読込を受け付けました。バックグラウンドで曲一覧を取得します。',
            wait=True,
        )
        state['playlist_load_task'] = asyncio.create_task(
            self._load_soundcloud_playlist_in_background(interaction, playlist_url, status_message)
        )
