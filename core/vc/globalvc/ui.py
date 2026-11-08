from __future__ import annotations
import array
import asyncio
import dataclasses
import io
import logging
import re
import sys
import threading
import time
import types
from typing import Optional
import discord
import discord.opus
from discord.ext import commands, tasks
from discord.ext import voice_recv
from core.vc import voice_restore
from core.support.legacy import Responder
from core.support.panel_v2 import embed_text
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed, room_not_found
from core.vc.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
from core.support.emojis import FAILED
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.vc.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.globalvc.rooms import GLOBAL_ROOMS, ROOMS, _persist_rooms, _prune_dead_clients, _room_user_count  # noqa: F401
from core.vc.globalvc.lang import effective_filter_lang, locale_label, room_visible  # noqa: F401
from core.vc.globalvc.textlink import ROOM_TEXT_LINKS  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class _RoomJoinButton(discord.ui.Button):
    """ルーム一覧の「参加」ボタン。押すとそのルームに参加する。"""

    def __init__(self, index: int, room_name: str, private: bool, disabled: bool):
        super().__init__(
            label=room_name[:80],
            emoji="🔒" if private else "🌍",
            style=discord.ButtonStyle.secondary if disabled else discord.ButtonStyle.primary,
            disabled=disabled,
            custom_id=f"gvc_join:{index}",
        )
        self.room_name = room_name

    async def callback(self, interaction: discord.Interaction):
        await self.view.join(interaction, self.room_name)


class _TextChatToggleView(discord.ui.LayoutView):
    """ルーム作成直後に「グロチャ自動接続」を切り替えるボタン（作成者だけ操作可）。

    ON にした時点でこのサーバーがすでにルームへ接続中なら、そのチャンネルも
    その場でグロチャへ自動接続する。以後の VC 参加では _connect_room が連動する。
    """

    def __init__(self, cog: "GlobalVCCog", room_name: str, user_id: int,
                 embed: discord.Embed | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.room_name = room_name
        self.user_id = user_id
        self.button = discord.ui.Button()
        self.button.callback = self._toggle
        self._sync()
        items: list[discord.ui.Item] = []
        if embed is not None:
            items.append(discord.ui.TextDisplay(embed_text(embed)))
        items.append(discord.ui.ActionRow(self.button))
        self.add_item(discord.ui.Container(
            *items, accent_colour=getattr(embed, "colour", None)))

    def _sync(self):
        room = ROOMS.get(self.room_name)
        enabled = bool(room and room.text_chat)
        self.button.label = f"グロチャ自動接続: {'ON' if enabled else 'OFF'}"
        self.button.style = (discord.ButtonStyle.success if enabled
                             else discord.ButtonStyle.secondary)

    async def _toggle(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "切り替えられるのはルームの作成者だけです。", ephemeral=True)
        room = ROOMS.get(self.room_name)
        if room is None:
            return await interaction.response.send_message(
                f"{FAILED} ルーム **{self.room_name}** は削除されています。", ephemeral=True)
        room.text_chat = not room.text_chat
        _persist_rooms()
        self._sync()
        await interaction.response.edit_message(view=self)
        if room.text_chat and interaction.guild is not None:
            connected = any(
                c.guild is not None and c.guild.id == interaction.guild.id
                for c in GLOBAL_ROOMS.get(room.name, []))
            if connected:
                await self.cog._auto_link_text_chat(
                    interaction.guild, interaction.channel, room)


class _PrivateRoomJoinModal(discord.ui.Modal, title="非公開ルームに参加"):
    password = discord.ui.TextInput(label="パスワード", max_length=100)

    def __init__(self, cog: "GlobalVCCog", room_name: str):
        super().__init__()
        self.cog = cog
        self.room_name = room_name

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog._join(Responder(interaction), self.room_name, self.password.value)


class GlobalRoomListView(discord.ui.LayoutView):
    """ルーム一覧。各ルームの「参加」ボタンからそのまま参加できる (非公開ルームはパスワード入力)。"""

    MAX_ROOMS = 25  # 1メッセージのコンポーネント上限 (40) に収まる件数

    def __init__(self, cog: "GlobalVCCog", guild_id: Optional[int]):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self._build()

    def _build(self):
        self.clear_items()
        _prune_dead_clients()
        if not ROOMS:
            self.add_item(discord.ui.Container(
                discord.ui.TextDisplay("## 🌐 ルーム一覧\n現在作成されているグローバルVCルームはありません。"),
                accent_colour=0x95A5A6,
            ))
            return

        # このサーバーがすでにどこかのルームに参加中なら、参加ボタンは全部使えない (1サーバー1ルーム)
        joined_here = self.guild_id is not None and any(
            c.guild is not None and c.guild.id == self.guild_id
            for clients in GLOBAL_ROOMS.values() for c in clients
        )

        # 言語フィルタ: 原則は自サーバーと同じ言語のルームだけを出す（設定で変更可）
        filter_lang = effective_filter_lang(self.guild_id)
        visible = {name: room for name, room in ROOMS.items()
                   if room_visible(room.language, filter_lang)}
        if not visible:
            label = locale_label(filter_lang) if filter_lang else ""
            self.add_item(discord.ui.Container(
                discord.ui.TextDisplay(
                    f"## 🌐 ルーム一覧\n表示言語（{label}）に一致するルームはありません。"
                    "「言語設定」から表示する言語を変更できます。"),
                accent_colour=0x95A5A6,
            ))
            return

        # 常設ルームは一覧の上部に固定表示する（同種内は作成順を保つ）
        names = sorted(visible, key=lambda n: not visible[n].permanent)[: self.MAX_ROOMS]
        lines: list[str] = []
        buttons: list[_RoomJoinButton] = []
        for index, name in enumerate(names):
            room = ROOMS[name]
            servers = [vc.guild.name for vc in GLOBAL_ROOMS.get(name, []) if vc.guild]
            full = bool(room.max_servers) and len(servers) >= room.max_servers
            cap = "無制限" if room.max_servers == 0 else f"{len(servers)}/{room.max_servers}"
            lock = "🔒" if room.private else "🌍"
            pin = "📌 " if room.permanent else ""
            line = (f"{pin}{lock} **{name}** ・ VC参加 {cap} ・ 参加者 {_room_user_count(name)}人"
                    f" ・ グロチャ {len(ROOM_TEXT_LINKS.get(name, []))}")
            if room.language:
                line += f" ・ 言語: {locale_label(room.language)}"
            if full:
                line += " ・ 満員"
            if room.description:
                line += "\n-# " + room.description.replace("\n", " ")[:30]
            if room.theme:
                theme_line = room.theme.replace("\n", " ")[:30]
                if room.theme_auto:
                    theme_line += "（毎日変更）"
                line += "\n-# 🎯 テーマ: " + theme_line
            lines.append(line)
            buttons.append(_RoomJoinButton(index, name, room.private, disabled=joined_here or full))

        header = "## 🌐 ルーム一覧\nボイスチャンネルに入っている必要があります。"
        notes: list[str] = []
        if len(visible) > self.MAX_ROOMS:
            notes.append(f"表示は先頭 {self.MAX_ROOMS} 件です（全 {len(visible)} 件）")
        if filter_lang is not None and len(visible) < len(ROOMS):
            notes.append(f"表示言語: {locale_label(filter_lang)} のみ（言語設定で変更できます）")
        if joined_here:
            notes.append("このサーバーはすでにルームに参加中のため、参加ボタンは使えません")
        if notes:
            header += "\n" + "\n".join(f"-# {note}" for note in notes)

        children: list = [
            discord.ui.TextDisplay(header + "\n\n" + "\n".join(lines)),
            discord.ui.Separator(),
        ]
        for start in range(0, len(buttons), 5):
            children.append(discord.ui.ActionRow(*buttons[start:start + 5]))
        self.add_item(discord.ui.Container(*children, accent_colour=0x2ECC71))

    async def join(self, interaction: discord.Interaction, room_name: str):
        room = ROOMS.get(room_name)
        if room is None:
            return await interaction.response.send_message(
                f"{FAILED} " + room_not_found(room_name), ephemeral=True
            )
        if room.private:
            return await interaction.response.send_modal(_PrivateRoomJoinModal(self.cog, room_name))
        await self.cog._join(Responder(interaction), room_name, None)
