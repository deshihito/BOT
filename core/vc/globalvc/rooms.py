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
from core.vc.globalvc.themes import theme_day, theme_for  # noqa: F401

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
    permanent: bool = False       # 常設ルーム（一覧の上部に固定表示される）
    theme: str = ""               # テーマ（話の話題）。"" = テーマなし
    theme_auto: bool = False      # 常設ルームの自動テーマ（毎日 theme_for で回す）
    text_chat: bool = False       # VC参加時に、そのテキストチャンネルもグロチャへ自動接続する
    language: str = ""            # ルームの言語（作成サーバーの言語設定）。"" = 指定なし（全言語に表示）


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
        "permanent": bool(room.permanent),
        "theme": room.theme,
        "theme_auto": bool(room.theme_auto),
        "text_chat": bool(room.text_chat),
        "language": room.language,
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
            # 旧形式の保存データには無いキーなので、既定値（通常ルーム・テーマなし）で読む
            permanent=bool(data.get("permanent")),
            theme=str(data.get("theme") or ""),
            theme_auto=bool(data.get("theme_auto")),
            text_chat=bool(data.get("text_chat")),
            language=str(data.get("language") or ""),
        )
    except (TypeError, ValueError):
        return None


# 公式の常設ルーム（言語ごと: 日替わりテーマ部屋＋テーマなしのフリー部屋）。
# 値: (テーマ部屋の名前, テーマ部屋の説明, フリー部屋の名前, フリー部屋の説明)
OFFICIAL_ROOMS: dict[str, tuple[str, str, str, str]] = {
    "ja": ("日本語・日替わりテーマ", "毎日テーマが変わる常設ルームです。テーマに沿って雑談しましょう。",
           "日本語・フリー雑談", "テーマなしの自由な常設ルームです。"),
    "en": ("English - Daily Theme", "A permanent room with a new theme every day.",
           "English - Free Chat", "A permanent room with no theme. Chat about anything."),
    "zh": ("中文 - 每日主题", "每天更换主题的常设房间。",
           "中文 - 自由聊天", "没有主题的自由常设房间。"),
    "ko": ("한국어 - 오늘의 테마", "매일 테마가 바뀌는 상설 방입니다.",
           "한국어 - 자유 채팅", "테마 없는 자유로운 상설 방입니다."),
    "id": ("Bahasa Indonesia - Tema Harian", "Ruang permanen dengan tema baru setiap hari.",
           "Bahasa Indonesia - Obrolan Bebas", "Ruang permanen tanpa tema. Bebas mengobrol apa saja."),
    "th": ("ไทย - ธีมประจำวัน", "ห้องถาวรที่เปลี่ยนธีมทุกวัน",
           "ไทย - ห้องคุยอิสระ", "ห้องถาวรไม่มีธีม คุยได้ทุกเรื่อง"),
    "ar": ("العربية - موضوع اليوم", "غرفة دائمة بموضوع جديد كل يوم.",
           "العربية - دردشة حرة", "غرفة دائمة بدون موضوع. دردش بحرية."),
    "hi": ("हिन्दी - दैनिक थीम", "हर दिन नई थीम वाला स्थायी रूम।",
           "हिन्दी - फ्री चैट", "बिना थीम का स्थायी रूम। किसी भी विषय पर बात करें।"),
}


def ensure_official_rooms() -> list[str]:
    """公式の常設ルームが無ければ作る（言語ごとにテーマ部屋とフリー部屋）。

    起動時に cog_load から呼ぶ。既にある名前（公式・ユーザー作成を問わない）は
    一切変更しないので、管理者が後からテーマ等を変更しても元に戻らない。
    作ったルーム名の一覧を返す。
    """
    created: list[str] = []
    for code, (theme_name, theme_desc, free_name, free_desc) in OFFICIAL_ROOMS.items():
        for name, desc, auto in ((theme_name, theme_desc, True), (free_name, free_desc, False)):
            if name in ROOMS:
                continue
            ROOMS[name] = RoomConfig(
                name=name, owner_id=0, owner_guild_id=0,
                description=desc, permanent=True, theme_auto=auto, language=code)
            created.append(name)
    if created:
        _persist_rooms()
        logger.info("グローバルVC: 公式の常設ルームを作成しました: %s", ", ".join(created))
    return created


def rotate_room_themes(now=None) -> list[str]:
    """自動テーマの常設ルームに、その日のテーマを割り当てる。

    JST の日付が変わっていればテーマが次の候補へ進む。変わったルームが
    あればまとめて保存する。テーマが変わったルーム名の一覧を返す。
    """
    day = theme_day(now)
    changed: list[str] = []
    for room in ROOMS.values():
        if not room.permanent or not room.theme_auto:
            continue
        theme = theme_for(room.name, day, room.language or "ja")
        if theme and theme != room.theme:
            room.theme = theme
            changed.append(room.name)
    if changed:
        _persist_rooms()
    return changed


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


def _room_members(room_name: str) -> list:
    """ルームに接続中の (member, guild) 一覧。人間だけ、ユーザーIDで重複を除く。"""
    seen: set[int] = set()
    members: list = []
    for vc in GLOBAL_ROOMS.get(room_name, []):
        channel = getattr(vc, "channel", None)
        for member in getattr(channel, "members", None) or []:
            if getattr(member, "bot", False):
                continue
            member_id = getattr(member, "id", None)
            if member_id is None or member_id in seen:
                continue
            seen.add(member_id)
            members.append((member, getattr(vc, "guild", None)))
    return members


def _room_user_count(room_name: str) -> int:
    """ルームのVCに今入っているユーザー数（全接続サーバー合計）。"""
    return len(_room_members(room_name))


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
