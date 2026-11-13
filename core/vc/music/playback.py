import discord
from core.support.panel_v2 import edit_message_v2, as_embed_v2
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
from core.support.emojis import CLOCK, CROCK, FAILED, LOUPE, MUSIC, PAUSE, SUCCESS
from core.vc.music.music_activity import build_music_activity_snapshot

from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.vc.music.spatial import PythonSpatialAudioSource  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class PlaybackMixin:
    async def check_queue(self, guild_id: int):
        state = self.get_state(guild_id)
        
        # 💡 [修正点1] ctx または interaction のどちらかが入っていれば通過させる
        ctx_or_interaction = state.get('current_ctx') or state.get('current_interaction')

        if state.get('is_processing_queue') or ctx_or_interaction is None:
            return
        
        # ボイスクライアントの取得（Guild経由で取得するのが一番安全）
        guild = self.bot.get_guild(guild_id)
        vc = guild.voice_client if guild else None

        if vc is None or not vc.is_connected():
            state['is_processing_queue'] = False
            return

        # 録音など共有対象外の機能が VC を使っているときは、その音声を上書きしない。
        if self._busy_message(guild):
            return

        # 同一ギルドで既に再生中・一時停止中なら、別経路からの二重開始を防ぐ。
        if has_audio_source(vc, "music") or state.get('is_paused'):
            return

        # yt-dlp取得などのawaitより前にフラグを確保する。
        # これにより同時に到達したcheck_queue()が同じ曲でvc.play()を呼ばない。
        state['is_processing_queue'] = True
        track_artist = None

        if state.get('current_track') is None:
            if state['queue'].empty():
                # 自動再生が有効なら、尽きたキューへ1曲補充して再生を続ける。
                state['is_processing_queue'] = False
                if await self.maybe_autoplay_refill(guild_id):
                    return await self.check_queue(guild_id)
                await self.update_panel(guild_id)
                self._save_music_snapshot(guild_id)
                return

            queue = state['queue']
            requesters = state.setdefault('queue_requesters', [])
            if state.get('shuffle_enabled') and queue.qsize() > 1:
                queue_items = queue._queue
                selected_index = random.randrange(len(queue_items))
                entry = queue_items[selected_index]
                target_input, filename, b62_id, is_yt = entry
                del queue_items[selected_index]
                meta = requesters.pop(selected_index) if selected_index < len(requesters) else None
            else:
                entry = await queue.get()
                target_input, filename, b62_id, is_yt = entry
                meta = requesters.pop(0) if requesters else None
            state['current_queue_entry'] = entry
            state['current_entry_meta'] = meta if isinstance(meta, dict) else {'user_id': None, 'auto': None}
            track_artist = None

            if is_yt:
                try:
                    info = await self.get_yt_info(target_input)
                    # /music のパネルから再生 では先に取得済みの動画タイトルをキューへ保存している。
                    # ストリームURLを再解析すると、汎用エクストラクタのファイル名
                    # （例: "videoplayback"）になる場合があるため、保存済みのタイトルを優先する。
                    video_title = filename or info['title']
                    track_artist = info.get('uploader')
                    state['current_yt_page_url'] = info['webpage_url']
                    state['current_thumbnail_url'] = info.get('thumbnail') or None
                    state['current_yt_headers'] = info['http_headers']
                    state['current_track'] = (info['stream_url'], video_title, info['duration'], b62_id, is_yt)
                except Exception as e:
                    logging.error(f"YouTube解析失敗: {e}")
                    # 💡 安全なメッセージ送信ハンドラ
                    await self._send_message(ctx_or_interaction, embed=we(f"{FAILED} 解析に失敗しました。"))
                    state['is_processing_queue'] = False
                    return await self.check_queue(guild_id)
            else:
                duration = await self.get_duration(target_input)
                state['current_yt_page_url'] = None
                state['current_thumbnail_url'] = None
                state['current_yt_headers'] = {}
                state['current_track'] = (target_input, filename, duration, b62_id, is_yt) 

        url, filename, duration, b62_id, is_yt = state['current_track']
        
        if state.get('elapsed_offset', 0) > 0 and is_yt:
            try:
                # videoplayback URLではなく、保持済みの動画ページURLから再取得する。
                page_url = state.get('current_yt_page_url')
                if not page_url:
                    raise RuntimeError("YouTube動画ページURLが見つかりません。")
                info = await self.get_yt_info(page_url)
                url = info['stream_url']
                state['current_yt_headers'] = info['http_headers']
            except Exception:
                logger.debug("YouTube stream URL refresh failed", exc_info=True)

        # --- 【FFmpeg基本設定】 ---
        before_options = '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5'
        stream_headers = state.get('current_yt_headers') or {}
        if b62_id and not stream_headers:
            stream_headers = {'User-Agent': 'Mozilla/5.0'}
        ffmpeg_headers = build_ffmpeg_headers(stream_headers)
        if ffmpeg_headers:
            before_options += f' -headers {shlex.quote(ffmpeg_headers)}'
        
        if state.get('elapsed_offset', 0) > 0:
            before_options += f" -ss {state['elapsed_offset']}"

        speed = float(np.clip(state.get('speed', 1.0), MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED))
        eq_mode = state.get('eq', 'flat')
        audio_filters = build_atempo_filters(speed)
        if eq_mode != 'spatial':
            volume = float(np.clip(state.get('volume', 1.0), 0.0, 2.0))
            audio_filters.append(f"volume={volume:.3f}")
            if eq_mode == 'custom':
                custom_filter = state.get('custom_eq_filter')
                if custom_filter and is_safe_custom_audio_filter(custom_filter):
                    audio_filters.append(custom_filter)
            elif eq_mode in FFMPEG_REALTIME_PRESETS:
                audio_filters.append(FFMPEG_REALTIME_PRESETS[eq_mode])
        options = f"-vn -ar 48000 -ac 2 -af {shlex.quote(','.join(audio_filters))}"

        try:
            # yt-dlpと同じHTTPヘッダーでFFmpegを起動する。Spatial以外は
            # そのPCMを直接Discordへ渡し、Pythonのサンプル単位処理を回避する。
            raw_source = FFmpegPCMAudioDiagnostics(url, before_options=before_options, options=options)
            source = PythonSpatialAudioSource(raw_source, state) if eq_mode == 'spatial' else raw_source
            
            # 開始直前にも状態を確認し、外部イベントとの競合を吸収する。
            if has_audio_source(vc, "music") or state.get('is_paused'):
                state['is_processing_queue'] = False
                return

            state['start_time'] = time.time()
            add_audio_source(
                vc, "music", source,
                after=lambda e: self.bot.loop.call_soon_threadsafe(self.play_next, guild_id, e),
            )
            self._start_progress_task(guild_id)
            await self.update_panel(guild_id)
            self._save_music_snapshot(guild_id)

            # FFmpegが少なくとも1フレームのPCMを出力するまで待つ。vc.play()直後の
            # 表示では、URLの403やデコーダー失敗でも「再生中」と誤表示されるため。
            for _ in range(20):
                if source.has_output and has_audio_source(vc, "music"):
                    break
                if not has_audio_source(vc, "music"):
                    break
                await asyncio.sleep(0.1)

            if source.has_output and has_audio_source(vc, "music"):
                # 再生が実際に始まった曲だけを履歴へ記録する（再開・シークでは
                # 同じキュー要素が再入するため、要素の同一性で二重記録を防ぐ）。
                entry = state.get('current_queue_entry')
                if entry is not None and state.get('history_counted_entry') is not entry:
                    state['history_counted_entry'] = entry
                    meta = state.get('current_entry_meta') or {}
                    self._note_track_started(
                        guild_id, entry, meta.get('user_id'), meta.get('auto'),
                        title=filename, source_input=entry[0], is_yt=is_yt,
                        b62_id=b62_id, artist=track_artist,
                    )
                # 再生中が最後の1曲なら、自動再生の先読み補充を予約する。
                if (state.get('autoplay_enabled') and not state.get('autoplay_stopped')
                        and state.get('loop_mode', 'off') == 'off'
                        and state['queue'].qsize() == 0):
                    asyncio.create_task(self._autoplay_prefetch(guild_id))

            if source.has_output and has_audio_source(vc, "music") and state.get('elapsed_offset', 0) < 1:
                current_eq_mode = state.get('eq', 'flat')
                eq_label = "custom" if current_eq_mode == "custom" else current_eq_mode
                status = f"Speed: {state.get('speed', 1.0)}x / Vol: {state.get('volume', 1.0)} / EQ: {eq_label}"
                await self._send_message(ctx_or_interaction, embed=we(f"{MUSIC} 再生中: **{filename}**\n`{status}`"))
        
        except Exception as e:
            logging.error(f"Playback error: {e}")
            state['is_processing_queue'] = False
            if "Already playing audio" in str(e):
                # 既存の再生を壊したりキューを消費したりせず、競合が解消されるのを待つ。
                await self.update_panel(guild_id)
                return
            state['current_track'] = None
            await self.check_queue(guild_id)


    async def _send_message(self, ctx_or_interaction, text=None, embed=None):
        view = as_embed_v2(embed)
        try:
            if isinstance(ctx_or_interaction, discord.Interaction):
                interaction = ctx_or_interaction
                # インタラクションのトークンは発行から15分で失効する。
                # 長時間の再生で保持した古い interaction は使わず、
                # チャンネルへ直接送る（失効トークンで 401 を繰り返さない）。
                age = (discord.utils.utcnow() - interaction.created_at).total_seconds()
                if age <= 14 * 60:
                    if interaction.response.is_done():
                        await interaction.followup.send(content=text, view=view)
                    else:
                        await interaction.response.send_message(content=text, view=view)
                    return
                channel = interaction.channel
                if channel is not None:
                    await channel.send(content=text, view=view)
                return
            elif hasattr(ctx_or_interaction, 'send'):
                await ctx_or_interaction.send(content=text, view=view)
        except discord.HTTPException as e:
            # 失効直後など、年齢判定をすり抜けた 401 はチャンネル送信で救う。
            if isinstance(ctx_or_interaction, discord.Interaction) and e.status == 401:
                channel = ctx_or_interaction.channel
                if channel is not None:
                    try:
                        await channel.send(content=text, view=view)
                        return
                    except Exception:
                        pass
            logging.error(f"送信エラー: {e}")
        except Exception as e:
            logging.error(f"送信エラー: {e}")


    def _make_loop_track(self, state):
        """失効しやすいYouTubeストリームURLではなく、再解析可能な入力を再投入する。"""
        track = state.get('current_track')
        if not track:
            return None
        stream_url, filename, _duration, b62_id, is_yt = track
        source_input = state.get('current_yt_page_url') if is_yt else stream_url
        if not source_input:
            return None
        return (source_input, filename, b62_id, is_yt)


    def play_next(self, guild_id: int, error=None):
        state = self.get_state(guild_id)

        # ★ 設定変更中は何もしない（current_track / elapsed_offset を保持）。
        #   apply_immediate_setting() が remove_audio_source() で止めた際に
        #   呼ばれる after コールバックが、キューを次へ進めてしまうのを防ぐ。
        if state.get('is_changing_setting'):
            return

        if error:
            logger.error("Player error: %r", error)
            failed_track = state.get('current_track')
            failed_title = failed_track[1] if failed_track else '不明なトラック'
            ctx_or_interaction = state.get('current_ctx') or state.get('current_interaction')
            state['is_processing_queue'] = False
            state['current_track'] = None
            state['current_yt_page_url'] = None
            state['current_thumbnail_url'] = None
            state['current_yt_headers'] = {}
            state['elapsed_offset'] = 0
            state['retry_count'] = 0

            async def report_failure_and_continue():
                await self._send_message(
                    ctx_or_interaction,
                    embed=we(f"{FAILED} **{failed_title}** の音声デコードに失敗しました。次のキューを確認します。")
                )
                await self.check_queue(guild_id)

            loop = self.bot.loop if hasattr(self.bot, 'loop') else asyncio.get_event_loop()
            loop.create_task(report_failure_and_continue())
            return

        if state['is_paused'] or state['is_changing_setting']:
            state['is_processing_queue'] = False
            return

        actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
        state['elapsed_offset'] += actual_played
        
        track = state['current_track']
        duration = track[2] if track else 0
        is_interrupted = (duration - state['elapsed_offset']) > 5
        
        state['is_processing_queue'] = False

        # 安全なイベントループ取得
        loop = self.bot.loop if hasattr(self.bot, 'loop') else asyncio.get_event_loop()

        if is_interrupted and state['retry_count'] < 3 and state['current_track']:
            state['retry_count'] += 1
            asyncio.run_coroutine_threadsafe(self.check_queue(guild_id), loop)
            return

        # 最後まで再生し切った場合だけ「完了」を履歴へ残す（中断・デコード
        # 失敗は学習材料として数えない。スキップはスキップ操作側で記録する）。
        if track and not is_interrupted:
            self._note_track_finished(guild_id, completed=True)

        loop_track = self._make_loop_track(state)
        loop_mode = state.get('loop_mode', 'off')
        if loop_track and loop_mode == 'track':
            state['queue']._queue.appendleft(loop_track)
            requesters = state.setdefault('queue_requesters', [])
            requesters.insert(0, state.get('current_entry_meta') or {'user_id': None, 'auto': None})
        elif loop_track and loop_mode == 'queue':
            state['queue']._queue.append(loop_track)
            requesters = state.setdefault('queue_requesters', [])
            requesters.append(state.get('current_entry_meta') or {'user_id': None, 'auto': None})

        state['current_track'] = None
        state['current_yt_page_url'] = None
        state['current_thumbnail_url'] = None
        state['current_yt_headers'] = {}
        state['elapsed_offset'] = 0
        state['retry_count'] = 0
        asyncio.run_coroutine_threadsafe(self.check_queue(guild_id), loop)


    async def _play_impl(
        self,
        interaction: discord.Interaction,
        query: str = None,
        file: discord.Attachment = None,
        start_at: float | None = None,
    ):
        # 💡 1. 処理に時間がかかる可能性があるので、一番最初に defer() を実行
        await interaction.response.defer()

        # 💡 2. ボイスチャンネル接続（入っていなければ自動で参加。別機能が使用中なら断る）
        if error := await self._ensure_music_connection(Responder(interaction)):
            return await interaction.followup.send(view=as_embed_v2(we(error)), ephemeral=True)

        state = self.get_state(interaction.guild_id)
        state['current_interaction'] = interaction
        if start_at is not None and start_at < 0:
            return await interaction.followup.send(view=as_embed_v2(we("開始位置は0秒以上で指定してください。")), ephemeral=True)
        can_apply_start_at = not state.get('current_track') and state['queue'].empty() and not state.get('is_processing_queue')
        if start_at is not None and not can_apply_start_at:
            return await interaction.followup.send(view=as_embed_v2(we("開始位置の指定は、再生中の曲と待機キューがない場合のみ使えます。再生中の曲は `/vc` の音楽操作パネルから操作してください。")), ephemeral=True)

        is_yt = False
        url, filename, final_id = None, None, None

        # query が None の場合に備えて安全に strip 処理
        input_str = query.strip() if query else ""

        # ⏱️ タイムアウト秒数の設定 (15秒)
        TIMEOUT_SECONDS = 45.0

        # YouTube関連ドメイン判定
        yt_pattern = re.compile(r'https?://(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/', re.IGNORECASE)

        # 1. Spotifyプレイリストは曲一覧の取得が長時間化するため、即時受付してバックグラウンド処理へ渡す。
        if input_str and self._spotify_playlist_id(input_str):
            await self.start_spotify_playlist_load(interaction, input_str)
            return

        # 2. YouTubeプレイリストは曲一覧の取得が長時間化するため、即時受付してバックグラウンド処理へ渡す。
        if input_str and yt_pattern.search(input_str) and re.search(r'[?&]list=[^&]+', input_str):
            await self.start_youtube_playlist_load(interaction, input_str)
            return

        # 2.5. SoundCloudセットも同様に、即時受付してバックグラウンド処理へ渡す。
        if input_str and self._soundcloud_kind(input_str) == "set":
            await self.start_soundcloud_playlist_load(interaction, input_str)
            return

        # 3. YouTube単曲URLが直接指定された場合
        if input_str and yt_pattern.search(input_str):
            await interaction.followup.send(CROCK + ' YouTubeを解析中...')
            try:
                # ⏱️ タイムアウト付きで解析実行
                info = await asyncio.wait_for(self.get_yt_info(input_str), timeout=TIMEOUT_SECONDS)
                # キューには一時ストリームURLではなく動画ページURLを保存する。
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send(f"{CLOCK} タイムアウト: YouTube情報の解析に時間がかかりすぎたため中断しました。")
            except Exception as e:
                logger.exception("YouTube parse failed")
                return await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 解析に失敗しました。")))

        # 3.5. SoundCloud単曲URLが直接指定された場合（再生時にページURLから再解析する）
        elif input_str and self._soundcloud_kind(input_str) == "track":
            await interaction.followup.send(f"{MUSIC} SoundCloudを解析中...")
            try:
                info = await asyncio.wait_for(self.get_yt_info(input_str), timeout=TIMEOUT_SECONDS)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send(f"{CLOCK} タイムアウト: SoundCloud情報の解析に時間がかかりすぎたため中断しました。")
            except Exception as e:
                logger.exception("SoundCloud parse failed")
                return await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 解析に失敗しました。")))

        # 3.6. ニコニコ動画URLが直接指定された場合
        elif input_str and niconico_url_kind(input_str) == "track":
            await interaction.followup.send(f"{MUSIC} ニコニコ動画を解析中...")
            try:
                info = await asyncio.wait_for(self.get_yt_info(input_str), timeout=TIMEOUT_SECONDS)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send(f"{CLOCK} タイムアウト: ニコニコ動画情報の解析に時間がかかりすぎたため中断しました。")
            except Exception as e:
                logger.exception("Niconico parse failed")
                return await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 解析に失敗しました。")))

        # 2. ファイルが添付されている場合
        elif file:
            url, filename = file.url, file.filename
            # Interaction IDは添付ファイルを持つメッセージIDではないため、後から
            # get_attachment_info()で再取得できない。Discordの添付URLを保存する。
            final_id = url

        # 3. BASE62 のユニバーサルID指定（または検索へのフォールバック）
        elif input_str and len(input_str.split()) == 1 and all(c in BASE62 for c in input_str):
            try:
                url, filename = await asyncio.wait_for(self.get_attachment_info(input_str, interaction.guild_id), timeout=TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                return await interaction.followup.send(f"{CLOCK} タイムアウト: ID情報の取得に時間がかかりすぎました。")
            except Exception:
                logger.debug("Attachment info lookup failed", exc_info=True)
                url, filename = None, None
            
            final_id = input_str
            
            if not url:
                await interaction.followup.send(f"{LOUPE} YouTubeで「{input_str}」を検索中...")
                try:
                    info = await asyncio.wait_for(self.get_yt_info(f"ytsearch:{input_str}"), timeout=TIMEOUT_SECONDS)
                    url, filename, is_yt = info['webpage_url'], info['title'], True
                    final_id = None
                except asyncio.TimeoutError:
                    return await interaction.followup.send(f"{CLOCK} タイムアウト: YouTube検索応答時間が超過しました。")
                except Exception as e:
                    logger.exception("YouTube search failed")
                    return await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 検索に失敗しました。")))

        # 4. 検索キーワード指定
        elif input_str:
            await interaction.followup.send(f"{LOUPE} YouTubeで「{input_str}」を検索中...")
            try:
                info = await asyncio.wait_for(self.get_yt_info(f"ytsearch:{input_str}"), timeout=TIMEOUT_SECONDS)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send(f"{CLOCK} タイムアウト: YouTube検索応答時間が超過しました。")
            except Exception as e:
                logger.exception("YouTube search failed")
                return await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 検索に失敗しました。")))

        # 5. 引数が何もない場合
        else:
            msg = "ファイル添付、ID、YouTube URL、SoundCloud URL、または検索キーワードを指定してください。"
            return await interaction.followup.send(view=as_embed_v2(we(msg)))

        if not url:
            msg = "情報の取得に失敗しました。"
            return await interaction.followup.send(view=as_embed_v2(we(msg)))

        # キューに追加（ギルド単位の上限を超える場合は受け付けない）
        if start_at is not None:
            state['elapsed_offset'] = start_at
        if not await self.enqueue_track(interaction.guild_id, (url, filename, final_id, is_yt),
                                       requester_id=interaction.user.id):
            return await interaction.followup.send(
                view=as_embed_v2(we(f"{FAILED} キューの上限（{MAX_QUEUE_SIZE}件）に達しています。再生完了または停止後に追加してください。")),
                ephemeral=True,
            )

        # 再生状態の安全確認
        vc = interaction.guild.voice_client
        is_playing = has_audio_source(vc, "music") if vc else False
        is_processing = state.get('is_processing_queue', False)
        is_paused = state.get('is_paused', False)

        # 💡 再生処理呼び出しとレスポンスの明確化
        try:
            if not is_playing and not is_processing and not is_paused:
                await interaction.followup.send(view=as_embed_v2(we(f"▶️ 再生を開始します: **{filename}**")))
                await self.check_queue(interaction.guild_id)
            else:
                await interaction.followup.send(view=as_embed_v2(we(f"{SUCCESS} **{filename}** をキューに追加しました")))
                await self.update_panel(interaction.guild_id)
        except Exception as e:
            logger.exception("Playback start failed")
            await interaction.followup.send(view=as_embed_v2(we(f"{FAILED} 再生開始処理でエラーが発生しました: `{e}`")))


    async def _stop_impl(self, r: Responder):
        """今流れている音楽をすべて停止しキューをクリアする（VC には残る）。"""
        vc = r.voice_client
        if not vc:
            return await r.send(view=as_embed_v2(we("ボットがボイスチャンネルに入っていません。")), ephemeral=True)
        if not is_same_voice_channel(r.user, vc):
            return await r.send(view=as_embed_v2(we(MUSIC_VC_REQUIRED_MESSAGE)), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['current_track'] = None
        state['elapsed_offset'] = 0
        state['is_paused'] = False
        # 停止は人の意思なので、自動再生が即座に再開しないよう抑止する
        # （次の手動リクエストか自動再生の入れ直しで解除される）。
        state['autoplay_stopped'] = True
        while not state['queue'].empty():
            state['queue'].get_nowait()
        state['queue_requesters'] = []
        remove_audio_source(vc, "music", notify=True)
        await r.send(view=as_embed_v2(we("完全に停止し、キューをクリアしました。")))
        await self.update_panel(r.guild.id)
        self._save_music_snapshot(r.guild.id)


    async def _seek_impl(self, interaction: discord.Interaction, seconds: float):
        if seconds < 0:
            return await interaction.response.send_message(view=as_embed_v2(we("移動先は0秒以上で指定してください。")), ephemeral=True)
        state = self.get_state(interaction.guild_id)
        vc = interaction.guild.voice_client
        if vc and not is_same_voice_channel(interaction.user, vc):
            return await interaction.response.send_message(view=as_embed_v2(we(MUSIC_VC_REQUIRED_MESSAGE)), ephemeral=True)
        if not vc or not state.get('current_track'):
            return await interaction.response.send_message(view=as_embed_v2(we("現在再生中の曲がありません。")), ephemeral=True)
        duration = state['current_track'][2] or 0
        if duration and seconds >= duration:
            return await interaction.response.send_message(view=as_embed_v2(we(f"移動先は曲の長さ（{int(duration)}秒）未満にしてください。")), ephemeral=True)
        state['elapsed_offset'] = seconds
        state['is_changing_setting'] = True
        remove_audio_source(vc, "music", notify=True)
        for _ in range(40):
            if not has_audio_source(vc, "music") and not state.get('is_paused'):
                break
            await asyncio.sleep(0.05)
        state['is_changing_setting'] = False
        await self.check_queue(interaction.guild_id)
        await interaction.response.send_message(view=as_embed_v2(we(f"再生位置を `{int(seconds)}秒` に移動しました。")))


    async def _pause_impl(self, interaction: discord.Interaction):
        vc = interaction.guild.voice_client
        state = self.get_state(interaction.guild_id)

        if not vc:
            return await interaction.response.send_message(view=as_embed_v2(we("ボットがボイスチャンネルに入っていません。")), ephemeral=True)
        if not is_same_voice_channel(interaction.user, vc):
            return await interaction.response.send_message(view=as_embed_v2(we(MUSIC_VC_REQUIRED_MESSAGE)), ephemeral=True)

        # 1. 再生中の場合 -> 一時停止処理
        if has_audio_source(vc, "music"):
            actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
            state['elapsed_offset'] += actual_played
            state['is_paused'] = True
            remove_audio_source(vc, "music", notify=True)
            
            await interaction.response.send_message(
                view=as_embed_v2(we(f"{PAUSE} 再生を一時停止しました。(`{int(state['elapsed_offset'])}秒` 時点)\nもう一度 `/vc` の音楽操作パネルから再開できます。"))
            )
            await self.update_panel(interaction.guild_id)
            self._save_music_snapshot(interaction.guild_id)

        # 2. 一時停止中の場合 -> 再生再開処理
        elif state['is_paused'] and state['current_track']:
            state['is_paused'] = False
            await self.check_queue(interaction.guild_id)
            await interaction.response.send_message(view=as_embed_v2(we("▶️ 一時停止位置から再生を再開しました。")))

        # 3. どちらでもない場合
        else:
            await interaction.response.send_message(view=as_embed_v2(we("現在再生中・一時停止中のトラックがありません。")), ephemeral=True)


    async def _skip_impl(self, interaction: discord.Interaction):
        vc = interaction.guild.voice_client
        state = self.get_state(interaction.guild_id)

        if vc and not is_same_voice_channel(interaction.user, vc):
            return await interaction.response.send_message(view=as_embed_v2(we(MUSIC_VC_REQUIRED_MESSAGE)), ephemeral=True)
        if vc and (has_audio_source(vc, "music") or state['is_paused']):
            self._note_track_finished(interaction.guild_id, completed=False)
            state['current_track'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(view=as_embed_v2(we("スキップしました。")))
        else:
            await interaction.response.send_message(view=as_embed_v2(we("現在再生中の楽曲がありません。")))


    async def _loop_impl(self, interaction: discord.Interaction, mode: str):
        state = self.get_state(interaction.guild_id)
        state['loop_mode'] = mode
        labels = {'off': 'OFF', 'track': '1曲ループ', 'queue': 'キューループ'}
        await interaction.response.send_message(view=as_embed_v2(we(f"ループ設定を **{labels[mode]}** に変更しました。")))
        await self.update_panel(interaction.guild_id)
        self._save_music_snapshot(interaction.guild_id)


    async def _shuffle_impl(self, interaction: discord.Interaction):
        state = self.get_state(interaction.guild_id)
        state['shuffle_enabled'] = not state.get('shuffle_enabled', False)
        label = 'ON' if state['shuffle_enabled'] else 'OFF'
        await interaction.response.send_message(view=as_embed_v2(we(f"シャッフル再生を **{label}** に変更しました。")))
        await self.update_panel(interaction.guild_id)
        self._save_music_snapshot(interaction.guild_id)


    async def _files_impl(self, r: Responder, limit: int = 20):
        """このチャンネルにアップロードされた音声の ID を表示する。"""
        limit = max(1, min(int(limit or 20), 100))
        await r.defer()
        embed = we(title="チャンネル内音声リスト")
        lines = []
        async for msg in r.channel.history(limit=limit):
            if msg.attachments:
                b62 = encode_full_id(r.guild.id, r.channel.id, msg.id)
                lines.append(f"`{b62}` : **{msg.attachments[0].filename}**")
        desc = "このサーバー内で再生可能な音声ID（`/vc` の音楽操作パネルから再生できます）\n" + "─" * 20 + "\n"
        desc += "\n".join(lines) if lines else "音声ファイルは見つかりませんでした。"
        embed.description = desc[:4000]
        await r.send(view=as_embed_v2(embed))
