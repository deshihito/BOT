from __future__ import annotations
import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from core.support.emojis import FAILED, VOL
from core.general import action_usage
from core.support.usage_stats import usage_stats
from core.support.legacy import Responder
from core.vc.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.vc.voice_media import add_audio_source, remove_audio_source
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

from core.vc.common import *  # noqa: F401,F403 - shared constants
from core.vc.common import COGS, GVC_ROOM_ACTIONS, GVC_ROOM_FORMS, LAZY_EXTENSIONS, VOICE_ACTIONS_BY_GENRE, VOICE_GENRES, format_elapsed  # noqa: F401
from core.vc.trigger import VoiceTriggerManageView, VoiceTriggerRegisterView, _scan_recent_audios  # noqa: F401
from core.vc.tts import TTSSayModal, TTSSettingsModal  # noqa: F401

logger = logging.getLogger("cogs.sio_voice")


class VoiceHub(commands.Cog):
    VOICE_ACTIONS = [
        app_commands.Choice(name="VC参加", value="join"), app_commands.Choice(name="VC退出", value="leave"),
        app_commands.Choice(name="VC状態", value="status"),
        app_commands.Choice(name="音楽操作パネル", value="music_panel"),
        *[app_commands.Choice(name=f"録音: {label}", value=f"record_{value}") for label, value in
          (("開始", "start"), ("停止", "stop"), ("状態", "status"), ("音程解析", "pitch"))],
        *[app_commands.Choice(name=f"やまびこ: {label}", value=f"echo_{value}") for label, value in
          (("開始", "start"), ("停止", "stop"), ("遅延変更", "delay"))],
        app_commands.Choice(name="文字起こし: 開始", value="transcribe_start"),
        app_commands.Choice(name="文字起こし: 停止", value="transcribe_stop"),
        app_commands.Choice(name="カラオケ: 開始", value="karaoke_start"),
        app_commands.Choice(name="カラオケ: 停止", value="karaoke_stop"),
        app_commands.Choice(name="カラオケ: 採点", value="karaoke_score"),
        app_commands.Choice(name="ボイスチェンジャー: 開始", value="changer_start"),
        app_commands.Choice(name="ボイスチェンジャー: 停止", value="changer_stop"),
        app_commands.Choice(name="ボイスチェンジャー: 状態/設定", value="changer_status"),
        app_commands.Choice(name="ランダム通話: 開始/参加", value="match_start"),
        app_commands.Choice(name="ランダム通話: 終了/退出", value="match_stop"),
        app_commands.Choice(name="グローバルVC: 開始/参加", value="global_start"),
        app_commands.Choice(name="グローバルVC: 終了/退出", value="global_stop"),
    ]

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        # VC参加時の自動開始（/support の自動化設定）を新規セッションへ配線する。
        from core.vc import auto_start

        self.voice_sessions.fresh_session_hook = auto_start.on_fresh_session

    async def _cog(self, interaction: discord.Interaction, key: str):
        cog = self.bot.get_cog(COGS[key])
        if cog is None:
            cog = await self._try_load_cog(key)
        if cog is None:
            await Responder(interaction).send(f"{FAILED} この機能はいま読み込まれていません。", ephemeral=True)
        return cog

    async def _try_load_cog(self, key: str):
        """未ロードのCogを、同じパッケージの拡張として読み込み直す（失敗理由はログに残す）。"""
        module_name = LAZY_EXTENSIONS.get(key)
        if not module_name:
            return None
        extension = f"cogs.{module_name}"
        try:
            await self.bot.load_extension(extension)
        except commands.ExtensionAlreadyLoaded:
            logger.warning("%s は読み込み済みですが Cog %s が見つかりません", extension, COGS[key])
        except Exception:
            logger.exception("拡張 %s の読み込みに失敗しました（Cog: %s）", extension, COGS[key])
            return None
        else:
            logger.info("拡張 %s を遅延ロードしました", extension)
        return self.bot.get_cog(COGS[key])

    # ------------------------------------------------------------ 状態
    def status_embed(self, guild) -> discord.Embed:
        session = self.voice_sessions.get(guild.id)
        if session is not None:
            channel = guild.get_channel(session.channel_id) if session.channel_id else None
            channel_text = getattr(channel, "mention", None) or getattr(channel, "name", None) or "不明"
            embed = discord.Embed(title=VOL + ' ボイスチャンネルの使用状況', color=0x2ECC71)
            active = [session.feature, *session.shared_leases.keys()]
            embed.add_field(name="機能", value="、".join(feature_label(feature) for feature in active), inline=True)
            embed.add_field(name="開始した人", value=session.user_name, inline=True)
            embed.add_field(name="チャンネル", value=channel_text, inline=True)
            embed.add_field(name="経過時間", value=format_elapsed(time.time() - session.started_at), inline=True)
            hints = "\n".join(f"{feature_label(feature)}: `{stop_hint(feature)}`" for feature in active)
            embed.add_field(name="機能を個別に停止", value=hints, inline=False)
            embed.set_footer(text="音楽・GVC・読み上げ・文字起こしは同じVC接続を共有します。")
            return embed

        embed = discord.Embed(title="🔇 ボイスチャンネルの使用状況", color=0x95A5A6)
        voice_client = getattr(guild, "voice_client", None)
        if voice_client is not None:
            name = getattr(getattr(voice_client, "channel", None), "name", "不明")
            embed.description = f"Bot は **{name}** に接続していますが、使っている機能の記録がありません。`/vc` のパネルから退出できます。"
        else:
            embed.description = "いまはどの機能も使っていません。"
        saito = self.bot.get_cog(COGS["match"])
        if saito is not None and any(getattr(r.guild, "id", None) == guild.id for r in getattr(saito, "matching_queue", [])):
            embed.description += "\nランダム通話の相手を探しています（`/vc` のパネルから取り消し）。"
        return embed

    # ------------------------------------------------------------ 統合サブコマンド
    async def voice_connection(self, interaction: discord.Interaction, action: app_commands.Choice[str]):
        if action.value == "status":
            return await Responder(interaction).send(embed=self.status_embed(interaction.guild))
        cog = await self._cog(interaction, "music")
        if cog:
            if action.value == "join":
                await cog._join_impl(Responder(interaction))
            else:
                await cog._leave_impl(Responder(interaction))

    async def voice_studio(self, interaction: discord.Interaction, feature: app_commands.Choice[str],
                           action: app_commands.Choice[str],
                           delay: app_commands.Range[float, 0.1, 30.0] | None = None,
                           channel: discord.TextChannel | None = None, lyrics: str | None = None):
        key = feature.value
        valid = {
            "record": {"start", "stop", "status", "pitch"},
            "echo": {"start", "stop", "delay", "status"},
            "transcribe": {"start", "stop"},
            "karaoke": {"start", "stop", "score"},
        }
        if action.value not in valid[key]:
            return await interaction.response.send_message("この機能では選択した操作を利用できません。機能と操作の組み合わせを確認してください。", ephemeral=True)
        cog_key = "record" if key == "echo" else key
        cog = await self._cog(interaction, cog_key)
        if not cog:
            return
        responder = Responder(interaction)
        if key == "record":
            await cog._record_impl(responder, action.value)
        elif key == "echo":
            await cog._echo_impl(responder, action.value, delay)
        elif key == "transcribe":
            await cog._transcribe_impl(responder, action.value, channel)
        else:
            await cog._karaoke_impl(responder, action.value, lyrics)

    async def voice_effects(self, interaction: discord.Interaction, action: app_commands.Choice[str],
                            pitch: app_commands.Range[float, -24.0, 24.0] | None = None,
                            buffer_ms: app_commands.Range[float, 20.0, 2000.0] | None = None,
                            max_ms: app_commands.Range[float, 20.0, 4000.0] | None = None):
        cog = await self._cog(interaction, "changer")
        if cog:
            await cog._changer_impl(Responder(interaction), action.value, pitch=pitch, buffer_ms=buffer_ms, max_ms=max_ms)

    async def voice_community(self, interaction: discord.Interaction, network: app_commands.Choice[str],
                              action: app_commands.Choice[str], room: str | None = None,
                              password: str | None = None):
        if network.value == "match":
            cog = await self._cog(interaction, "match")
            mapped = "start" if action.value == "start" else "stop"
            if cog:
                await cog._match_impl(Responder(interaction), mapped)
        else:
            cog = await self._cog(interaction, "global")
            mapped = "join" if action.value == "start" else "leave"
            if cog:
                await cog._global_impl(Responder(interaction), mapped, room, password)

    async def voice_tts(self, interaction: discord.Interaction, operation: str):
        cog = await self._cog(interaction, "tts")
        if not cog:
            return
        if operation == "start":
            await cog._start_impl(Responder(interaction), None)
        elif operation == "stop":
            await cog._stop_impl(Responder(interaction))
        elif operation == "say":
            await interaction.response.send_modal(TTSSayModal(cog))
        else:
            await interaction.response.send_modal(TTSSettingsModal(cog, interaction.user.id))

    async def voice_trigger(self, interaction: discord.Interaction, operation: str):
        cog = self.bot.get_cog("VoiceTriggerCog")
        if cog is None:
            return await Responder(interaction).send(
                f"{FAILED} 音声トリガー機能がいま読み込まれていません。", ephemeral=True
            )

        # 権限チェック（support.py の設定と共通）
        reason = await self._trigger_denied_reason(interaction)
        if reason:
            return await Responder(interaction).send(reason, ephemeral=True)

        if operation == "panel":
            view = VoiceTriggerManageView(cog, interaction.guild_id)
            return await interaction.response.send_message(view=view, ephemeral=True)

        if operation == "register":
            if interaction.channel is None:
                return await Responder(interaction).send(
                    "チャンネル情報を取得できません。", ephemeral=True
                )
            await interaction.response.defer(ephemeral=True, thinking=True)
            audios = await _scan_recent_audios(self.bot, interaction.channel)
            view = VoiceTriggerRegisterView(cog, audios)
            return await interaction.followup.send(view=view, ephemeral=True)

        return await Responder(interaction).send("この操作は利用できません。", ephemeral=True)

    async def voice_global_rooms(self, interaction: discord.Interaction, value: str,
                                 form: dict | None = None):
        """グローバルVCルームの操作。入力が要る操作は form（モーダルの入力）を受け取って実行する。"""
        cog = await self._cog(interaction, "global")
        if cog is None:
            return
        r = Responder(interaction)
        if value == "gvc_room_list":
            return await interaction.response.send_message(
                view=cog.room_list_view(interaction.guild)
            )
        if value == "gvc_members":
            return await cog._members_impl(r)
        if value == "gvc_chat_disconnect":
            return await cog._chat_disconnect_impl(r)
        if form is None:
            return await r.send(f"{FAILED} この操作は `/vc` のパネルから入力してください。", ephemeral=True)

        name = form.get("name", "")
        if value == "gvc_room_create":
            try:
                max_servers = int(form.get("max") or 0)
            except ValueError:
                return await r.send(f"{FAILED} 最大参加サーバー数は数字で入力してください。", ephemeral=True)
            return await cog._room_create_impl(
                r, name, max_servers, form.get("password", ""), form.get("desc", ""),
                theme=form.get("theme", ""))
        if value == "gvc_room_theme":
            return await cog._room_theme_impl(r, name, form.get("theme", ""))
        if value == "gvc_lang_setting":
            return await cog._lang_setting_impl(r, form.get("lang", ""))
        if value == "gvc_room_info":
            return await cog._room_info_impl(r, name)
        if value == "gvc_room_delete":
            return await cog._room_delete_impl(r, name)
        if value == "gvc_chat_connect":
            return await cog._chat_connect_impl(r, name, form.get("password") or None)
        if value == "gvc_auto_connect":
            return await cog._text_chat_toggle_impl(r, name)
        return await r.send("この操作は利用できません。", ephemeral=True)

    @app_commands.command(name="vc", description="音楽・ボイス機能の操作パネルを表示します")
    async def vc(self, interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        history_specs = []
        if interaction.guild_id is not None:
            from core.support import guild_settings
            store = guild_settings.get_store()
            await store.ensure_loaded()
            history_specs = action_usage.history_panel_specs(
                store, interaction.guild_id, interaction.user.id, "vc")
        view = VoicePanelView(self, owner_id=interaction.user.id,
                              history_specs=history_specs)
        await interaction.followup.send(view=as_panel_v2(view))

    async def _trigger_denied_reason(self, interaction: discord.Interaction) -> str | None:
        """音声トリガーを操作できないときは理由を返す（support.py の権限設定と共通）。"""
        try:
            from cogs.support import get_voice_trigger_settings
            from core.support import guild_settings

            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_voice_trigger_settings(store, interaction.guild_id)
            if settings["permission"] == "admin":
                perms = getattr(interaction.user, "guild_permissions", None)
                if not getattr(perms, "administrator", False):
                    return "このサーバーでは管理者のみ操作できます。"
        except Exception:
            logger.exception("音声トリガー権限チェックに失敗しました")
        return None

    async def dispatch_voice_action(self, interaction: discord.Interaction, value: str,
                    delay: app_commands.Range[float, 0.1, 30.0] | None = None,
                    channel: discord.TextChannel | None = None, lyrics: str | None = None,
                    pitch: app_commands.Range[float, -24.0, 24.0] | None = None,
                    buffer_ms: app_commands.Range[float, 20.0, 2000.0] | None = None,
                    max_ms: app_commands.Range[float, 20.0, 4000.0] | None = None,
                    room: str | None = None, password: str | None = None,
                    name: str | None = None, max_servers: int | None = None,
                    desc: str | None = None, theme: str | None = None,
                    lang: str | None = None):
        # BOT fixer のコマンド制限（管理者は対象外）。
        from core.support import command_control

        if not await command_control.guard(interaction, f"vc:{value}"):
            return
        # 利用履歴（よく使う／最近）は入口ここで記録する（失敗しても壊さない）。
        # 保存の書き込みで応答を遅らせないようバックグラウンド記録を使う。
        action_usage.record_safely_in_background(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"vc:{value}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"vc:{value}")
        if value == "music_panel":
            cog = await self._cog(interaction, "music")
            if cog:
                await cog._panel_impl(Responder(interaction))
            return
        if value == "music_search":
            # 選択式検索（_search_impl / SearchView）はキーワードが要るため、
            # tts_say 等のフォーム系と同じくモーダルで聞いてから impl へ渡す。
            # 音楽パネル本体の検索ボタン（SearchModal）とは別経路。
            return await interaction.response.send_modal(MusicSearchModal(self))
        if value in {"music_playlist", "music_spatial", "music_autoplay",
                     "music_queue", "music_files"}:
            # 音楽パネル本体に同居する各機能への追加の入口（パネル本体は壊さない）。
            cog = await self._cog(interaction, "music")
            if cog:
                responder = Responder(interaction)
                if value == "music_playlist":
                    await cog._playlist_library_impl(responder)
                elif value == "music_spatial":
                    await cog._spatial_impl(responder)
                elif value == "music_autoplay":
                    await cog._autoplay_panel_impl(responder)
                elif value == "music_queue":
                    await cog._queue_impl(interaction)
                else:  # music_files
                    await cog._files_impl(responder)
            return
        if value in GVC_ROOM_ACTIONS:
            if value in GVC_ROOM_FORMS and name is not None:
                # /quick・ショートカット経由（導線最適化 M4）: ParamSpec で集めた
                # 入力を、パネルのモーダルと同じ form 形式に変換して実行する。
                form = {"name": name, "max": max_servers,
                        "password": password or "", "desc": desc or "",
                        "theme": theme or "", "lang": lang or ""}
                return await self.voice_global_rooms(interaction, value, form)
            return await self.voice_global_rooms(interaction, value)
        if value in {"join", "leave", "status"}:
            return await self.voice_connection(interaction, app_commands.Choice(name=value, value=value))
        if "_" not in value:
            return await Responder(interaction).send("この操作は利用できません。", ephemeral=True)
        key, operation = value.rsplit("_", 1)
        if key in {"record", "echo", "transcribe", "karaoke"}:
            return await self.voice_studio(
                interaction, app_commands.Choice(name=key, value=key),
                app_commands.Choice(name=operation, value=operation), delay, channel, lyrics)
        if key == "tts":
            return await self.voice_tts(interaction, operation)
        if key == "changer":
            return await self.voice_effects(
                interaction, app_commands.Choice(name=operation, value=operation), pitch, buffer_ms, max_ms)
        if key == "trigger":
            return await self.voice_trigger(interaction, operation)
        return await self.voice_community(
            interaction, app_commands.Choice(name=key, value=key),
            app_commands.Choice(name=operation, value=operation), room, password)


class VoiceGenreSelect(discord.ui.Select):
    def __init__(self, hub: VoiceHub, selected: str | None = None):
        self.hub = hub
        super().__init__(placeholder="ジャンルを選択してください", options=[
            discord.SelectOption(label=label, description=f"{len(VOICE_ACTIONS_BY_GENRE[value])}個の機能",
                                 value=value, default=value == selected)
            for value, (label, _description) in VOICE_GENRES.items()
        ], custom_id="panel:vc:genre", row=0)

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        view: VoicePanelView = getattr(container, "panel", container)
        view.genre = self.values[0]
        view.action = None
        view.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(view))


class VoiceActionSelect(discord.ui.Select):
    def __init__(self, hub: VoiceHub, genre: str):
        self.hub = hub
        super().__init__(placeholder="機能を選択してください", options=[
            discord.SelectOption(label=label, value=value)
            for label, value in VOICE_ACTIONS_BY_GENRE[genre]
        ], custom_id="panel:vc:action", row=1)

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]
        container = self.view
        panel = getattr(container, "panel", container)
        panel.action = value
        if getattr(panel, "shortcut_mode", False):
            if hasattr(container, "_sync"):
                container._sync()
                return await edit_panel_v2(interaction, container)
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        if value == "global_start":
            return await interaction.response.send_modal(GlobalRoomModal(self.hub))
        if value in GVC_ROOM_FORMS:
            return await interaction.response.send_modal(GvcRoomModal(self.hub, value))
        await self.hub.dispatch_voice_action(interaction, value)


class VoiceHistorySelect(discord.ui.Select):
    """「よく使う／最近使った」機能への近道（導線最適化 M5、general/support と同機構）。"""

    def __init__(self, hub: VoiceHub, specs, row: int = 0):
        self.hub = hub
        super().__init__(
            placeholder="よく使う／最近使った機能",
            options=[discord.SelectOption(label=f"⭐ {spec.label}", value=spec.value)
                     for spec in specs],
            custom_id="panel:vc:history",
            row=row,
        )

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]
        if value == "global_start":
            return await interaction.response.send_modal(GlobalRoomModal(self.hub))
        if value in GVC_ROOM_FORMS:
            return await interaction.response.send_modal(GvcRoomModal(self.hub, value))
        await self.hub.dispatch_voice_action(interaction, value)


class VoicePanelView(discord.ui.View):
    def __init__(self, hub: VoiceHub, genre: str | None = None, shortcut_mode: bool = False,
                 shortcut_item: dict | None = None, owner_id: int | None = None,
                 history_specs: list | None = None):
        super().__init__(timeout=600)  # ルートパネル共通の寿命（導線最適化 S10）
        self.hub = hub
        self.owner_id = owner_id
        self.history_specs = list(history_specs or [])
        saved = (shortcut_item or {}).get("action", {})
        self.genre = genre or saved.get("genre")
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        self.refresh()

    def refresh(self):
        self.clear_items()
        offset = 0
        if self.history_specs:
            self.add_item(VoiceHistorySelect(self.hub, self.history_specs, row=0))
            offset = 1
        genre_select = VoiceGenreSelect(self.hub, self.genre)
        genre_select.row = offset
        self.add_item(genre_select)
        if self.genre:
            action_select = VoiceActionSelect(self.hub, self.genre)
            action_select.row = offset + 1
            self.add_item(action_select)
        # ジャンルワープ（core/panel_warps.py の対応表から自動配置。
        # ジャンル未選択（ハブ）起点の行も含む。1ジャンル最大2本まで）。
        from core.panel_warps import make_warp_button, warps_from

        for warp in warps_from("vc", self.genre)[:2]:
            self.add_item(make_warp_button("vc", warp, row=min(offset + 2, 4)))
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton("vc"))
        else:
            # 導線最適化 M9: 選んだ機能をその場でショートカット登録できる。
            from core.general.shortcuts import RegisterShortcutButton
            self.add_item(RegisterShortcutButton("vc"))

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "vc", "genre": self.genre, "value": self.action}

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id


    def embed(self):
        return discord.Embed(title=VOL + ' VC・音楽機能パネル', color=0xFFFFFF)


class GlobalRoomModal(discord.ui.Modal, title="グローバルVCに参加"):
    room = discord.ui.TextInput(label="ルーム名", placeholder="参加するルーム名", max_length=100)
    password = discord.ui.TextInput(label="パスワード（任意）", required=False, max_length=100)

    def __init__(self, hub: VoiceHub):
        super().__init__()
        self.hub = hub

    async def on_submit(self, interaction: discord.Interaction):
        await self.hub.dispatch_voice_action(
            interaction, "global_start", room=self.room.value, password=self.password.value or None
        )


class GvcRoomModal(discord.ui.Modal):
    """グローバルVCルームの操作（作成・情報・削除・グロチャ接続）の入力フォーム。"""

    def __init__(self, hub: VoiceHub, action: str):
        title, fields = GVC_ROOM_FORMS[action]
        super().__init__(title=title)
        self.hub = hub
        self.action = action
        self.inputs: dict[str, discord.ui.TextInput] = {}
        for key, label, max_length, required, initial in fields:
            item = discord.ui.TextInput(
                label=label, max_length=max_length, required=required, default=initial or None
            )
            self.inputs[key] = item
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        form = {key: item.value.strip() for key, item in self.inputs.items()}
        await self.hub.voice_global_rooms(interaction, self.action, form)


class MusicSearchModal(discord.ui.Modal, title="楽曲検索・追加（選択式）"):
    """キーワードを聞き、選択式検索（音楽cog の _search_impl / SearchView）へ渡す。

    音楽パネル本体の検索ボタン（SearchModal: 先頭候補をそのまま追加）とは別経路で、
    こちらは候補一覧から選んで追加する。
    """

    keyword = discord.ui.TextInput(
        label="検索キーワードまたはURL",
        placeholder="例: 米津玄師 地球儀 / https://...",
        required=True,
        max_length=200,
    )

    def __init__(self, hub: VoiceHub):
        super().__init__()
        self.hub = hub

    async def on_submit(self, interaction: discord.Interaction):
        cog = await self.hub._cog(interaction, "music")
        if cog:
            await cog._search_impl(Responder(interaction), self.keyword.value.strip())
