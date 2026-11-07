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
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.vc.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.globalvc.rooms import ROOMS  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


@dataclasses.dataclass
class TextLink:
    guild_id: int
    channel_id: int
    webhook: discord.Webhook


ROOM_TEXT_LINKS: dict[str, list[TextLink]] = {}


CHANNEL_TO_ROOM: dict[int, str] = {}


def _text_link_to_dict(link: TextLink) -> dict:
    """TextLink を保存用 dict にする。Webhook 本体は持てないので id と URL に分解する。"""
    webhook = link.webhook
    try:
        webhook_url = webhook.url
    except Exception:
        webhook_url = None
    return {
        "guild_id": link.guild_id,
        "channel_id": link.channel_id,
        "webhook_id": getattr(webhook, "id", None),
        "webhook_url": webhook_url,
    }


def _persist_text_links() -> None:
    """ROOM_TEXT_LINKS の全連携をスナップショットへ書く。失敗してもグロチャ機能は止めない。"""
    try:
        store = voice_restore.get_store()
        store.set_section("gvc_text_links", {
            name: {"links": [_text_link_to_dict(link) for link in links]}
            for name, links in ROOM_TEXT_LINKS.items() if links
        })
        store.flush()
    except Exception:
        logger.debug("グローバルVC: グロチャ連携の保存に失敗しました", exc_info=True)


async def _restore_text_links(bot) -> None:
    """保存済みのグロチャ連携を ROOM_TEXT_LINKS / CHANNEL_TO_ROOM へ復元する。

    テキスト中継は VC 参加が無くても成立するので、参加状態（gvc_joins）の
    復旧とは独立に常に reconcile する。ルームが無い・チャンネルが見えない
    （削除済み／Bot が抜けた）・Webhook を再構築できないリンクは掃除し、
    掃除後の状態を保存し直す。失敗しても起動は止めない。
    """
    try:
        saved = voice_restore.get_store().section("gvc_text_links")
    except Exception:
        logger.debug("グローバルVC: グロチャ連携の読み込みに失敗しました", exc_info=True)
        return
    if not saved:
        return
    restored = 0
    for room_name, entry in saved.items():
        if room_name not in ROOMS:
            continue
        links = entry.get("links") if isinstance(entry, dict) else None
        if not isinstance(links, list):
            continue
        for item in links:
            if not isinstance(item, dict):
                continue
            try:
                guild_id = int(item.get("guild_id") or 0)
                channel_id = int(item.get("channel_id") or 0)
            except (TypeError, ValueError):
                continue
            if not channel_id or channel_id in CHANNEL_TO_ROOM:
                continue
            channel = bot.get_channel(channel_id) if bot is not None else None
            if channel is None:
                continue
            webhook_url = item.get("webhook_url")
            if not isinstance(webhook_url, str) or not webhook_url:
                continue
            try:
                webhook = discord.Webhook.from_url(webhook_url, client=bot)
            except Exception:
                logger.debug(
                    "グローバルVC: Webhook の再構築に失敗しました (channel_id=%s)",
                    channel_id, exc_info=True,
                )
                continue
            actual_guild_id = getattr(getattr(channel, "guild", None), "id", None) or guild_id
            ROOM_TEXT_LINKS.setdefault(room_name, []).append(
                TextLink(guild_id=actual_guild_id, channel_id=channel_id, webhook=webhook)
            )
            CHANNEL_TO_ROOM[channel_id] = room_name
            restored += 1
    # 掃除後の状態を保存し直す（消えたリンクが次回起動時にも残らないように）
    _persist_text_links()
    if restored:
        logger.info("グローバルVC: グロチャ連携を %d 件復旧しました", restored)


async def _remove_text_link(channel_id: int, *, delete_webhook: bool = True) -> Optional[str]:
    """指定チャンネルのグロチャ連携を解除する。所属していたルーム名を返す。"""
    room_name = CHANNEL_TO_ROOM.pop(channel_id, None)
    if room_name is None:
        return None

    links = ROOM_TEXT_LINKS.get(room_name, [])
    for link in list(links):
        if link.channel_id == channel_id:
            links.remove(link)
            if delete_webhook:
                try:
                    await link.webhook.delete(reason="グロチャ連携解除")
                except Exception:
                    logger.debug("webhook 削除失敗 (無視)", exc_info=True)
    if not links:
        ROOM_TEXT_LINKS.pop(room_name, None)
    _persist_text_links()
    return room_name
