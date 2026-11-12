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

from cogs.support import MAX_CLEAR
from cogs.support import get_intro_webhook, sanitize_webhook_name, role_failure_reason
from core.channel_safety import channel_display_name
from core.support import guild_settings
from core.general import action_usage
from core.support.usage_stats import usage_stats
from core.support.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2
from core.support.messages import CALLBACK_ERROR

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
    追加のエラー通知は誤報になる（core/support/panel_v2.py の on_error と同じ扱い）。
    """
    if isinstance(error, discord.InteractionResponded):
        logger.debug("%s: 応答済みのためエラーを握ります", context)
        return
    logger.exception("%s", context)
    try:
        if interaction.response.is_done():
            await interaction.followup.send(
                CALLBACK_ERROR,
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                CALLBACK_ERROR,
                ephemeral=True,
            )
    except discord.HTTPException:
        logger.exception("コールバックのエラー通知にも失敗しました: %s", context)


SUPPORT_ACTIONS = [
    app_commands.Choice(name="Muted", value="muted"),
    app_commands.Choice(name="Muted設定", value="muted_settings"),
    app_commands.Choice(name="匿名つぶやきパネル", value="whisper"),
    app_commands.Choice(name="Stickyパネル", value="sticky"),
    app_commands.Choice(name="メッセージ削除", value="clear"),
    app_commands.Choice(name="一括ロール付与・剥奪", value="role_bulk"),
    # boardNotify 再編: 旧 bumprta_status/on/off/role は正リストから外し、
    # サービス別入口（boardnotify ジャンル）＋共通設定に置き換える。
    # 旧 value は entry.py の dispatch 互換分岐で従来どおり動作する。
    app_commands.Choice(name="DISBOARD", value="bumprta_bump"),
    app_commands.Choice(name="ディス速", value="bumprta_up"),
    app_commands.Choice(name="鯖ちゃんねる", value="bumprta_vote"),
    app_commands.Choice(name="TakasumiBOT", value="bumprta_takasumi"),
    app_commands.Choice(name="Dicoall", value="bumprta_dicoall"),
    app_commands.Choice(name="Discord Cafe", value="bumprta_dcafe"),
    app_commands.Choice(name="SharkBot", value="bumprta_sharkbot"),
    app_commands.Choice(name="DiscordServers.io", value="bumprta_dsio"),
    app_commands.Choice(name="DISCOM", value="bumprta_discom"),
    app_commands.Choice(name="boardNotify設定（共通）", value="bumprta_settings"),
    app_commands.Choice(name="絵文字便乗設定（binjou）", value="binjou"),
    app_commands.Choice(name="カスタム便乗ルール", value="binjou_custom"),
    app_commands.Choice(name="抽選（giveaway）", value="giveaway"),
    app_commands.Choice(name="VC入退室履歴", value="vc_log"),
    app_commands.Choice(name="メッセージ編集履歴", value="message_log"),
    app_commands.Choice(name="モデレート履歴（TO/KICK/BAN）", value="moderation_log"),
    app_commands.Choice(name="ハニーポット", value="honeypot"),
    app_commands.Choice(name="チケットツール", value="ticket"),
    app_commands.Choice(name="チケット種別", value="ticket_types"),
    app_commands.Choice(name="チケット記録（トランスクリプト）", value="ticket_transcript"),
    app_commands.Choice(name="チケット担当アサイン", value="ticket_assign"),
    app_commands.Choice(name="認証パネル作成", value="auth_panel"),
    app_commands.Choice(name="認証フォーム質問編集", value="auth_questions"),
    app_commands.Choice(name="ロールパネル作成", value="role_panel"),
    app_commands.Choice(name="言語設定", value="language"),
    app_commands.Choice(name="グローバルチャット", value="globalchat"),
    app_commands.Choice(name="グローバルチャット モデレーション", value="globalchat_mod"),
    app_commands.Choice(name="Auto react設定", value="auto_react"),
    # SNS 再編: 旧 sns_notify は正リストから外し、プラットフォーム別入口
    # （sns ジャンル）に置き換える。旧 value は dispatch 互換で従来パネルを開く。
    app_commands.Choice(name="YouTube通知", value="sns_youtube"),
    app_commands.Choice(name="X通知", value="sns_x"),
    app_commands.Choice(name="GitHub通知", value="sns_github"),
    app_commands.Choice(name="RSS通知", value="sns_rss"),
    app_commands.Choice(name="YouTubeライブ通知", value="sns_youtube_live"),
    app_commands.Choice(name="地震情報", value="earthquake"),
    app_commands.Choice(name="ニュース通知", value="news_notify"),
    app_commands.Choice(name="Quest通知（Discord Orbs）", value="quest_notify"),
    app_commands.Choice(name="Quest手動投稿", value="quest_manual"),
    app_commands.Choice(name="レベルアップ通知（EXP）", value="levelup_notify"),
    app_commands.Choice(name="レベルアップカードテーマ", value="levelup_card_theme"),
    # サーバーアシスト再編: 旧ハブ（server_assist）は廃止し、各機能を
    # assist_<key> の一級アクションとしてジャンルへ配置する。値とラベルは
    # core/support/server_assist/features の FEATURE と一致させること
    # （tests/test_server_assist.py が対応を固定する）。並びは機能の表示順。
    app_commands.Choice(name="参加・退出メッセージ", value="assist_welcome"),
    app_commands.Choice(name="退出メッセージ", value="assist_goodbye"),
    app_commands.Choice(name="自動ロール", value="assist_autorole"),
    app_commands.Choice(name="Starboard", value="assist_starboard"),
    app_commands.Choice(name="レベル報酬", value="assist_leveling"),
    app_commands.Choice(name="一時VC", value="assist_tempvoice"),
    app_commands.Choice(name="一時VC操作パネル", value="tempvoice_panel"),
    app_commands.Choice(name="提案箱", value="assist_suggestions"),
    app_commands.Choice(name="AutoMod", value="assist_automod"),
    app_commands.Choice(name="投票", value="assist_polls"),
    app_commands.Choice(name="サーバーログ", value="assist_serverlog"),
    app_commands.Choice(name="自動スレッド", value="assist_autothread"),
    app_commands.Choice(name="サーバースタッツ", value="assist_stats"),
    app_commands.Choice(name="埋め込みビルダー", value="assist_embed"),
    app_commands.Choice(name="埋め込みテンプレート管理", value="assist_embed_templates"),
    app_commands.Choice(name="Webhookビルダー", value="assist_webhook"),
    app_commands.Choice(name="タイマー告知", value="assist_timed"),
    app_commands.Choice(name="一回限りリマインダー", value="assist_reminder"),
    app_commands.Choice(name="警告", value="assist_warnings"),
    app_commands.Choice(name="警告エスカレーション", value="assist_warning_escalation"),
    app_commands.Choice(name="招待トラッカー", value="assist_invites"),
    app_commands.Choice(name="自動リアクション", value="assist_autoreact"),
    app_commands.Choice(name="イベント", value="assist_events"),
    app_commands.Choice(name="公式イベント連携", value="assist_events_link"),
    app_commands.Choice(name="リアクションロール", value="assist_reactionroles"),
    app_commands.Choice(name="ロール復元", value="assist_stickyroles"),
    app_commands.Choice(name="カスタム返信", value="assist_customreplies"),
    app_commands.Choice(name="常駐しりとり", value="assist_shiritori_resident"),
    app_commands.Choice(name="Luna AI", value="assist_luna_ai"),
    app_commands.Choice(name="応募フォーム", value="assist_applications"),
    app_commands.Choice(name="応募審査", value="assist_application_review"),
    app_commands.Choice(name="音声トリガーのサーバー設定", value="voice_trigger"),
    app_commands.Choice(name="VC参加時の自動開始", value="vc_auto_start"),
    app_commands.Choice(name="BOT fixer", value="bot_fixer"),
    app_commands.Choice(name="他ボット制限（BOT fixer）", value="bot_fixer_bots"),
    app_commands.Choice(name="コマンドレート制限（BOT fixer）", value="bot_fixer_rates"),
    app_commands.Choice(name="即抜けRTA状態", value="sokunuke_status"),
    app_commands.Choice(name="即抜けRTA計測オン", value="sokunuke_on"),
    app_commands.Choice(name="即抜けRTA計測オフ", value="sokunuke_off"),
    app_commands.Choice(name="VC自動参加オン", value="sokunuke_vc_on"),
    app_commands.Choice(name="VC自動参加オフ", value="sokunuke_vc_off"),
    app_commands.Choice(name="人物分析", value="person_analysis"),
    app_commands.Choice(name="サーバー分析", value="server_analytics"),
]

# ジャンル説明は、ラベルや配下の機能名から読み取れない情報がある場合だけ書く。
# 機能名の列挙は書かない（空文字 = 説明なし）。
SUPPORT_GENRES = {
    "moderation": ("モデレーション", ""),
    "roles": ("ロール・認証", ""),
    "logs": ("履歴・ログ", ""),
    "automation": ("自動化・通知", ""),
    "rta": ("RTA設定", ""),
    "boardnotify": ("boardNotify", ""),
    "sns": ("SNS通知", ""),
    "analysis": ("分析", ""),
}

# 旧バージョンで保存されたショートカットを新しいジャンルへ移行する。
# "assist" は再編で廃止した旧サーバーアシストジャンル（配下機能の大半の受け皿）。
SUPPORT_GENRE_ALIASES = {"server": "roles", "notify": "automation", "bumprta": "rta", "sokunuke": "rta", "language": "automation", "event": "moderation", "assist": "automation"}

_SUPPORT_ACTION_BY_VALUE = {choice.value: (choice.name, choice.value) for choice in SUPPORT_ACTIONS}


def _support_actions(*values: str) -> list[tuple[str, str]]:
    return [_SUPPORT_ACTION_BY_VALUE[value] for value in values]


SUPPORT_ACTIONS_BY_GENRE = {
    "moderation": _support_actions(
        "muted", "muted_settings", "whisper", "sticky", "clear", "honeypot", "ticket",
        "ticket_types", "ticket_transcript", "ticket_assign", "giveaway", "bot_fixer",
        "bot_fixer_bots", "bot_fixer_rates",
        "assist_automod", "assist_warnings", "assist_applications",
    ),
    "roles": _support_actions(
        "role_bulk", "auth_panel", "auth_questions", "role_panel",
        "assist_autorole", "assist_leveling", "assist_reactionroles", "assist_stickyroles",
    ),
    "logs": _support_actions(
        "vc_log", "message_log", "moderation_log",
        "assist_serverlog", "assist_invites",
    ),
    # 自動化・通知は36件あり、パネル側はページング（25件/ページ）で全件選べる。
    # assist_warning_escalation / assist_application_review は、元機能
    # （警告・応募フォーム）が moderation 側にあるが、preset 入口は
    # 「自動化・通知」の分割としてここに置く（36件構成）。
    "automation": _support_actions(
        "binjou", "binjou_custom", "auto_react", "levelup_notify", "levelup_card_theme",
        "voice_trigger", "quest_notify", "quest_manual", "earthquake", "news_notify", "language", "globalchat", "globalchat_mod",
        "vc_auto_start",
        "assist_welcome", "assist_goodbye", "assist_starboard", "assist_tempvoice", "tempvoice_panel",
        "assist_suggestions",
        "assist_polls", "assist_autothread", "assist_stats", "assist_embed", "assist_embed_templates",
        "assist_webhook",
        "assist_timed", "assist_reminder", "assist_autoreact", "assist_events", "assist_events_link",
        "assist_customreplies",
        "assist_shiritori_resident", "assist_luna_ai", "assist_warning_escalation", "assist_application_review",
    ),
    "rta": _support_actions(
        "sokunuke_status", "sokunuke_on",
        "sokunuke_off", "sokunuke_vc_on", "sokunuke_vc_off",
    ),
    "boardnotify": _support_actions(
        "bumprta_bump", "bumprta_up", "bumprta_vote", "bumprta_takasumi",
        "bumprta_dicoall", "bumprta_dcafe", "bumprta_sharkbot", "bumprta_dsio",
        "bumprta_discom", "bumprta_settings",
    ),
    "sns": _support_actions(
        "sns_youtube", "sns_x", "sns_github", "sns_rss", "sns_youtube_live",
    ),
    "analysis": _support_actions(
        "person_analysis",
        "server_analytics",
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


def can_manage_guild(interaction: discord.Interaction) -> bool:
    """設定パネルの操作権限（サーバー管理 or 管理者）の正。"""
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(
        getattr(permissions, "manage_guild", False)
        or getattr(permissions, "administrator", False)
    )


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
            f"{member.mention} が **{discord.utils.escape_markdown(channel_display_name(channel))}** "
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
