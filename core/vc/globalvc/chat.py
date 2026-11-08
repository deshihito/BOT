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
from core.vc.globalvc.rooms import ROOMS, _safe_webhook_username  # noqa: F401
from core.vc.globalvc.textlink import CHANNEL_TO_ROOM, ROOM_TEXT_LINKS, TextLink, _persist_text_links, _remove_text_link  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


class ChatMixin:
    async def _chat_connect_impl(self, r: Responder, room_name: str, password: Optional[str]):
        """このチャンネルを指定ルームのグロチャ (テキスト中継) に接続する。Webhook を作って中継する。"""
        await r.defer()
        if r.guild is None:
            return await r.send(f"{FAILED} グロチャはサーバー内のチャンネルで接続してください。", ephemeral=True)
        channel = r.channel
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"{FAILED} " + room_not_found(room_name)
                + "先に `/vc` →「グローバルVCルーム」→「ルーム作成」で作成してください。",
                ephemeral=True,
            )

        if room.private and password != room.password:
            return await r.send("🔒 このルームは非公開です。正しいパスワードを指定してください。", ephemeral=True)

        if channel.id in CHANNEL_TO_ROOM:
            current_room = CHANNEL_TO_ROOM[channel.id]
            return await r.send(
                f"{FAILED} このチャンネルはすでにルーム **{current_room}** のグロチャに接続されています。"
                "先にグロチャの接続解除をしてください。",
                ephemeral=True,
            )

        if any(link.guild_id == r.guild.id for link in ROOM_TEXT_LINKS.get(room_name, [])):
            return await r.send(
                f"{FAILED} このサーバーはすでに別のチャンネルでルーム **{room_name}** のグロチャに接続済みです。",
                ephemeral=True,
            )

        perms = channel.permissions_for(r.guild.me)
        if not perms.manage_webhooks:
            return await r.send(f"{FAILED} このチャンネルで Webhook を管理する権限がボットにありません。", ephemeral=True)

        try:
            webhook = await channel.create_webhook(
                name=f"グロチャ: {room_name}", reason="グローバルチャット連携"
            )
        except Exception as e:
            return await r.send(
                f"{FAILED} Webhook の作成に失敗しました: `{e}`", ephemeral=True
            )

        link = TextLink(guild_id=r.guild.id, channel_id=channel.id, webhook=webhook)
        ROOM_TEXT_LINKS.setdefault(room_name, []).append(link)
        CHANNEL_TO_ROOM[channel.id] = room_name
        _persist_text_links()

        await r.send(
            f"🌐 このチャンネルをルーム **{room_name}** のグロチャに接続しました！\n"
            f"以降、このチャンネルの発言は同ルームに接続中の他サーバーへ、送信者の名前とアイコンで中継されます。"
        )


    async def _chat_disconnect_impl(self, r: Responder):
        await r.defer()
        room_name = await _remove_text_link(r.channel.id)
        if room_name is None:
            return await r.send("このチャンネルはグロチャに接続されていません。", ephemeral=True)
        await r.send(f"🌐 ルーム **{room_name}** のグロチャ接続を解除しました。")


    async def _auto_link_text_chat(self, guild, channel, room) -> bool:
        """text_chat が有効なルームへの VC 参加時に、そのテキストチャンネルもグロチャへ自動接続する。

        すでに接続済みのチャンネル・別チャンネルで接続済みのサーバー・Webhook
        権限が無い場合は何もしない。失敗しても VC 参加自体は止めない。
        """
        try:
            if channel is None or getattr(channel, "id", None) is None:
                return False
            if channel.id in CHANNEL_TO_ROOM:
                return False
            if any(link.guild_id == guild.id for link in ROOM_TEXT_LINKS.get(room.name, [])):
                return False
            me = getattr(guild, "me", None)
            if me is not None and not channel.permissions_for(me).manage_webhooks:
                return False
            webhook = await channel.create_webhook(
                name=f"グロチャ: {room.name}", reason="グローバルチャット連携（自動接続）"
            )
            link = TextLink(guild_id=guild.id, channel_id=channel.id, webhook=webhook)
            ROOM_TEXT_LINKS.setdefault(room.name, []).append(link)
            CHANNEL_TO_ROOM[channel.id] = room.name
            _persist_text_links()
            logger.info("グローバルVC: ルーム %s のグロチャへ自動接続しました (channel_id=%s)",
                        room.name, channel.id)
            try:
                await channel.send(
                    f"🌐 ルーム **{room.name}** のグロチャにも自動接続しました"
                    "（VC参加に連動する設定が有効なため）。")
            except Exception:
                logger.debug("グローバルVC: グロチャ自動接続の通知に失敗しました", exc_info=True)
            return True
        except Exception:
            logger.debug("グローバルVC: グロチャ自動接続に失敗しました (room=%s)",
                         getattr(room, "name", "?"), exc_info=True)
            return False


    @commands.Cog.listener("on_message")
    async def on_message(self, message: discord.Message):
        # webhook からの中継メッセージ自身には反応しない (無限ループ防止)
        if message.webhook_id is not None:
            return
        if message.author.bot:
            return
        if not message.guild:
            return

        room_name = CHANNEL_TO_ROOM.get(message.channel.id)
        if room_name is None:
            return

        if not message.content and not message.attachments:
            return

        links = ROOM_TEXT_LINKS.get(room_name, [])
        if len(links) <= 1:
            return  # 他に接続チャンネルがなければ中継不要

        # 添付ファイルは一度だけ読み込み、送信先ごとに新しい File として使い回す
        # (discord.File は一度送信すると再利用できないため)
        attachment_payloads: list[tuple[bytes, str]] = []
        for attachment in message.attachments:
            try:
                data = await attachment.read()
                attachment_payloads.append((data, attachment.filename))
            except Exception:
                logger.debug("グロチャ: 添付ファイル取得失敗 (%s)", attachment.filename, exc_info=True)

        content = (message.content or "")[:2000]
        username = _safe_webhook_username(f"{message.author.display_name} [{message.guild.name}]")
        avatar_url = message.author.display_avatar.url

        async def relay(link: TextLink) -> None:
            files = [discord.File(io.BytesIO(data), filename=name) for data, name in attachment_payloads]
            try:
                await link.webhook.send(
                    content=content if content else None,
                    username=username,
                    avatar_url=avatar_url,
                    files=files if files else discord.utils.MISSING,
                    allowed_mentions=discord.AllowedMentions.none(),
                    _agobot_skip_localization=True,
                )
            except discord.NotFound:
                # webhook が手動で削除された等 -> このチャンネルの連携を自動解除
                logger.warning(
                    "ルーム %s: webhook が見つかりません。連携を解除します (channel_id=%s)",
                    room_name, link.channel_id,
                )
                await _remove_text_link(link.channel_id, delete_webhook=False)
            except Exception as e:
                logger.warning(
                    "ルーム %s: グロチャ中継に失敗しました (channel_id=%s): %r",
                    room_name, link.channel_id, e,
                )

        # 1サーバーの遅延や失敗が他サーバーへの中継を止めないよう、並行して送る
        await asyncio.gather(*(relay(link) for link in list(links) if link.channel_id != message.channel.id))


    @commands.Cog.listener("on_guild_channel_delete")
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel):
        if channel.id in CHANNEL_TO_ROOM:
            # チャンネル自体が消えているので webhook 削除は試みない
            await _remove_text_link(channel.id, delete_webhook=False)
