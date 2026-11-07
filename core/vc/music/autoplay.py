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
from core.support.emojis import FAILED, MUSIC, SUCCESS
from core.vc.music.music_activity import build_music_activity_snapshot

from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.vc.music import history

logger = logging.getLogger("cogs.sio_music")

# 人のリクエストが無いまま自動補充を続ける上限。キューの上限（50曲）まで
# 流し続けると「誰も頼んでいない再生」が何時間も続くため、アルバム1枚分
# 程度の10曲で一旦止め、パネル通知で人の介入（リクエスト or 入れ直し）を促す。
MAX_CONSECUTIVE_AUTO = 10
RELATED_FETCH_TIMEOUT_SECONDS = 25.0
RELATED_LIMIT = 25
_YT_ID_RE = re.compile(r"(?:watch\?v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{6,})")


def youtube_video_id(url: str | None) -> str | None:
    match = _YT_ID_RE.search(url or "")
    return match.group(1) if match else None


class AutoplayMixin:
    """自動再生 v1: 履歴の記録フック、キュー自動補充、関連曲取得、トグル。"""

    # ------------------------------------------------------------------
    # 履歴の記録（再生開始・終了のフック。playback.py から呼ばれる）
    # ------------------------------------------------------------------
    def _note_track_started(self, guild_id: int, entry, requester_id, auto, *,
                            title, source_input, is_yt, b62_id, artist=None):
        """再生が実際に始まった曲を履歴へ記録し、関連曲シードを更新する。"""
        state = self.get_state(guild_id)
        state['current_requester_id'] = requester_id
        state['current_auto'] = auto
        if is_yt and state.get('current_yt_page_url'):
            source_input = state['current_yt_page_url']
        key = history.track_key(source_input, b62_id, is_yt)
        state['current_history_key'] = key
        state['last_seed'] = {
            'key': key,
            'page_url': state.get('current_yt_page_url') if is_yt else None,
            'title': title,
        }
        recent = state.setdefault('session_recent_keys', [])
        recent.append(key)
        if len(recent) > 50:
            del recent[: len(recent) - 50]
        if requester_id:
            try:
                history.get_store().record_play(
                    requester_id,
                    key=key,
                    source_input=source_input,
                    title=title,
                    artist=artist,
                    source=history.source_kind(source_input, b62_id, is_yt),
                    is_yt=is_yt,
                    b62_id=b62_id,
                )
            except Exception:
                logger.debug("再生履歴の記録に失敗しました", exc_info=True)

    def _note_track_finished(self, guild_id: int, *, completed: bool):
        """自然終了（completed=True）/ スキップ（False）を履歴へ記録する。"""
        state = self.get_state(guild_id)
        requester_id = state.get('current_requester_id')
        key = state.get('current_history_key')
        if requester_id and key:
            try:
                history.get_store().record_outcome(requester_id, key, completed=completed)
            except Exception:
                logger.debug("再生履歴の結果記録に失敗しました", exc_info=True)

    # ------------------------------------------------------------------
    # トグル・履歴削除（パネル/ライブラリから呼ばれる）
    # ------------------------------------------------------------------
    async def _autoplay_toggle_impl(self, interaction: discord.Interaction):
        state = self.get_state(interaction.guild_id)
        state['autoplay_enabled'] = not state.get('autoplay_enabled', False)
        enabled = state['autoplay_enabled']
        if enabled:
            state['autoplay_stopped'] = False
            state['autoplay_auto_count'] = 0
            state['autoplay_notice_sent'] = False
        label = 'ON' if enabled else 'OFF'
        note = (
            "キューが尽きたら、VCにいる人のリクエスト履歴などから自動で補充します。"
            if enabled else ""
        )
        await interaction.response.send_message(
            embed=we(f"{MUSIC} 自動再生を **{label}** にしました。{note}"))
        await self.update_panel(interaction.guild_id)
        self._save_music_snapshot(interaction.guild_id)
        if enabled and not state.get('current_track') and state['queue'].empty():
            # check_queue の送信先ゲートをこの interaction で満たして補充を始める。
            state['current_interaction'] = interaction
            await self.check_queue(interaction.guild_id)

    async def _history_clear_impl(self, interaction: discord.Interaction):
        store = history.get_store()
        removed = store.clear_user(interaction.user.id)
        store.flush()
        await interaction.response.send_message(
            embed=we("あなたの再生履歴を削除しました。" if removed
                     else "削除できる再生履歴はありませんでした。"),
            ephemeral=True,
        )

    # ------------------------------------------------------------------
    # 自動補充
    # ------------------------------------------------------------------
    def _autoplay_exclude_keys(self, state) -> set:
        """選曲から外す曲キー（再生中・キュー内・このセッションの直近再生）。"""
        exclude = set(state.get('session_recent_keys') or [])
        current_key = state.get('current_history_key')
        if current_key:
            exclude.add(current_key)
        for item in list(state['queue']._queue):
            try:
                target_input, _filename, b62_id, is_yt = item
            except (TypeError, ValueError):
                continue
            exclude.add(history.track_key(target_input, b62_id, is_yt))
        return exclude

    async def _notify_autoplay_capped(self, guild_id: int):
        state = self.get_state(guild_id)
        if state.get('autoplay_notice_sent'):
            return
        state['autoplay_notice_sent'] = True
        ctx_or_interaction = state.get('current_ctx') or state.get('current_interaction')
        if ctx_or_interaction is not None:
            await self._send_message(
                ctx_or_interaction,
                embed=we(
                    f"{MUSIC} 自動再生の連続補充が上限（{MAX_CONSECUTIVE_AUTO}曲）に達したため"
                    "一時停止しました。曲をリクエストするか、パネルで自動再生を入れ直すと再開します。"
                ),
            )
        await self.update_panel(guild_id)

    async def maybe_autoplay_refill(self, guild_id: int) -> bool:
        """自動再生が有効で条件を満たせば1曲だけキューへ補充する。"""
        state = self.get_state(guild_id)
        if not state.get('autoplay_enabled') or state.get('autoplay_stopped'):
            return False
        if state.get('autoplay_auto_count', 0) >= MAX_CONSECUTIVE_AUTO:
            await self._notify_autoplay_capped(guild_id)
            return False
        guild = self.bot.get_guild(guild_id)
        vc = guild.voice_client if guild else None
        if vc is None or not vc.is_connected():
            return False
        channel = getattr(vc, 'channel', None)
        members = [m for m in (getattr(channel, 'members', None) or [])
                   if not getattr(m, 'bot', False)]
        if not members:
            return False
        if state['queue'].full():
            return False

        store = history.get_store()
        store.maybe_flush()
        histories = {m.id: store.user_tracks(m.id) for m in members}
        related = await self._fetch_related_tracks(guild_id, state)
        global_pool = store.all_tracks()
        exclude = self._autoplay_exclude_keys(state)
        member_names = {
            m.id: (getattr(m, 'display_name', None) or getattr(m, 'name', '') or 'メンバー')
            for m in members
        }

        for _attempt in range(3):
            picked = history.select_autoplay_candidate(
                histories=histories,
                related=related,
                global_pool=global_pool,
                exclude_keys=exclude,
                rng=random,
                last_user_id=state.get('autoplay_last_user_id'),
            )
            if picked is None:
                return False
            candidate, kind = picked
            track = await self._candidate_to_queue_track(guild_id, candidate)
            if track is None:
                # 添付URLが再取得できない等で再生不能な候補は外して選び直す。
                exclude.add(candidate.get('key'))
                continue
            if kind == 'history':
                label = f"{member_names.get(candidate.get('user_id'), 'メンバー')}の履歴から"
            elif kind == 'related':
                label = "関連曲"
            else:
                label = "よく聴かれている曲"
            ok = await self.enqueue_track(
                guild_id, track,
                requester_id=candidate.get('user_id'),
                auto={'kind': kind, 'label': label},
            )
            if not ok:
                return False
            state['autoplay_auto_count'] = state.get('autoplay_auto_count', 0) + 1
            if candidate.get('user_id'):
                state['autoplay_last_user_id'] = candidate['user_id']
            return True
        return False

    async def _candidate_to_queue_track(self, guild_id: int, candidate):
        """履歴候補をキュー要素へ変換する。再生不能なら None。"""
        b62_id = candidate.get('b62_id')
        if b62_id:
            try:
                url, filename = await self.get_attachment_info(b62_id, guild_id)
            except Exception:
                logger.debug("添付情報の再取得に失敗しました", exc_info=True)
                return None
            if not url:
                return None
            return (url, candidate.get('title') or filename, b62_id, False)
        source_input = candidate.get('input')
        if not source_input:
            return None
        return (source_input, candidate.get('title'), None, bool(candidate.get('is_yt')))

    async def _autoplay_prefetch(self, guild_id: int):
        """再生中の曲が最後の1曲になったときの先読み補充（最小限）。"""
        try:
            await asyncio.sleep(2)
            state = self.get_state(guild_id)
            if not state.get('autoplay_enabled') or state.get('autoplay_stopped'):
                return
            if state['queue'].qsize() > 0 or state.get('current_track') is None:
                return
            if await self.maybe_autoplay_refill(guild_id):
                await self.update_panel(guild_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("自動再生の先読み補充に失敗しました", exc_info=True)

    # ------------------------------------------------------------------
    # 関連曲の取得（YouTube Mix を第一手段にするベストエフォート）
    # ------------------------------------------------------------------
    async def _fetch_related_tracks(self, guild_id: int, state) -> list:
        """最後に再生した曲の関連曲候補を返す。取れなければ空リスト。

        - YouTube: 公式の Mix（RD プレイリスト）を extract_flat で引く。
        - Mix が取れない場合はタイトル検索の上位で代替する。
        - SoundCloud / ニコニコ等は yt-dlp から関連が取れないため対象外
          （呼び出し側は履歴集計へフォールバックする）。
        結果はシード曲ごとに state へキャッシュし、毎曲抽出を叩かない。
        """
        seed = state.get('last_seed') or {}
        seed_key = seed.get('key')
        if not seed_key:
            return []
        cache = state.get('related_cache') or {}
        if cache.get('seed_key') == seed_key:
            return cache.get('tracks') or []

        tracks: list[dict] = []
        page_url = seed.get('page_url')
        video_id = youtube_video_id(page_url)
        if video_id:
            mix_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
            entries = await self._extract_flat_entries(mix_url, RELATED_LIMIT + 5)
            for entry in entries:
                if entry.get('id') == video_id:
                    continue
                url = entry.get('webpage_url') or entry.get('url')
                if not url or not entry.get('title'):
                    continue
                tracks.append({
                    'key': history.track_key(url, None, True),
                    'input': url,
                    'title': entry['title'],
                    'artist': entry.get('uploader') or entry.get('channel'),
                    'source': 'youtube',
                    'is_yt': True,
                    'b62_id': None,
                    'count': 0,
                })
                if len(tracks) >= RELATED_LIMIT:
                    break
        if not tracks and seed.get('title'):
            entries = await self._extract_flat_entries(
                f"ytsearch{RELATED_LIMIT}:{seed['title']}", RELATED_LIMIT)
            for entry in entries:
                url = entry.get('webpage_url') or entry.get('url')
                if not url or not entry.get('title'):
                    continue
                key = history.track_key(url, None, True)
                if key == seed_key:
                    continue
                tracks.append({
                    'key': key,
                    'input': url,
                    'title': entry['title'],
                    'artist': entry.get('uploader') or entry.get('channel'),
                    'source': 'youtube',
                    'is_yt': True,
                    'b62_id': None,
                    'count': 0,
                })
        state['related_cache'] = {'seed_key': seed_key, 'tracks': tracks}
        return tracks

    async def _extract_flat_entries(self, target: str, limit: int) -> list:
        """yt-dlp の extract_flat でプレイリスト/検索の候補だけを軽く引く。"""
        loop = asyncio.get_running_loop()

        def _extract():
            options = dict(YTDL_OPTIONS)
            options.update({
                'extract_flat': True,
                'noplaylist': False,
                'playlist_items': f'1:{limit}',
            })
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(target, download=False)

        try:
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _extract),
                timeout=RELATED_FETCH_TIMEOUT_SECONDS,
            )
        except Exception:
            logger.debug("関連曲の取得に失敗しました target=%s", target, exc_info=True)
            return []
        if not data:
            return []
        entries = data.get('entries')
        if entries is None:
            return [data]
        return [entry for entry in entries if entry][:limit]
