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

import config  # noqa: F401

from core.vc.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.globalvc.audio import _JoinRefused  # noqa: F401
from core.vc.globalvc.rooms import GLOBAL_ROOMS, ROOMS, RoomConfig, _can_delete_room, _disconnect_and_cleanup, _persist_rooms, _prune_dead_clients, _room_members  # noqa: F401
from core.vc.globalvc.themes import theme_day, theme_for  # noqa: F401
from core.vc.globalvc.textlink import ROOM_TEXT_LINKS, _remove_text_link  # noqa: F401
from core.vc.globalvc.ui import GlobalRoomListView, _TextChatToggleView  # noqa: F401
from core.vc.globalvc.lang import GVC_SETTINGS_SECTION, LANG_OVERRIDE_KEY, LOCALE_LABELS, effective_filter_lang, locale_label, server_locale  # noqa: F401
from core.support import guild_settings  # noqa: F401
from core.leaderboard_image import BoardRow, board_safe_name, fetch_avatar_bytes, render_leaderboard_png  # noqa: F401
from core.support.panel_v2 import as_embed_v2

logger = logging.getLogger("cogs.sio_globalVC")


class ManageMixin:
    def room_list_view(self, guild: Optional[discord.Guild]) -> "GlobalRoomListView":
        """ルーム一覧（参加ボタン付き / Components V2）を返す。"""
        return GlobalRoomListView(self, getattr(guild, "id", None))


    async def _is_bot_admin(self, user) -> bool:
        """Bot管理者かどうか。アプリの所有者か、BOT_ADMIN_IDS（config）に登録されたID。

        常設ルームの作成・テーマ変更の前提になる判定。
        """
        if getattr(user, "id", None) in config.BOT_ADMIN_IDS:
            return True
        try:
            return bool(await self.bot.is_owner(user))
        except Exception:
            logger.debug("グローバルVC: Bot管理者チェックに失敗しました", exc_info=True)
            return False


    async def _room_create_impl(self, r: Responder, room_name: str, max_servers: int,
                                password: str, description: str,
                                theme: str = "", permanent: bool = False):
        """ルームを作成する。パスワードがあれば非公開。作成者がVCにいれば、そのVCにボットも参加する。

        theme は話の話題（空欄ならテーマなし）。常設ルーム（permanent）で
        テーマが空欄の場合は自動テーマになり、毎日プールから回っていく。
        """
        await r.defer()
        if r.guild is None:
            return await r.send(f"{FAILED} ルームはサーバー内で作成してください。", ephemeral=True)
        if permanent and not await self._is_bot_admin(r.user):
            return await r.send(f"{FAILED} 常設ルームを作成できるのはBot管理者だけです。", ephemeral=True)
        if not room_name:
            return await r.send(f"{FAILED} ルーム名を入力してください。", ephemeral=True)
        if room_name in ROOMS:
            return await r.send(f"{FAILED} ルーム **{room_name}** はすでに存在します。", ephemeral=True)
        if max_servers < 0:
            return await r.send(f"{FAILED} 最大参加サーバー数は 0 以上の値を指定してください。", ephemeral=True)

        private = bool(password)
        theme = (theme or "").strip()
        # テーマの指定方法: 「なし」ならテーマなし。常設は「自動」で日替わり、
        # 省略時も自動（日替わり）。それ以外は固定テーマ。
        theme_auto = False
        if theme in ("なし", "無し"):
            theme = ""
        elif permanent and theme in ("自動", "日替わり"):
            theme, theme_auto = "", True
        elif permanent and not theme:
            theme_auto = True
        room_lang = server_locale(r.guild.id)
        if theme_auto:
            theme = theme_for(room_name, theme_day(), room_lang)
        room_config = RoomConfig(
            name=room_name,
            owner_id=r.user.id,
            owner_guild_id=r.guild.id,
            max_servers=max_servers,
            private=private,
            password=password,
            description=description,
            permanent=permanent,
            theme=theme,
            theme_auto=theme_auto,
            language=room_lang,
        )
        ROOMS[room_name] = room_config
        _persist_rooms()

        embed = discord.Embed(title=f"🌐 ルーム **{room_name}** を作成しました", color=0x2ECC71)
        embed.add_field(name="最大参加サーバー数", value="無制限" if max_servers == 0 else str(max_servers))
        embed.add_field(name="公開設定", value="🔒 非公開" if private else "🌍 公開")
        if permanent:
            embed.add_field(name="種類", value="📌 常設ルーム")
        if theme_auto:
            embed.add_field(name="テーマ", value=f"🎯 {theme}（自動で毎日変更）", inline=False)
        elif theme:
            embed.add_field(name="テーマ", value=f"🎯 {theme}", inline=False)
        elif permanent:
            embed.add_field(name="テーマ", value="なし", inline=False)
        embed.add_field(name="言語", inline=False,
                        value=f"{locale_label(room_config.language)}（作成サーバーの言語設定）")
        embed.add_field(name="グロチャ自動接続", inline=False,
                        value="OFF（ONにすると、VC参加時にそのテキストチャンネルもグロチャへ自動接続します）")
        if description:
            embed.add_field(name="説明", value=description, inline=False)
        await r.send(view=_TextChatToggleView(self, room_name, r.user.id, embed))

        # 作成者がボイスチャンネルにいるなら、そのままボットも参加させる
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(
                "ℹ️ ボイスチャンネルに入った状態でルームを作成すると、ボットが自動で参加します。",
                ephemeral=True,
            )
        try:
            await self._connect_room(r.guild, voice.channel, r.user, r.channel, room_name)
        except (_JoinRefused, VoiceBusy) as e:
            await r.send(f"{FAILED} ルームは作成しましたが、VC には参加できませんでした: {e}", ephemeral=True)
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s 作成後の自動参加に失敗しました", room_name, exc_info=True)
            await r.send(f"{FAILED} ルームは作成しましたが、VC への参加に失敗しました: `{e}`", ephemeral=True)
        else:
            await r.send(f"🎙️ **{voice.channel.name}** に参加し、ルーム **{room_name}** に接続しました。")


    async def _room_theme_impl(self, r: Responder, room_name: str, theme_input: str):
        """常設ルームのテーマを変更する（Bot管理者だけ）。

        入力の解釈: 「自動」（または「日替わり」）= 日替わり自動テーマに切り替え、
        「なし」= テーマなし、それ以外はそのテーマで固定する。
        """
        await r.defer()
        if not await self._is_bot_admin(r.user):
            return await r.send(f"{FAILED} 常設ルームのテーマを変更できるのはBot管理者だけです。", ephemeral=True)
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(f"{FAILED} " + room_not_found(room_name), ephemeral=True)
        if not room.permanent:
            return await r.send(f"{FAILED} テーマを変更できるのは常設ルームだけです。", ephemeral=True)

        value = (theme_input or "").strip()
        if not value:
            return await r.send(
                f"{FAILED} テーマを入力してください（「自動」で日替わり、「なし」でテーマなし、"
                "それ以外はそのテーマで固定されます）。", ephemeral=True)
        if value in ("自動", "日替わり"):
            room.theme_auto = True
            room.theme = theme_for(room.name, theme_day(), room.language or "ja")
            result = f"🎯 テーマを日替わり（自動）にしました。今日のテーマは **{room.theme}** です。"
        elif value in ("なし", "無し"):
            room.theme_auto = False
            room.theme = ""
            result = "🎯 テーマをなしにしました。"
        else:
            room.theme_auto = False
            room.theme = value
            result = f"🎯 テーマを **{value}** に固定しました。"
        _persist_rooms()
        await r.send(f"📌 常設ルーム **{room_name}**: {result}")


    async def _text_chat_toggle_impl(self, r: Responder, room_name: str):
        """グロチャ自動接続設定（ルームの text_chat）のトグルViewを開く（/vc の入口 gvc_auto_connect）。

        切り替え自体は _TextChatToggleView が行う。View へは開いた人ではなく
        ルーム作成者のIDを渡す（切り替えられるのは作成者だけ、という
        View 側の判定を入口が増えても保つため）。
        """
        await r.defer()
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"{FAILED} " + room_not_found(room_name), ephemeral=True
            )
        embed = discord.Embed(title=f"🌐 グロチャ自動接続設定: {room_name}", color=0x3498DB)
        embed.add_field(name="グロチャ自動接続", value="ON" if room.text_chat else "OFF", inline=False)
        embed.set_footer(
            text="ON にすると、VC参加時にそのテキストチャンネルもグロチャへ自動接続します")
        await r.send(view=_TextChatToggleView(self, room_name, room.owner_id, embed))

    async def _room_info_impl(self, r: Responder, room_name: str):
        await r.defer()
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"{FAILED} " + room_not_found(room_name), ephemeral=True
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
        embed.add_field(name="種類", value="📌 常設ルーム" if room.permanent else "通常ルーム")
        embed.add_field(name="最大参加サーバー数", value="無制限" if room.max_servers == 0 else str(room.max_servers))
        if room.theme_auto:
            embed.add_field(name="テーマ", value=f"🎯 {room.theme}（自動で毎日変更）", inline=False)
        elif room.theme:
            embed.add_field(name="テーマ", value=f"🎯 {room.theme}", inline=False)
        else:
            embed.add_field(name="テーマ", value="なし", inline=False)
        embed.add_field(name="グロチャ自動接続", value="ON" if room.text_chat else "OFF", inline=False)
        embed.add_field(name="言語", inline=False,
                        value=(locale_label(room.language) if room.language
                               else "指定なし（全言語に表示）"))
        embed.add_field(name="現在の参加者数", value=f"{len(_room_members(room_name))}人")
        embed.add_field(name="現在の参加サーバー数(VC)", value=str(len(servers)))
        if servers:
            embed.add_field(name="接続中のサーバー(VC)", value=", ".join(servers), inline=False)
        embed.add_field(name="グロチャ接続数", value=str(len(chat_channels)))
        if chat_channels:
            embed.add_field(name="グロチャ接続チャンネル", value="\n".join(chat_channels), inline=False)
        if room.description:
            embed.add_field(name="説明", value=room.description, inline=False)
        embed.add_field(name="作成日時", value=f"<t:{int(room.created_at)}:R>", inline=False)
        await r.send(view=as_embed_v2(embed))


    async def _lang_setting_impl(self, r: Responder, raw: str):
        """GVC一覧の表示言語を設定する（サーバー管理権限を持つ人だけ）。

        空欄 = サーバーの言語設定に従う（デフォルト）。all = すべての言語。
        言語コード = その言語のルームだけを表示する。
        """
        await r.defer()
        if r.guild is None:
            return await r.send(f"{FAILED} サーバー内で実行してください。", ephemeral=True)
        perms = getattr(r.user, "guild_permissions", None)
        if not (perms and perms.manage_guild):
            return await r.send(
                f"{FAILED} 言語設定を変更できるのはサーバー管理権限を持つ人だけです。",
                ephemeral=True)
        value = (raw or "").strip().lower()
        store = guild_settings.get_store()
        if value in ("", "サーバー", "同じ", "default", "auto"):
            await store.update(r.guild.id, GVC_SETTINGS_SECTION,
                               **{LANG_OVERRIDE_KEY: None})
            note = "サーバーの言語設定に従います"
        elif value in ("all", "すべて", "全部"):
            await store.update(r.guild.id, GVC_SETTINGS_SECTION,
                               **{LANG_OVERRIDE_KEY: "all"})
            note = "すべての言語のルームを表示します"
        elif value in LOCALE_LABELS:
            await store.update(r.guild.id, GVC_SETTINGS_SECTION,
                               **{LANG_OVERRIDE_KEY: value})
            note = f"{locale_label(value)} のルームだけを表示します"
        else:
            return await r.send(
                f"{FAILED} 言語は ja・en・zh・ko・id・th・ar・hi のいずれか、"
                "または all（すべて）/ 空欄（サーバー設定に従う）で指定してください。",
                ephemeral=True)
        current = effective_filter_lang(r.guild.id)
        current_text = "すべて" if current is None else locale_label(current)
        await r.send(
            f"🌐 GVCの表示言語を設定しました： {note}\n"
            f"現在の表示対象: {current_text}"
            f"（サーバーの言語設定: {locale_label(server_locale(r.guild.id))}）",
            ephemeral=True)


    MEMBERS_BOARD_MAX = 60  # メンバー画像に載せる上限（多い場合は先頭から）

    async def _members_impl(self, r: Responder):
        """このサーバーが参加中のルームについて、GVCに入っている全員を画像で表示する。"""
        await r.defer()
        if r.guild is None:
            return await r.send(f"{FAILED} サーバー内で実行してください。", ephemeral=True)
        room_name = next(
            (name for name, clients in GLOBAL_ROOMS.items()
             if any(c.guild is not None and c.guild.id == r.guild.id for c in clients)),
            None)
        if room_name is None:
            return await r.send(
                f"{FAILED} このサーバーはグローバルVCに参加していません。先にルームへ参加してください。",
                ephemeral=True)

        members = _room_members(room_name)
        if not members:
            return await r.send(f"ルーム **{room_name}** のVCには現在だれもいません。")

        total = len(members)
        shown = members[: self.MEMBERS_BOARD_MAX]
        sections: list = []
        by_guild: dict[str, list] = {}
        for member, guild in shown:
            guild_name = getattr(guild, "name", None) or "不明なサーバー"
            username = str(getattr(member, "name", "") or "")
            by_guild.setdefault(guild_name, []).append(BoardRow(
                user_id=int(member.id),
                # 装飾文字の表示名は盤面フォントで描けないので通常文字へ戻す
                name=board_safe_name(getattr(member, "display_name", None), fallback=username),
                # 「ID」欄には数値IDではなく @ユーザー名 を出す
                value=f"@{username}" if username else str(member.id),
            ))
        sections = list(by_guild.items())
        avatars = await fetch_avatar_bytes(self.bot, [row.user_id for _t, rows in sections for row in rows])
        png = await asyncio.to_thread(
            render_leaderboard_png,
            title=f"GVCメンバー: {room_name}", sections=sections,
            accent=(46, 204, 113), avatars=avatars, podium=False,
            cache_namespace="gvc-members")
        embed = discord.Embed(
            title=f"🌐 GVCメンバー: {room_name}（{total}人）", color=0x2ECC71)
        if total > len(shown):
            embed.description = f"人数が多いため先頭 {len(shown)} 人まで表示しています。"
        embed.set_image(url="attachment://gvc_members.png")
        await r.send(view=as_embed_v2(embed), file=discord.File(io.BytesIO(png), filename="gvc_members.png"))


    async def _room_delete_impl(self, r: Responder, room_name: str):
        await r.defer()
        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"{FAILED} " + room_not_found(room_name), ephemeral=True
            )

        # Bot管理者はどのルームでも削除できる（常設・通常どちらも、作成者でなくても）
        if not await self._is_bot_admin(r.user) and not _can_delete_room(room, r.user, r.guild):
            if room.permanent:
                return await r.send(
                    f"{FAILED} 常設ルームを削除できるのはBot管理者だけです。",
                    ephemeral=True,
                )
            return await r.send(
                f"{FAILED} このルームを削除できるのは、作成者か、ルームを作ったサーバーで"
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
            return await r.send(f"{FAILED} 参加するルーム名を `room` に入れてください。", ephemeral=True)

        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"{FAILED} " + room_not_found(room_name)
                + "先に `/vc` →「グローバルVCルーム」→「ルーム作成」で作成してください。",
                ephemeral=True,
            )

        if room.private and password != room.password:
            return await r.send("🔒 このルームは非公開です。正しいパスワードを指定してください。", ephemeral=True)

        _prune_dead_clients(room_name)
        current_members = GLOBAL_ROOMS.get(room_name, [])
        if room.max_servers and len(current_members) >= room.max_servers:
            return await r.send(f"{FAILED} ルーム **{room_name}** は満員です ({room.max_servers}サーバーまで)。", ephemeral=True)

        if any(vc.guild and vc.guild.id == r.guild.id for vc in current_members):
            return await r.send(f"{FAILED} このサーバーはすでにルーム **{room_name}** に参加しています。", ephemeral=True)

        vc_channel = voice.channel
        await r.defer()

        session = self.voice_sessions.get(r.guild.id)
        if session is not None and session.feature == "global":
            joined = next((name for name, clients in GLOBAL_ROOMS.items()
                           if any(c.guild and c.guild.id == r.guild.id for c in clients)), None)
            return await r.send(
                f"{FAILED} このサーバーはすでにルーム **{joined or '不明'}** に参加しています。"
                "先に退出してください。"
            )

        try:
            await self._connect_room(r.guild, vc_channel, r.user, r.channel, room_name)
        except _JoinRefused as refused:
            return await r.send(f"{FAILED} {refused}")
        except VoiceBusy as busy:
            return await r.send(str(busy))
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s への参加に失敗しました", room_name, exc_info=True)
            return await r.send(voice_connection_failed(e))

        await r.send(f"🌐 ルーム **{room_name}** に参加しました。")


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
