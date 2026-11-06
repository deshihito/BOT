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
from core.emojis import BOOK, FAILED, GEAR, LOUPE, MUSIC, PAUSE, RESET, RESTART, SHUFFLE, SKIP_RIGHT, SUCCESS, THU, VOL
from core.music_activity import build_music_activity_snapshot

from core.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")


# =====================
# UI Panel Component
# =====================
# ==========================================
# <:thu:1563559478220038175> 動的にコンポーネントが組み替わる統合パネルView
# ==========================================
# =====================
# Search & Custom EQ Modals
# =====================
class SearchModal(discord.ui.Modal, title="YouTube 楽曲検索"):
    """パネルから直接呼び出せるキーワード検索用モーダル窓"""
    keyword_input = discord.ui.TextInput(
        label="検索キーワードまたはURL",
        placeholder="例: 米津玄師 地球儀 / https://...",
        required=True,
        max_length=200,
        style=discord.TextStyle.short
    )

    def __init__(self, cog, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer()
        keyword = self.keyword_input.value.strip()
        state = self.cog.get_state(self.guild_id)
        
        try:
            is_yt = False
            url, filename = None, None

            if self.cog._spotify_playlist_id(keyword):
                await self.cog.start_spotify_playlist_load(interaction, keyword)
                return

            if soundcloud_url_kind(keyword) == "set":
                await self.cog.start_soundcloud_playlist_load(interaction, keyword)
                return

            if soundcloud_url_kind(keyword) == "track":
                info = await self.cog.get_yt_info(keyword)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            elif niconico_url_kind(keyword) == "track":
                info = await self.cog.get_yt_info(keyword)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            elif "youtube.com" in keyword or "youtu.be" in keyword:
                info = await self.cog.get_yt_info(keyword)
                url, filename, is_yt = keyword, info['title'], True
            else:
                info = await self.cog.get_yt_info(f"ytsearch:{keyword}")
                # キューには再取得可能な動画ページURLを保存する。
                # 一時的なvideoplayback URLを保存すると、再解析時に403となる。
                url, filename, is_yt = info['webpage_url'], info['title'], True

            state['current_ctx'] = interaction
            if not await self.cog.enqueue_track(self.guild_id, (url, filename, None, is_yt)):
                await interaction.followup.send(
                    embed=we(f"{FAILED} キューの上限（{MAX_QUEUE_SIZE}件）に達しています。"),
                    ephemeral=True,
                )
                return
            await interaction.followup.send(embed=we(f"{SUCCESS} **{filename}** をキューに追加しました！"))

            # バグ修正: interaction.guild から voice_client を取得するように修正
            vc = interaction.guild.voice_client if interaction.guild else None
            if vc and not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                await self.cog.check_queue(self.guild_id)
            else:
                await self.cog.update_panel(self.guild_id)

        except Exception as e:
            logger.exception("Music search failed")
            await interaction.followup.send(embed=we(f"{FAILED} 検索中にエラーが発生しました: {e}"), ephemeral=True)


class CustomEQModal(discord.ui.Modal, title="カスタムEQ (FFmpegフィルター入力)"):
    """パネルから呼び出される、FFmpegオーディオフィルターの直接入力用モーダル窓"""
    filter_input = discord.ui.TextInput(
        label="FFmpegオーディオフィルター文字列",
        placeholder="例: vibrato=f=4,tremolo=f=5 (空欄でフラットに戻す)",
        required=False,
        max_length=400,
        style=discord.TextStyle.paragraph
    )

    def __init__(self, cog, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id

    async def on_submit(self, interaction: discord.Interaction):
        state = self.cog.get_state(self.guild_id)
        user_filter = self.filter_input.value.strip()

        if not user_filter:
            state['eq'] = "flat"
            state['custom_eq_filter'] = None
            await interaction.response.send_message(embed=we(GEAR + ' カスタムEQを解除しました（Flatに戻します）。'))
        else:
            if not is_safe_custom_audio_filter(user_filter):
                await interaction.response.send_message(
                    embed=we(FAILED + ' 使用できないフィルターです。equalizer、bass、treble、volume、vibrato、tremoloなどの音声フィルターだけをカンマ区切りで指定してください。'),
                    ephemeral=True,
                )
                return
            state['eq'] = "custom"
            state['custom_eq_filter'] = user_filter
            await interaction.response.send_message(embed=we(f"{GEAR} カスタムEQを設定しました:\n`{user_filter}`\n即時反映します。"))

        ctx = state['current_ctx'] or interaction
        await self.cog.apply_immediate_setting(ctx)
        await self.cog.update_panel(self.guild_id)


# =====================
# UI Panel Component
# =====================
class VoiceControlView(discord.ui.View):
    """音量・倍速・EQ・再生コントロールをまとめた常時同期型インタラクティブメニューUI"""
    def __init__(self, cog, guild_id: int):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.guild_id = guild_id
        
        self.add_item(self.SpeedSelect(cog, guild_id))
        self.add_item(self.VolumeSelect(cog, guild_id))
        self.add_item(self.EQSelect(cog, guild_id))

    class SpeedSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="0.5x (遅め)", value="0.5"),
                discord.SelectOption(label="0.8x", value="0.8"),
                discord.SelectOption(label="1.0x (標準)", value="1.0"),
                discord.SelectOption(label="1.2x", value="1.2"),
                discord.SelectOption(label="1.5x", value="1.5"),
                discord.SelectOption(label="2.0x", value="2.0"),
                discord.SelectOption(label="4.0x", value="4.0"),
                discord.SelectOption(label="8.0x", value="8.0"),
                discord.SelectOption(label="16.0x", value="16.0"),
                discord.SelectOption(label="32.0x", value="32.0"),
                discord.SelectOption(label="64.0x", value="64.0"),
            ]
            super().__init__(placeholder=f"⚡ 速度変更 (現在: {state['speed']}x)", min_values=1, max_values=1, options=options, row=0)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            previous_speed = state.get('speed', 1.0)
            state['speed'] = float(self.values[0])
            await interaction.response.send_message(embed=we(f"{THU} 再生速度を `{state['speed']}` 倍に設定しました（現在位置から即時反映）。"))
            # ★ 古い current_ctx ではなく、いま操作した interaction を渡す
            await self.cog.apply_immediate_setting(interaction, elapsed_speed=previous_speed)

    class VolumeSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="10%", value="0.1"),
                discord.SelectOption(label="50%", value="0.5"),
                discord.SelectOption(label="80%", value="0.8"),
                discord.SelectOption(label="100% (標準)", value="1.0"),
                discord.SelectOption(label="150%", value="1.5"),
                discord.SelectOption(label="200% (最大)", value="2.0"),
            ]
            super().__init__(placeholder=f"{VOL} 音量変更 (現在: {int(state['volume']*100)}%)", min_values=1, max_values=1, options=options, row=1)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            state['volume'] = float(self.values[0])
            await interaction.response.send_message(embed=we(f"{VOL} 音量を `{int(state['volume']*100)}%` に設定しました（即時反映）。"))
            # ★ 古い current_ctx ではなく、いま操作した interaction を渡す
            await self.cog.apply_immediate_setting(interaction)

    class EQSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="Flat (標準)", value="flat"),
                discord.SelectOption(label="Spatial (3D立体音響)", value="spatial"), # 追加
                discord.SelectOption(label="Bass (低音強調)", value="bass"),
                discord.SelectOption(label="SuperBass (超重低音)", value="superbass"),
                discord.SelectOption(label="Vocal (ボーカル強調)", value="vocal"),
                discord.SelectOption(label="Echo (エコー)", value="echo"),
                discord.SelectOption(label="Hall (ホール感)", value="hall"),
                discord.SelectOption(label="Live (ライブ風)", value="live"),
                discord.SelectOption(label="Rotate (回転音響)", value="rotate"),
            ]
            current_eq = state['eq'] if state['eq'] != "custom" else "custom (自由指定)"
            super().__init__(placeholder=f"🎬 プリセットEQ選択 (現在: {current_eq})", min_values=1, max_values=1, options=options, row=2)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            state['eq'] = self.values[0]
            state['custom_eq_filter'] = None
            await interaction.response.send_message(embed=we(f"🎬 エフェクトを `{state['eq']}` に変更しました（即時反映）。"))
            # ★ current_ctx ではなく interaction を渡す。これが「次の曲に飛ぶ」バグの修正点。
            await self.cog.apply_immediate_setting(interaction)

    @discord.ui.button(label=LOUPE, style=discord.ButtonStyle.success, row=3)
    async def search_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        modal = SearchModal(self.cog, self.guild_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="", emoji=GEAR, style=discord.ButtonStyle.secondary, row=3)
    async def custom_eq_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        modal = CustomEQModal(self.cog, self.guild_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="", emoji=PAUSE, style=discord.ButtonStyle.primary, row=3)
    async def pause_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and has_audio_source(vc, "music"):
            actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
            state['elapsed_offset'] += actual_played
            state['is_paused'] = True
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we(f"{PAUSE} 再生を一時停止しました。(`{int(state['elapsed_offset'])}秒` 時点)"))
            await self.cog.update_panel(self.guild_id)
            self.cog._save_music_snapshot(self.guild_id)
        else:
            await interaction.response.send_message(embed=we(FAILED + ' 現在再生中ではないか、既に一時停止されています。'), ephemeral=True)

    @discord.ui.button(label="再開", emoji=MUSIC, style=discord.ButtonStyle.success, row=4)
    async def resume_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and state['is_paused'] and state['current_track']:
            state['is_paused'] = False
            await interaction.response.send_message(embed=we("▶️ 再生を再開します。"))
            await self.cog.check_queue(self.guild_id)
            self.cog._save_music_snapshot(self.guild_id)
        else:
            await interaction.response.send_message(embed=we(FAILED + ' 再開できる一時停止中のトラックがありません。'), ephemeral=True)

    @discord.ui.button(label="", emoji=SKIP_RIGHT, style=discord.ButtonStyle.secondary, row=4)
    async def skip_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and (has_audio_source(vc, "music") or state['is_paused']):
            state['current_track'] = None
            state['current_thumbnail_url'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we(SKIP_RIGHT + ' トラックをスキップしました。'))
        else:
            await interaction.response.send_message(embed=we(FAILED + ' 現在再生中の楽曲がありません。'), ephemeral=True)

    @discord.ui.button(label="", emoji=SHUFFLE, style=discord.ButtonStyle.secondary, row=3)
    async def shuffle_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        state['shuffle_enabled'] = not state.get('shuffle_enabled', False)
        label = 'ON' if state['shuffle_enabled'] else 'OFF'
        await interaction.response.send_message(embed=we(f"{SHUFFLE} シャッフルを `{label}` に設定しました。"))
        await self.cog.update_panel(self.guild_id)
        self.cog._save_music_snapshot(self.guild_id)

    @discord.ui.button(label="", emoji=RESTART, style=discord.ButtonStyle.secondary, row=3)
    async def loop_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        next_mode = {'off': 'track', 'track': 'queue', 'queue': 'off'}[state.get('loop_mode', 'off')]
        state['loop_mode'] = next_mode
        labels = {'off': 'OFF', 'track': '1曲', 'queue': 'キュー'}
        await interaction.response.send_message(embed=we(f"{RESTART} ループを `{labels[next_mode]}` に設定しました。"))
        await self.cog.update_panel(self.guild_id)
        self.cog._save_music_snapshot(self.guild_id)

    @discord.ui.button(label="📋", style=discord.ButtonStyle.secondary, row=4)
    async def queue_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=self.cog.build_queue_embed(self.guild_id))

    @discord.ui.button(label=BOOK, style=discord.ButtonStyle.secondary, row=4)
    async def library_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(
            title=f"{BOOK} ライブラリ",
            description="プレイリストを保存・一覧表示・再生できます。対象範囲を選択してください。",
            color=0x9B59B6,
        )
        await interaction.response.send_message(
            embed=embed,
            view=PlaylistLibraryView(self.cog),
            ephemeral=True,
        )

    @discord.ui.button(label="", emoji=RESET, style=discord.ButtonStyle.danger, row=4)
    async def stop_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc:
            state['current_track'] = None
            state['current_thumbnail_url'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            while not state['queue'].empty():
                state['queue'].get_nowait()
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we(RESET + ' 再生を完全に停止し、キューをクリアしました。'))
            await self.cog.update_panel(self.guild_id)
            self.cog._save_music_snapshot(self.guild_id)
        else:
            await interaction.response.send_message(embed=we(FAILED + ' ボイスチャンネルに接続していません。'), ephemeral=True)


def build_music_panel_layout(cog, guild_id: int, panel_text: str,
                             thumbnail_url: str | None = None) -> discord.ui.LayoutView:
    """操作部品とステータスをComponents V2コンテナにまとめる。

    再生中トラックのサムネイルURLがある場合は、ステータスを
    Section＋Thumbnail のネイティブ V2 構成にし、Separator で
    操作部品と区切る。無い場合は従来の TextDisplay 構成のまま。
    """
    controls = VoiceControlView(cog, guild_id)
    rows: dict[int, list[discord.ui.Item]] = {}
    for item in controls.children:
        row = getattr(item, "row", None)
        if row is None:
            row = 0 if isinstance(item, discord.ui.Select) else 3
        rows.setdefault(row, []).append(item)
    action_rows = [discord.ui.ActionRow(*items) for _, items in sorted(rows.items())]
    if thumbnail_url and thumbnail_url.startswith(("http://", "https://")):
        header: list[discord.ui.Item] = [
            discord.ui.Section(
                discord.ui.TextDisplay(panel_text[:4000]),
                accessory=discord.ui.Thumbnail(thumbnail_url),
            ),
            discord.ui.Separator(),
        ]
    else:
        header = [discord.ui.TextDisplay(panel_text[:4000])]
    container = discord.ui.Container(
        *header,
        *action_rows,
        accent_colour=0xFFFFFF,
    )
    layout = discord.ui.LayoutView(timeout=PANEL_TIMEOUT_SECONDS)
    layout.add_item(container)
    return layout


class PlaylistNameModal(discord.ui.Modal, title="プレイリスト名"):
    name = discord.ui.TextInput(label="プレイリスト名", placeholder="保存名または再生名", max_length=100)

    def __init__(self, cog, action: str, scope: str):
        super().__init__()
        self.cog = cog
        self.action = action
        self.scope = scope

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog._playlist_impl(
            Responder(interaction), self.action, self.name.value.strip(), self.scope
        )


class PlaylistLibraryView(discord.ui.View):
    """ライブラリボタンからプレイリスト操作を実行するUI。"""

    def __init__(self, cog):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.scope = "me"
        self.add_item(self.ScopeSelect(self))

    class ScopeSelect(discord.ui.Select):
        def __init__(self, view):
            self.library_view = view
            super().__init__(
                placeholder="📁 保存先・参照先を選択",
                options=[
                    discord.SelectOption(label="個人", value="me", emoji="👤", default=True),
                    discord.SelectOption(label="サーバー共有", value="server", emoji="🌐"),
                ],
            )

        async def callback(self, interaction: discord.Interaction):
            self.library_view.scope = self.values[0]
            await interaction.response.send_message(
                f"対象を **{'個人' if self.values[0] == 'me' else 'サーバー共有'}** に変更しました。",
                ephemeral=True,
            )

    @discord.ui.button(label="💾", style=discord.ButtonStyle.success)
    async def save_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "save", self.scope))

    @discord.ui.button(label="📋", style=discord.ButtonStyle.secondary)
    async def list_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._playlist_impl(Responder(interaction), "list", scope=self.scope)

    @discord.ui.button(label="再生", emoji=MUSIC, style=discord.ButtonStyle.primary)
    async def play_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "play", self.scope))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger)
    async def delete_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "delete", self.scope))
