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
from core.vc.globalvc.common import PLAYBACK_WATCHDOG_IDLE_SECONDS, PLAYBACK_WATCHDOG_SECONDS, STALE_VC_GRACE_SECONDS  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


@dataclasses.dataclass
class RoomConfig:
    """`gvc create` で定義されるルームの設定。接続の有無に関わらず存在する。"""
    name: str
    owner_id: int
    owner_guild_id: int
    max_servers: int = 0          # 0 = 無制限
    private: bool = False
    password: str = ""
    description: str = ""
    created_at: float = dataclasses.field(default_factory=time.time)


ROOMS: dict[str, RoomConfig] = {}


GLOBAL_ROOMS: dict[str, list[voice_recv.VoiceRecvClient]] = {}


def _room_to_dict(room: RoomConfig) -> dict:
    return {
        "name": room.name,
        "owner_id": room.owner_id,
        "owner_guild_id": room.owner_guild_id,
        "max_servers": room.max_servers,
        "private": bool(room.private),
        "password": room.password,
        "description": room.description,
        "created_at": room.created_at,
    }


def _room_from_dict(data) -> Optional[RoomConfig]:
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    if not isinstance(name, str) or not name:
        return None
    try:
        return RoomConfig(
            name=name,
            owner_id=int(data.get("owner_id") or 0),
            owner_guild_id=int(data.get("owner_guild_id") or 0),
            max_servers=int(data.get("max_servers") or 0),
            private=bool(data.get("private")),
            password=str(data.get("password") or ""),
            description=str(data.get("description") or ""),
            created_at=float(data.get("created_at") or time.time()),
        )
    except (TypeError, ValueError):
        return None


def _persist_rooms() -> None:
    """ROOMS の全定義をスナップショットへ書く。失敗してもルーム機能は止めない。"""
    try:
        store = voice_restore.get_store()
        store.set_section("gvc_rooms", {name: _room_to_dict(room) for name, room in ROOMS.items()})
        store.flush()
    except Exception:
        logger.debug("グローバルVC: ルーム定義の保存に失敗しました", exc_info=True)


def _load_rooms() -> None:
    """保存済みのルーム定義を ROOMS へ復元する（既にある名前は上書きしない）。"""
    try:
        saved = voice_restore.get_store().section("gvc_rooms")
    except Exception:
        logger.debug("グローバルVC: ルーム定義の読み込みに失敗しました", exc_info=True)
        return
    for name, data in saved.items():
        room = _room_from_dict(data)
        if room is not None and room.name not in ROOMS:
            ROOMS[room.name] = room


def _persist_join(guild_id: int, room_name: str, voice_channel_id, text_channel_id, user) -> None:
    try:
        store = voice_restore.get_store()
        store.set_entry("gvc_joins", str(guild_id), {
            "room_name": room_name,
            "voice_channel_id": voice_channel_id,
            "text_channel_id": text_channel_id,
            "user_id": getattr(user, "id", None),
            "user_name": str(getattr(user, "display_name", None) or getattr(user, "name", None) or ""),
        })
        store.flush()
    except Exception:
        logger.debug("グローバルVC: 参加状態の保存に失敗しました guild=%s", guild_id, exc_info=True)


def _clear_join(guild_id: int) -> None:
    try:
        store = voice_restore.get_store()
        store.set_entry("gvc_joins", str(guild_id), None)
        store.flush()
    except Exception:
        logger.debug("グローバルVC: 参加状態の削除に失敗しました guild=%s", guild_id, exc_info=True)


def _remove_vc_from_rooms(vc: voice_recv.VoiceRecvClient) -> Optional[str]:
    """全ルームの接続中リストから vc を取り除く。所属していたルーム名を返す。"""
    for room_name, clients in list(GLOBAL_ROOMS.items()):
        if vc in clients:
            clients.remove(vc)
            if not clients:
                del GLOBAL_ROOMS[room_name]
            return room_name
    return None


def _prune_dead_clients(room_name: Optional[str] = None) -> None:
    """切断されたまま戻ってこない接続を GLOBAL_ROOMS から外す。

    外部切断・キック・ネットワーク断などで一覧にだけ残ると、「すでに参加しています」や満員扱いが
    永久に解けず、他サーバーの音声も存在しない接続へ送り続けてしまう。再接続中の一時的な切断は猶予で吸収する。
    """
    now = time.monotonic()
    names = [room_name] if room_name else list(GLOBAL_ROOMS)
    for name in names:
        for vc in list(GLOBAL_ROOMS.get(name, ())):
            try:
                connected = vc.is_connected()
            except Exception:
                connected = False
            if connected:
                vc._gvc_down_since = None
                continue
            since = getattr(vc, "_gvc_down_since", None)
            if since is None:
                vc._gvc_down_since = now
            elif now - since >= STALE_VC_GRACE_SECONDS:
                logger.info("グローバルVC: 切断されたままの接続を一覧から外します (room=%s)", name)
                _remove_vc_from_rooms(vc)
                try:
                    vc.stop_listening()
                except Exception:
                    logger.debug("stop_listening 失敗 (無視)", exc_info=True)


async def _disconnect_and_cleanup(vc: voice_recv.VoiceRecvClient) -> None:
    """listen/play を止めて切断し、ルーム管理からも除去する。"""
    _remove_vc_from_rooms(vc)
    try:
        vc.stop_listening()
    except Exception:
        logger.debug("stop_listening 失敗 (無視)", exc_info=True)
    try:
        await vc.disconnect(force=True)
    except Exception:
        logger.debug("disconnect 失敗 (無視)", exc_info=True)


def _watchdog_interval_seconds(rooms: Optional[dict] = None) -> float:
    """watchdog の見回り間隔を返す。接続中のクライアントがある間だけ短くする。

    見回りの対象 (死んだ接続の除去・止まった再生の再開) は GLOBAL_ROOMS の中身にしか
    存在しないので、空の間は間隔を伸ばしても挙動は変わらない。
    """
    rooms = GLOBAL_ROOMS if rooms is None else rooms
    if any(rooms.values()):
        return PLAYBACK_WATCHDOG_SECONDS
    return PLAYBACK_WATCHDOG_IDLE_SECONDS


_WEBHOOK_BANNED_WORDS = (("discord", "i", "і"), ("clyde", "y", "у"))  # Webhook名に使えない語は見た目が近い文字へ置換


def _safe_webhook_username(name: str) -> str:
    """Webhook の username に使えない語 (discord / clyde) を含むと送信が 400 で失敗するので避ける。"""
    for word, ch, repl in _WEBHOOK_BANNED_WORDS:
        name = re.sub(word, lambda m: m.group(0).replace(ch, repl).replace(ch.upper(), repl.upper()),
                      name, flags=re.IGNORECASE)
    return name[:80].strip() or "unknown"


def _can_delete_room(room: RoomConfig, user, guild: Optional[discord.Guild]) -> bool:
    """ルームを消せるのは作成者本人か、ルームを作ったサーバーでサーバー管理権限を持つ人だけ。

    別のサーバーで管理権限を持っていても、そのサーバーのルームではないので消せない。
    """
    if user.id == room.owner_id:
        return True
    if guild is None or guild.id != room.owner_guild_id:
        return False
    permissions = getattr(user, "guild_permissions", None)
    return bool(permissions and permissions.manage_guild)
