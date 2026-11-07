import discord
from core.support.panel_v2 import edit_message_v2
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
from core.vc import voice_restore
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.support.legacy import Responder
from core.support.emojis import FAILED, LOUPE, MUSIC, SUCCESS
from core.vc.music_activity import build_music_activity_snapshot

from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.vc.music.ui import build_music_panel_layout  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class SearchMixin:
    class SearchView(discord.ui.View):
        def __init__(self, cog, guild_id, ctx, tracks):
            super().__init__(timeout=60.0)
            self.cog = cog
            self.guild_id = guild_id
            self.ctx = ctx
            self.tracks = tracks
            self.message = None

            options = []
            for idx, track in enumerate(self.tracks):
                label = f"{idx + 1}. {track['title']}"
                if len(label) > 100: label = label[:97] + "..."
                options.append(discord.SelectOption(label=label, value=str(idx), description="この楽曲を再生・キューに追加します"))

            self.select_menu = discord.ui.Select(placeholder="再生したい楽曲を選んでください...", min_values=1, max_values=1, options=options)
            self.select_menu.callback = self.select_callback
            self.add_item(self.select_menu)

        async def select_callback(self, interaction: discord.Interaction):
            owner = Responder(self.ctx).user
            if interaction.user.id != getattr(owner, 'id', None): return await interaction.response.send_message(embed=we(FAILED + ' この検索結果は他のユーザーのものです。'), ephemeral=True)
            idx = int(self.select_menu.values[0])
            selected_track = self.tracks[idx]
            state = self.cog.get_state(self.guild_id)
            state['current_ctx'] = self.ctx
            if not await self.cog.enqueue_track(self.guild_id, (selected_track['url'], selected_track['title'], None, True),
                                                requester_id=interaction.user.id):
                return await interaction.response.send_message(
                    embed=we(f"{FAILED} キューの上限（{MAX_QUEUE_SIZE}件）に達しています。"),
                    ephemeral=True,
                )

            vc = Responder(self.ctx).voice_client
            if vc and not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                await self.cog.check_queue(self.guild_id)
                await interaction.response.send_message(embed=we(f"{MUSIC} **{selected_track['title']}** を再生します！"))
            else:
                await interaction.response.send_message(embed=we(f"{SUCCESS} キューに追加しました: **{selected_track['title']}**"))
                await self.cog.update_panel(self.guild_id)
            await self.disable_all_items()

        async def on_timeout(self): await self.disable_all_items()
        async def disable_all_items(self):
            for item in self.children: item.disabled = True
            if self.message:
                try: await self.message.edit(view=self)
                except Exception:
                    logger.debug("Failed to disable search view items", exc_info=True)
            self.stop()


    async def _search_impl(self, r: Responder, keyword: str | None):
        """YouTube の上位10件を表示し、選んだ曲を再生・キューに追加する。"""
        if not keyword:
            return await r.send(embed=we("検索キーワードを入力してください。"), ephemeral=True)
        await r.defer()
        if error := await self._ensure_music_connection(r):
            return await r.send(embed=we(error), ephemeral=True)
        if self._spotify_playlist_id(keyword.strip()):
            try:
                title, tracks = await self.get_spotify_playlist_entries(keyword.strip())
                return await self.start_playlist_load(r.source, tracks, title)
            except Exception as exc:
                logger.exception("Spotify playlist fetch failed")
                return await r.send(embed=we(f"Spotifyプレイリストの取得に失敗しました: {exc}"))
        if self._soundcloud_kind(keyword.strip()) == "set":
            try:
                title, tracks = await self.get_soundcloud_playlist_entries(keyword.strip())
                return await self.start_playlist_load(r.source, tracks, title)
            except Exception as exc:
                logger.exception("SoundCloud set fetch failed")
                return await r.send(embed=we(f"SoundCloudセットの取得に失敗しました: {exc}"))
        if self._soundcloud_kind(keyword.strip()) == "track":
            try:
                info = await self.get_yt_info(keyword.strip())
                tracks = [{'input': info['webpage_url'], 'title': info['title'], 'is_youtube': True}]
                return await self.start_playlist_load(r.source, tracks, info['title'])
            except Exception as exc:
                logger.exception("SoundCloud fetch failed")
                return await r.send(embed=we(f"SoundCloudの取得に失敗しました: {exc}"))
        if niconico_url_kind(keyword.strip()) == "track":
            try:
                info = await self.get_yt_info(keyword.strip())
                tracks = [{'input': info['webpage_url'], 'title': info['title'], 'is_youtube': True}]
                return await self.start_playlist_load(r.source, tracks, info['title'])
            except Exception as exc:
                logger.exception("Niconico fetch failed")
                return await r.send(embed=we(f"ニコニコ動画の取得に失敗しました: {exc}"))
        await r.send(f"{LOUPE} YouTubeで「{keyword}」の上位10件を検索中...")
        search_options = YTDL_OPTIONS.copy()
        search_options['default_search'] = 'ytsearch10'
        loop = asyncio.get_event_loop()
        try:
            with yt_dlp.YoutubeDL(search_options) as ydl:
                data = await loop.run_in_executor(None, lambda: ydl.extract_info(keyword, download=False))
                if 'entries' not in data or not data['entries']: return await r.send(embed=we(FAILED + ' 検索結果が見つかりませんでした。'))
                tracks, description_lines = [], []
                for idx, entry in enumerate(data['entries'][:10]):
                    title = entry.get('title', '不明なタイトル')
                    url = entry.get('webpage_url') or entry.get('url')
                    duration_sec = entry.get('duration', 0)
                    m, s = divmod(duration_sec, 60)
                    duration_str = f"{m}:{s:02d}" if duration_sec else "不明"
                    tracks.append({'title': title, 'url': url})
                    description_lines.append(f"**{idx + 1}.** {title} `[{duration_str}]`")
                embed = we(title=f"「{keyword}」の検索結果 (上位10件)", description="\n".join(description_lines) + "\n\n下のメニューから曲を選択してください。")
                view = self.SearchView(self, r.guild.id, r.source, tracks)
                view.message = await r.send(embed=embed, view=view, want_message=True)
        except Exception as e:
            logging.error(f"Search command error: {e}")
            await r.send(embed=we(f"{FAILED} 検索中にエラーが発生しました: {e}"))


    async def _panel_impl(self, r: Responder):
        """操作パネルを出す。Bot が VC にいなければ、実行した人の VC に入る。"""
        # この操作で新規接続した場合はパネルをここで出すので、VC参加時の
        # 自動開始（ミュージックパネル）が二重に投稿しないよう控えを残す。
        if r.guild is not None:
            from core.vc.auto_start import note_self_started

            note_self_started(r.guild.id, "music_panel")
        await r.defer()
        if error := await self._ensure_music_connection(r):
            return await r.send(embed=we(error), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['current_ctx'] = r.source
        view = build_music_panel_layout(self, r.guild.id, '# ' + MUSIC + ' ボイスコントロールパネル\nステータスを同期中...')
        old_panel = state.get('panel_message')
        state['panel_message'] = await r.send(view=view, want_message=True)
        # 先にスナップショットを新しいパネルへ付け替えてから旧パネルを消す
        # （付け替え前に消すと、復旧参照が消えたメッセージを指してしまう）。
        self._save_music_snapshot(r.guild.id)
        if old_panel is not None and old_panel is not state['panel_message']:
            await self._delete_superseded_panel(old_panel)
        await self.update_panel(r.guild.id)
