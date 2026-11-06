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
from core.voice import voice_restore
from core.voice.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import CROCK, FAILED, GEAR, MUSIC, PAUSE, RESET, SUCCESS, THU, VOL
from core.voice.music_activity import build_music_activity_snapshot

from core.voice.music.common import *  # noqa: F401,F403 - shared helpers/constants
from core.voice.music.spatial import SpatialControlView  # noqa: F401
from core.voice.music.ui import build_music_panel_layout  # noqa: F401

logger = logging.getLogger("cogs.sio_music")


class PanelMixin:
    async def update_panel(self, guild_id: int):
        """現在の内部ステータスを読み取り、コントロールパネルをリアルタイム更新する"""
        state = self.get_state(guild_id)
        msg = state['panel_message']
        if not msg: return

        if state['is_paused']: status_icon = PAUSE + ' 一時停止中'
        elif state['current_track']: status_icon = "▶️ 再生中"
        else: status_icon = RESET + ' 停止中'

        if state['current_track']:
            _, filename, duration, _, _ = state['current_track']
            m, s = divmod(int(duration), 60)
            duration_str = f"{m}:{s:02d}" if duration else "不明"
            elapsed = state.get('elapsed_offset', 0.0)
            if not state.get('is_paused'):
                elapsed += max(0.0, time.time() - state.get('start_time', time.time())) * state.get('speed', 1.0)
            elapsed = min(elapsed, duration) if duration else elapsed
            elapsed_m, elapsed_s = divmod(int(elapsed), 60)
            if duration:
                ratio = min(1.0, elapsed / duration)
                filled = round(ratio * 16)
                progress_bar = '█' * filled + '░' * (16 - filled)
                progress_info = f"`{elapsed_m}:{elapsed_s:02d}` {progress_bar} `{duration_str}`"
            else:
                progress_info = f"`{elapsed_m}:{elapsed_s:02d}` 再生位置を取得中"
            track_info = f"**{filename}** `[{duration_str}]`"
        else:
            track_info = "*楽曲が再生されていません*"
            progress_info = "*進捗は再生開始後に表示されます*"

        queue_size = state['queue'].qsize()
        queue_info = f"`{queue_size} 件` の楽曲が待機中" if queue_size > 0 else "待機中の楽曲はありません"

        current_eq = state['eq']
        eq_label = f"Custom (`{state['custom_eq_filter']}`)" if current_eq == "custom" else current_eq.capitalize()

        panel_text = (
            "# {MUSIC} ボイスコントロールパネル\n"
            f"**状態:** {status_icon}\n"
            f"**オーディオ:** {VOL} `{int(state['volume']*100)}%`　{THU} `{state['speed']}x`　🎬 `{eq_label}`\n"
            f"**再生中:** {track_info}\n"
            f"**進捗:** {progress_info}\n"
        )
        loop_label = {'off': 'OFF', 'track': '1曲', 'queue': 'キュー'}.get(state.get('loop_mode'), 'OFF')
        shuffle_label = 'ON' if state.get('shuffle_enabled') else 'OFF'
        panel_text += (
            f"**再生モード:** ループ `{loop_label}` / シャッフル `{shuffle_label}`\n"
            f"**予約キュー:** {queue_info}\n\n"
            "速度・音量・EQの選択と再生操作は、このパネル内の各コントロールから行えます。"
        )

        try:
            await edit_message_v2(msg, build_music_panel_layout(
                self, guild_id, panel_text,
                thumbnail_url=state.get('current_thumbnail_url')))
        except Exception as e:
            logging.error(f"Panel update failed: {e}")


    async def apply_immediate_setting(self, ctx_or_interaction, elapsed_speed: float | None = None):
        guild = getattr(ctx_or_interaction, 'guild', None)
        if not guild:
            return

        vc = guild.voice_client
        state = self.get_state(guild.id)

        if vc and has_audio_source(vc, "music") and state['current_track']:
            playback_speed = elapsed_speed if elapsed_speed is not None else state.get('speed', 1.0)
            actual_played = (time.time() - state['start_time']) * playback_speed
            state['elapsed_offset'] += actual_played

            # ★ 先にフラグを立てる。remove_audio_source の after コールバック
            #   (play_next) が current_track を破棄しないようにする。
            state['is_changing_setting'] = True
            remove_audio_source(vc, "music", notify=True)

            # afterコールバックが状態を解放する前に再生を開始すると、
            # VoiceClient.play() が "Already playing audio" を送出する。
            for _ in range(40):
                if not has_audio_source(vc, "music"):
                    break
                await asyncio.sleep(0.05)
            else:
                logging.error("設定変更後の音声停止がタイムアウトしました。")
                state['is_changing_setting'] = False
                return

            # ★ current_track と elapsed_offset は保持したまま check_queue で再開。
            #   play_next は is_changing_setting 中なので return している。
            state['is_changing_setting'] = False
            state['is_processing_queue'] = False
            await self.check_queue(guild.id)
            self._save_music_snapshot(guild.id)
        else:
            await self.update_panel(guild.id)
            self._save_music_snapshot(guild.id)


    async def _eq_impl(self, interaction: discord.Interaction, mode: str = "flat"):
        state = self.get_state(interaction.guild_id)
        
        if mode in EQ_SETTINGS:
            state['eq'] = mode
            state['custom_eq_filter'] = None
            msg = f"🎬 エフェクトをプリセット `{mode}` に変更しました。"
        else:
            state['eq'] = "custom"
            state['custom_eq_filter'] = mode
            msg = f"{GEAR} カスタムEQフィルターを設定しました:\n`{mode}`"

        await interaction.response.send_message(embed=we(msg))
        # 曲を止めずにパネルだけ更新
        await self.update_panel(interaction.guild_id)


    @staticmethod
    def _eq_choices(current: str) -> list[app_commands.Choice[str]]:
        """EQ_SETTINGS の全プリセットを候補にし、入力途中の文字で絞り込む（最大25件）。"""
        choices = [
            app_commands.Choice(name=f"プリセット: {key}", value=key)
            for key in EQ_SETTINGS.keys()
        ]
        return [
            choice for choice in choices 
            if current.lower() in choice.name.lower() or current.lower() in choice.value.lower()
        ][:25]


    async def _volume_impl(self, r: Responder, value: float):
        if not 0.1 <= value <= 2.0:
            return await r.send(embed=we("音量は 0.1 から 2.0 の間で指定してください。"), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['volume'] = value
        await r.send(embed=we(f"{VOL} 音量を `{value}` に設定しました。"))
        await self.apply_immediate_setting(r.source)


    async def _speed_impl(self, r: Responder, value: float):
        if not MIN_PLAYBACK_SPEED <= value <= MAX_PLAYBACK_SPEED:
            return await r.send(embed=we(f"速度は {MIN_PLAYBACK_SPEED} から {MAX_PLAYBACK_SPEED:g} の間で指定してください。"), ephemeral=True)
        state = self.get_state(r.guild.id)
        previous_speed = state.get('speed', 1.0)
        state['speed'] = value
        await r.send(embed=we(f"{THU} 再生速度を `{value}` 倍に設定しました（現在位置から反映）。"))
        await self.apply_immediate_setting(r.source, elapsed_speed=previous_speed)


    async def _spatial_impl(self, r: Responder, *, feedback: float | None = None, wet: float | None = None,
                            resolution: int | None = None):
        """オプションなしなら立体音響パネルを出し、指定があればリバーブの値を変える。"""
        guild_id = r.guild.id
        if feedback is None and wet is None and resolution is None:
            return await self._spatial_panel(r, guild_id)
        if feedback is not None and not 0.0 <= feedback <= 0.95:
            return await r.send(embed=we("フィードバック値（残響の長さ）は 0.0 〜 0.95 の間で指定してください。"), ephemeral=True)
        if wet is not None and not 0.0 <= wet <= 1.0:
            return await r.send(embed=we("ウェット量（残響の音量）は 0.0 〜 1.0 の間で指定してください。"), ephemeral=True)
        if resolution is not None and resolution not in (4, 8):
            return await r.send(embed=we("解像度は `4` (通常) または `8` (高解像度・滑らか) のどちらかを指定してください。"), ephemeral=True)

        state = self.get_state(guild_id)
        lines = []
        if feedback is not None:
            state['fdn_feedback'] = feedback
            lines.append(f"{CROCK} リバーブのフィードバック（長さ）を `{feedback}` に設定しました。")
        if wet is not None:
            state['fdn_wet'] = wet
            lines.append(f"💧 残響のミックス（ウェット量）を `{wet}` に設定しました。")
        if resolution is not None:
            state['fdn_resolution'] = resolution
            mode_str = "8次元ハウスホルダー（高密度・シルキー）" if resolution == 8 else "4次元ハウスホルダー（軽量・クリア）"
            lines.append(f"{GEAR} リバーブ解像度を `{resolution}` に切り替えました。\n現在のモード: **{mode_str}**")
        await r.send(embed=we("\n".join(lines)))
        # コントロールパネルの表示を更新
        await self.update_panel(guild_id)


    async def _spatial_panel(self, r: Responder, guild_id: int):
        state = self.get_state(guild_id)
        current_eq = state.get('eq', 'flat')
        dist = state.get('spatial_distance', 2.0)
        room = state.get('spatial_room_size', 0.3)
        speaker = state.get('spatial_speaker', 'studio')
        agc_max = state.get('spatial_agc_max', 4.0)
        
        # 💡 モード判定（3軸回転 / 通常回転 / 回転OFF）
        rot_mode = state.get('spatial_rot_mode', 'standard')  # 'off', 'standard', '3d'
        rot_labels = {
            'off': PAUSE + ' 静止 (OFF)',
            'standard': '🌀 通常水平回転 (Azimuth)',
            '3d': '🪐 3軸立体回転 (3D Pitch/Yaw/Roll)'
        }

        speaker_names = {
            'studio': '🎙️ スタジオモニター',
            'theater': '🎬 シアター',
            'pa': VOL + ' PAスピーカー',
            'small': '📻 小型スピーカー'
        }

        embed = discord.Embed(
            title="🎧 立体音響 (3D Spatial Audio) 設定パネル",
            description=(
                "リアルタイムHRTFおよびFDN空間音響パラメータを個別設定できます。\n"
                "下のメニュー操作は再生中の音声へ即座に反映されます。\n\n"
                f"現在のモード: **{current_eq}**\n"
                f"音像の距離 (Distance): **{dist}x**\n"
                f"部屋のリバーブ (FDN Mix): **{room}**\n"
                f"スピーカー特性: **{speaker_names.get(speaker, speaker)}**\n"
                f"最大音量引き上げ幅 (AGC): **{agc_max}x** (+{round(20*math.log10(agc_max), 1)}dB)\n"
                f"回転モード: **{rot_labels.get(rot_mode, rot_mode)}**"
            ),
            color=0x3498DB
        )
        view = SpatialControlView(self, guild_id)
        await r.send(embed=embed, view=view)


    def build_queue_embed(self, guild_id: int):
        state = self.get_state(guild_id)
        current_track = state.get('current_track')
        queue_items = list(state['queue']._queue)
        embed = discord.Embed(title=MUSIC + ' 再生キュー', color=0xFFFFFF)
        embed.add_field(
            name="再生中",
            value=f"**{current_track[1]}**" if current_track else "なし",
            inline=False,
        )
        if queue_items:
            q_desc = "\n".join(f"{i + 1}. {item[1]}" for i, item in enumerate(queue_items[:10]))
            if len(queue_items) > 10:
                q_desc += f"\n…ほか {len(queue_items) - 10} 曲"
            embed.add_field(name="待機中", value=q_desc, inline=False)
        else:
            embed.add_field(name="待機中", value="キューは空です", inline=False)
        return embed


    async def _queue_impl(self, interaction: discord.Interaction):
        await interaction.response.send_message(embed=self.build_queue_embed(interaction.guild_id))
