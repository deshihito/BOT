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
from core import voice_restore
from core.legacy import Responder
from core.voice_session import VoiceBusy, get_manager
from core.voice_recv_patch import patch_voice_recv_client
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.globalvc.audio import _JoinRefused  # noqa: F401
from core.globalvc.rooms import GLOBAL_ROOMS, ROOMS, RoomConfig, _can_delete_room, _disconnect_and_cleanup, _persist_rooms, _prune_dead_clients  # noqa: F401
from core.globalvc.textlink import ROOM_TEXT_LINKS, _remove_text_link  # noqa: F401
from core.globalvc.ui import GlobalRoomListView  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class ManageMixin:
    def room_list_view(self, guild: Optional[discord.Guild]) -> "GlobalRoomListView":
        """ルーム一覧（参加ボタン付き / Components V2）を返す。"""
        return GlobalRoomListView(self, getattr(guild, "id", None))


    async def _room_create_impl(self, r: Responder, room_name: str, max_servers: int,
                                password: str, description: str):
        """ルームを作成する。パスワードがあれば非公開。作成者がVCにいれば、そのVCにボットも参加する。"""
        await r.defer()
        if r.guild is None:
            return await r.send("⚠️ ルームはサーバー内で作成してください。", ephemeral=True)
        if not room_name:
            return await r.send("⚠️ ルーム名を入力してください。", ephemeral=True)
        if room_name in ROOMS:
            return await r.send(f"⚠️ ルーム **{room_name}** はすでに存在します。", ephemeral=True)
        if max_servers < 0:
            return await r.send("⚠️ 最大参加サーバー数は 0 以上の値を指定してください。", ephemeral=True)

        private = bool(password)
        ROOMS[room_name] = RoomConfig(
            name=room_name,
            owner_id=r.user.id,
            owner_guild_id=r.guild.id,
            max_servers=max_servers,
            private=private,
            password=password,
            description=description,
        )
        _persist_rooms()

        embed = discord.Embed(title=f"🌐 ルーム **{room_name}** を作成しました", color=0x2ECC71)
        embed.add_field(name="最大参加サーバー数", value="無制限" if max_servers == 0 else str(max_servers))
        embed.add_field(name="公開設定", value="🔒 非公開" if private else "🌍 公開")
        if description:
            embed.add_field(name="説明", value=description, inline=False)
        embed.set_footer(text="/vc →「グローバルVCルーム」→「ルーム一覧」の参加ボタンから参加できます")
        await r.send(embed=embed)

        # 作成者がボイスチャンネルにいるなら、そのままボットも参加させる
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(
                "ℹ️ ボイスチャンネルに入った状態でルームを作成すると、ボットが自動で参加します。"
                "参加するには `/vc` のパネルから参加してください。",
                ephemeral=True,
            )
        try:
            await self._connect_room(r.guild, voice.channel, r.user, r.channel, room_name)
        except (_JoinRefused, VoiceBusy) as e:
            await r.send(f"⚠️ ルームは作成しましたが、VC には参加できませんでした: {e}", ephemeral=True)
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s 作成後の自動参加に失敗しました", room_name, exc_info=True)
            await r.send(f"⚠️ ルームは作成しましたが、VC への参加に失敗しました: `{e}`", ephemeral=True)
        else:
            await r.send(f"🎙️ **{voice.channel.name}** に参加し、ルーム **{room_name}** に接続しました。")


    async def _room_info_impl(self, r: Responder, room_name: str):
        await r.defer()
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。", ephemeral=True
            )

        clients = GLOBAL_ROOMS.get(room_name, [])
        servers = [vc.guild.name for vc in clients if vc.guild]
        chat_channels = []
        for link in ROOM_TEXT_LINKS.get(room_name, []):
            channel = self.bot.get_channel(link.channel_id)
            if channel:
                chat_channels.append(f"#{channel.name} ({channel.guild.name})")

        embed = discord.Embed(title=f"🌐 ルーム情報: {room_name}", color=0x3498DB)
        embed.add_field(name="公開設定", value="🔒 非公開" if room.private else "🌍 公開")
        embed.add_field(name="最大参加サーバー数", value="無制限" if room.max_servers == 0 else str(room.max_servers))
        embed.add_field(name="現在の参加サーバー数(VC)", value=str(len(servers)))
        if servers:
            embed.add_field(name="接続中のサーバー(VC)", value=", ".join(servers), inline=False)
        embed.add_field(name="グロチャ接続数", value=str(len(chat_channels)))
        if chat_channels:
            embed.add_field(name="グロチャ接続チャンネル", value="\n".join(chat_channels), inline=False)
        if room.description:
            embed.add_field(name="説明", value=room.description, inline=False)
        embed.add_field(name="作成日時", value=f"<t:{int(room.created_at)}:R>", inline=False)
        await r.send(embed=embed)


    async def _room_delete_impl(self, r: Responder, room_name: str):
        await r.defer()
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。", ephemeral=True
            )

        if not _can_delete_room(room, r.user, r.guild):
            return await r.send(
                "⚠️ このルームを削除できるのは、作成者か、ルームを作ったサーバーで"
                "「サーバー管理」権限を持つ人だけです。",
                ephemeral=True,
            )

        for vc in list(GLOBAL_ROOMS.get(room_name, [])):
            own = r.guild is not None and getattr(vc.guild, "id", None) == r.guild.id
            await self._leave_room(vc, reason="room_deleted", notice=None if own else
                                   f"🗑️ ルーム **{room_name}** が削除されたため、グローバルVCから切断しました。")

        for link in list(ROOM_TEXT_LINKS.get(room_name, [])):
            await _remove_text_link(link.channel_id)

        GLOBAL_ROOMS.pop(room_name, None)
        ROOM_TEXT_LINKS.pop(room_name, None)
        del ROOMS[room_name]
        _persist_rooms()
        await r.send(f"🗑️ ルーム **{room_name}** を削除しました (VC・グロチャの連携もすべて解除)。")


    async def _global_impl(self, r: Responder, action: str, room_name: str | None = None, password: str | None = None):
        """action: join / leave"""
        if action == "leave":
            return await self._leave(r)
        return await self._join(r, room_name, password)


    async def _join(self, r: Responder, room_name: str | None, password: str | None):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(VOICE_NOT_JOINED, ephemeral=True)
        if not room_name:
            return await r.send("⚠️ 参加するルーム名を `room` に入れてください。", ephemeral=True)

        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。"
                f"先に `/vc` →「グローバルVCルーム」→「ルーム作成」で作成してください。"
            )

        if room.private and password != room.password:
            return await r.send("🔒 このルームは非公開です。正しいパスワードを指定してください。")

        _prune_dead_clients(room_name)
        current_members = GLOBAL_ROOMS.get(room_name, [])
        if room.max_servers and len(current_members) >= room.max_servers:
            return await r.send(f"⚠️ ルーム **{room_name}** は満員です ({room.max_servers}サーバーまで)。")

        if any(vc.guild and vc.guild.id == r.guild.id for vc in current_members):
            return await r.send(f"⚠️ このサーバーはすでにルーム **{room_name}** に参加しています。")

        vc_channel = voice.channel
        await r.defer()

        session = self.voice_sessions.get(r.guild.id)
        if session is not None and session.feature == "global":
            joined = next((name for name, clients in GLOBAL_ROOMS.items()
                           if any(c.guild and c.guild.id == r.guild.id for c in clients)), None)
            return await r.send(
                f"⚠️ このサーバーはすでにルーム **{joined or '不明'}** に参加しています。"
                "先に `/vc のパネルからグローバルVC終了/退出` してください。"
            )

        try:
            await self._connect_room(r.guild, vc_channel, r.user, r.channel, room_name)
        except _JoinRefused as refused:
            return await r.send(f"⚠️ {refused}")
        except VoiceBusy as busy:
            return await r.send(str(busy))
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s への参加に失敗しました", room_name, exc_info=True)
            return await r.send(voice_connection_failed(e))

        await r.send(
            f"🌐 ルーム **{room_name}** に参加しました！\n"
            f"別サーバーの同名ルームと相互接続されています。"
        )


    async def _leave(self, r: Responder):
        if r.guild is not None and await self.voice_sessions.release(r.guild.id, "global", reason="stop"):
            return await r.send("🌐 グローバルVCから切断しました。ルーム自体は残っています。")

        vc = r.voice_client
        if not vc:
            return await r.send("現在ボイスチャンネルに接続していません。")
        if any(vc in clients for clients in GLOBAL_ROOMS.values()):
            # 持ち主の記録がない古い接続
            await _disconnect_and_cleanup(vc)
            return await r.send("🌐 グローバルVCから切断しました。ルーム自体は残っています。")
        # 音楽や録音など、グローバルVC 以外の機能は止めない（以前はここで何でも切断していた）
        await r.send("このサーバーはグローバルVCに参加していません。")
