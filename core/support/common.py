# -*- coding: utf-8 -*-
"""サポート機能の共通基盤（定数・設定取得・共通ヘルパー）。

元 cogs/support.py の冒頭部。ログ名は分割前と揃えて cogs.support のままにする。"""
from __future__ import annotations

from __future__ import annotations

import asyncio
import html as _html
import inspect
import json
import logging
import os
import random
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlparse

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands, tasks

from cogs.clear import MAX_CLEAR
from cogs.auth import get_intro_webhook, sanitize_webhook_name, role_failure_reason
from core import action_usage, guild_settings
from core.support import usage_stats
from core.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2

logger = logging.getLogger("cogs.support")  # 分割後も従来のログ名に統一する


async def edit_interaction_message(interaction: discord.Interaction, **kwargs):
    """未応答なら初回応答で、defer済みなら元の応答を編集する。"""
    if interaction.response.is_done():
        return await interaction.edit_original_response(**kwargs)
    return await interaction.response.edit_message(**kwargs)


async def report_callback_error(interaction: discord.Interaction, context: str,
                                error: Exception | None = None):
    """コールバック例外をログに残し、可能ならユーザーにも通知する。

    ``error`` が ``InteractionResponded`` のときは通知しない。その時点で
    panel_recovery か callback 自身の先行処理が既に応答を届けており、
    追加のエラー通知は誤報になる（core/panel_v2.py の on_error と同じ扱い）。
    """
    if isinstance(error, discord.InteractionResponded):
        logger.debug("%s: 応答済みのためエラーを握ります", context)
        return
    logger.exception("%s", context)
    try:
        if interaction.response.is_done():
            await interaction.followup.send(
                "処理中にエラーが発生しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                "処理中にエラーが発生しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                ephemeral=True,
            )
    except discord.HTTPException:
        logger.exception("コールバックのエラー通知にも失敗しました: %s", context)


SUPPORT_ACTIONS = [
    app_commands.Choice(name="Muted設定", value="muted"),
    app_commands.Choice(name="匿名つぶやきパネル", value="whisper"),
    app_commands.Choice(name="Stickyパネル", value="sticky"),
    app_commands.Choice(name="メッセージ削除", value="clear"),
    app_commands.Choice(name="一括ロール付与・剥奪", value="role_bulk"),
    app_commands.Choice(name="bump/up通知・RTA状態", value="bumprta_status"),
    app_commands.Choice(name="bump/up通知・RTAオン", value="bumprta_on"),
    app_commands.Choice(name="bump/up通知・RTAオフ", value="bumprta_off"),
    app_commands.Choice(name="bump/up通知メンションロール", value="bumprta_role"),
    app_commands.Choice(name="絵文字便乗設定（binjou）", value="binjou"),
    app_commands.Choice(name="抽選（giveaway）", value="giveaway"),
    app_commands.Choice(name="VC入退室履歴", value="vc_log"),
    app_commands.Choice(name="メッセージ編集履歴", value="message_log"),
    app_commands.Choice(name="モデレート履歴（TO/KICK/BAN）", value="moderation_log"),
    app_commands.Choice(name="ハニーポット", value="honeypot"),
    app_commands.Choice(name="チケットツール", value="ticket"),
    app_commands.Choice(name="認証パネル作成", value="auth_panel"),
    app_commands.Choice(name="ロールパネル作成", value="role_panel"),
    app_commands.Choice(name="言語設定", value="language"),
    app_commands.Choice(name="Auto react設定", value="auto_react"),
    app_commands.Choice(name="SNS新着通知（X・YouTube・GitHub）", value="sns_notify"),
    app_commands.Choice(name="Quest通知（Discord Orbs）", value="quest_notify"),
    app_commands.Choice(name="レベルアップ通知（EXP）", value="levelup_notify"),
    app_commands.Choice(name="サーバーアシスト設定", value="server_assist"),
    app_commands.Choice(name="音声トリガーのサーバー設定", value="voice_trigger"),
    app_commands.Choice(name="即抜けRTA状態", value="sokunuke_status"),
    app_commands.Choice(name="即抜けRTA計測オン", value="sokunuke_on"),
    app_commands.Choice(name="即抜けRTA計測オフ", value="sokunuke_off"),
    app_commands.Choice(name="VC自動参加オン", value="sokunuke_vc_on"),
    app_commands.Choice(name="VC自動参加オフ", value="sokunuke_vc_off"),
]

# ジャンル説明は、ラベルや配下の機能名から読み取れない情報がある場合だけ書く。
# 機能名の列挙は書かない（空文字 = 説明なし）。
SUPPORT_GENRES = {
    "moderation": ("モデレーション", ""),
    "roles": ("ロール・認証", ""),
    "logs": ("履歴・ログ", ""),
    "automation": ("自動化・通知", ""),
    "assist": (
        "サーバーアシスト",
        "サーバー運営の細かな設定をまとめた入口",
    ),
    "rta": ("RTA設定", ""),
}

# 旧バージョンで保存されたショートカットを新しいジャンルへ移行する。
SUPPORT_GENRE_ALIASES = {"server": "roles", "notify": "automation", "bumprta": "rta", "sokunuke": "rta", "language": "automation", "event": "moderation"}

_SUPPORT_ACTION_BY_VALUE = {choice.value: (choice.name, choice.value) for choice in SUPPORT_ACTIONS}


def _support_actions(*values: str) -> list[tuple[str, str]]:
    return [_SUPPORT_ACTION_BY_VALUE[value] for value in values]


SUPPORT_ACTIONS_BY_GENRE = {
    "moderation": _support_actions("muted", "whisper", "sticky", "clear", "honeypot", "ticket", "giveaway"),
    "roles": _support_actions("role_bulk", "auth_panel", "role_panel"),
    "logs": _support_actions("vc_log", "message_log", "moderation_log"),
    "automation": _support_actions("binjou", "auto_react", "levelup_notify", "voice_trigger", "sns_notify", "quest_notify", "language"),
    "assist": _support_actions("server_assist"),
    "rta": _support_actions(
        "bumprta_status", "bumprta_on", "bumprta_off", "bumprta_role", "sokunuke_status", "sokunuke_on",
        "sokunuke_off", "sokunuke_vc_on", "sokunuke_vc_off",
    ),
}

THINKING_SECTION = "thinking_reaction"
BINJOU_SECTION = "binjou"
VC_LOG_SECTION = "vc_log"
MESSAGE_LOG_SECTION = "message_log"
MODERATION_LOG_SECTION = "moderation_log"
STICKY_SECTION = "sticky"
AUTH_SECTION = "auth"
ROLE_PANEL_SECTION = "role_panel"
HONEYPOT_SECTION = "honeypot"
AUTO_REACT_SECTION = "auto_react"
VOICE_TRIGGER_SETTINGS_SECTION = "voice_trigger"

AUTH_MODE_SIMPLE = "simple"
AUTH_MODE_FORM = "form"
AUTH_MAX_QUESTIONS = 5
ROLE_PANEL_MAX_ROLES = 25

THINKING_EMOJI = discord.PartialEmoji(name="thinking", id=1561695212814995596)
BINJOU_DEFAULTS = {"thinking": True, "thumbsup": True}

AUTH_DEFAULT_QUESTIONS = [
    {
        "label": "あだ名はなんですか？(20文字以内)",
        "placeholder": "20文字以内で入力",
        "max_length": 20,
        "style": "short",
        "required": True,
    },
]


def _support_int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def normalize_auth_questions(value) -> list[dict]:
    if not isinstance(value, list):
        return []

    result: list[dict] = []
    for item in value[:AUTH_MAX_QUESTIONS]:
        if not isinstance(item, dict):
            continue

        label = str(item.get("label") or "").strip()
        if not label:
            continue

        placeholder = str(item.get("placeholder") or "").strip()
        max_length = _support_int(item.get("max_length")) or 200
        max_length = max(1, min(1000, max_length))

        style_raw = str(item.get("style") or "short").strip().lower()
        style = "paragraph" if style_raw in {"paragraph", "long", "長い"} else "short"

        required = item.get("required", True)
        if not isinstance(required, bool):
            required = True

        result.append(
            {
                "label": label[:45],
                "placeholder": placeholder[:100],
                "max_length": max_length,
                "style": style,
                "required": required,
            }
        )

    return result


def get_auth_settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, AUTH_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else True

    mode = raw.get("mode")
    if mode not in {AUTH_MODE_SIMPLE, AUTH_MODE_FORM}:
        mode = AUTH_MODE_FORM

    role_id = _support_int(raw.get("role_id"))
    intro_channel_id = _support_int(raw.get("intro_channel_id"))
    panel_channel_id = _support_int(raw.get("panel_channel_id"))

    raw_questions = raw.get("questions")
    if raw_questions is None:
        questions = normalize_auth_questions(AUTH_DEFAULT_QUESTIONS)
    else:
        questions = normalize_auth_questions(raw_questions)

    return {
        "enabled": enabled,
        "mode": mode,
        "role_id": role_id,
        "intro_channel_id": intro_channel_id,
        "panel_channel_id": panel_channel_id,
        "questions": questions,
    }


def get_role_panel_settings(store, guild_id: int) -> dict:
    """ロールパネル設定。未設定時はオン・送信先なし・ロールなし。"""
    raw = store.get(guild_id, ROLE_PANEL_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else True
    panel_channel_id = _support_int(raw.get("panel_channel_id"))

    raw_roles = raw.get("roles")
    roles: list[int] = []
    if isinstance(raw_roles, list):
        for value in raw_roles:
            role_id = _support_int(value)
            if role_id is None or role_id in roles:
                continue
            roles.append(role_id)
            if len(roles) >= ROLE_PANEL_MAX_ROLES:
                break

    return {
        "enabled": enabled,
        "panel_channel_id": panel_channel_id,
        "roles": roles,
    }


def assignable_role_error(guild: discord.Guild, role: discord.Role | None, action: str = "付与") -> str | None:
    if role is None:
        return "対象ロールが見つかりません。"

    if role.is_default():
        return "@everyone ロールは使用できません。"

    if getattr(role, "managed", False):
        return "連携サービスが管理するロールは使用できません。"

    me = getattr(guild, "me", None)
    permissions = getattr(getattr(me, "guild_permissions", None), "manage_roles", False)
    if me is None or not permissions:
        return "Botに「ロールの管理」権限がありません。"

    if role >= me.top_role:
        return f"Botより上位、または同順位のロールは{action}できません。"

    return None


def can_manage_support_panel(interaction: discord.Interaction) -> bool:
    """認証パネル・ロールパネルの設定を操作できるか。既定: 管理者権限のみ。"""
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(getattr(permissions, "administrator", False))


def can_manage_auth_panel(interaction: discord.Interaction) -> bool:
    return can_manage_support_panel(interaction)


def can_manage_role_panel(interaction: discord.Interaction) -> bool:
    return can_manage_support_panel(interaction)


def get_sticky_settings(store, guild_id: int) -> dict[str, int | str | bool | None]:
    """Stickyパネル設定。未設定時はオフ・送信先なし・文言なし。"""
    raw = store.get(guild_id, STICKY_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    message_id = raw.get("message_id")
    if not isinstance(message_id, int) or isinstance(message_id, bool):
        message_id = None

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False
    content = raw.get("content") if isinstance(raw.get("content"), str) else ""

    return {
        "enabled": enabled,
        "channel_id": channel_id,
        "message_id": message_id,
        "content": content,
    }


def self_clip(value, limit=1024):
    text = str(value or "(内容なし)")
    return text if len(text) <= limit else text[:limit - 1] + "…"


def mention_with_id(user) -> str:
    if user is None:
        return "不明"
    mention = getattr(user, "mention", None) or getattr(user, "name", None) or str(user)
    return f"{mention} (`{getattr(user, 'id', '不明')}`)"


def get_vc_log_settings(store, guild_id: int) -> dict[str, int | bool | None]:
    """VC入退室ログ設定。未設定時はオフ・送信先なし。"""
    raw = store.get(guild_id, VC_LOG_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    return {"enabled": enabled, "channel_id": channel_id}


def vc_log_embed(member: discord.Member, channel: discord.VoiceChannel, joined: bool) -> discord.Embed:
    action = "入室しました" if joined else "退室しました"
    embed = discord.Embed(
        title="VC入室" if joined else "VC退室",
        description=(
            f"{member.mention} が **{discord.utils.escape_markdown(channel.name)}** "
            f"{'に' if joined else 'から'}{action}。"
        ),
        color=0x2ECC71 if joined else 0xE74C3C,
        timestamp=discord.utils.utcnow(),
    )
    avatar = getattr(member, "display_avatar", None)
    if avatar is not None:
        embed.set_author(name=member.display_name, icon_url=avatar.url)
    return embed


def get_activity_log_settings(store, guild_id: int, section: str) -> dict[str, int | bool | None]:
    """メッセージ・モデレート履歴の共通設定を返す。未設定時はオフ。"""
    raw = store.get(guild_id, section)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    settings = {"enabled": enabled, "channel_id": channel_id}

    if section == MODERATION_LOG_SECTION:
        for action in ("timeout", "kick", "ban"):
            key = f"{action}_enabled"
            settings[key] = raw.get(key) if isinstance(raw.get(key), bool) else False

    return settings


def get_voice_trigger_settings(store, guild_id: int) -> dict:
    """音声トリガー設定。未設定時は管理者のみ操作可能。"""
    raw = store.get(guild_id, VOICE_TRIGGER_SETTINGS_SECTION)
    if not isinstance(raw, dict):
        raw = {}
    permission = raw.get("permission")
    if permission not in {"admin", "everyone"}:
        permission = "admin"
    return {"permission": permission}
