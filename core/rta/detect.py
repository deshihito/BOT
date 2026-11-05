import asyncio
import logging
import re
import socket
import struct
import time
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.api_retry import run_with_retry

from core.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.rta.common import ALLOWED_CHANNEL_TYPES, DISBOARD_BOT_ID, DISOKU_BOT_ID, SABACHA_BOT_ID, TAKASUMI_BOT_ID  # noqa: F401
from core.rta.helpers import _collect_embed_text, _event_time, _parse_dt  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


_JST = timezone(timedelta(hours=9))


def _sabacha_next_time(embeds, event_at):
    """鯖ちゃんねるの成功Embedの第1フィールドから次回可能時刻を読む。読めなければNone。

    対応形式: Discordタイムスタンプ <t:...> / ISO8601 / YYYY/MM/DD HH:MM (JSTとして解釈)。
    イベント時刻より後・24時間以内だけを採用する (外れた値は壊れたデータとして無視)。
    """
    for embed in embeds or ():
        fields = getattr(embed, "fields", ()) or ()
        if not fields:
            continue
        field = fields[0]
        text = " ".join(str(getattr(field, attr, "") or "") for attr in ("name", "value"))
        candidate = None
        match = re.search(r"<t:(\d+)", text)
        if match:
            candidate = datetime.fromtimestamp(int(match.group(1)), tz=timezone.utc)
        else:
            match = re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?", text)
            if match:
                raw = match.group(0)
                parsed = _parse_dt(raw)
                if parsed is not None:
                    candidate = parsed
                else:
                    try:
                        naive = datetime.strptime(raw.replace("/", "-").replace("T", " "), "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        try:
                            naive = datetime.strptime(raw.replace("/", "-").replace("T", " "), "%Y-%m-%d %H:%M")
                        except ValueError:
                            naive = None
                    if naive is not None:
                        candidate = naive.replace(tzinfo=_JST)
        if candidate is not None and event_at < candidate <= event_at + timedelta(hours=24):
            return candidate
        return None
    return None


def detect_event(message):
    """Return (kind, user_id, event_at, due_at) for an official successful service embed.

    The event time is the Snowflake timestamp of the message (or of its edit for
    deferred responses); see ``REMINDER_ANCHOR``.  ``due_at`` is set only when
    the service itself states the next available time (鯖ちゃんねる); otherwise
    None and the caller adds ``COOLDOWN[kind]``.
    """
    if not getattr(message, "guild", None):
        return None
    channel_type = getattr(getattr(message, "channel", None), "type", None)
    if channel_type not in ALLOWED_CHANNEL_TYPES:
        return None
    author = getattr(message, "author", None)
    author_id = getattr(author, "id", None)
    application_id = getattr(message, "application_id", None)
    has_embeds = bool(getattr(message, "embeds", None))
    if author_id not in (DISBOARD_BOT_ID, DISOKU_BOT_ID) and not has_embeds:
        return None

    text = _collect_embed_text(message)
    folded = text.casefold()
    # Dis速-specific signature from the real response: application/webhook ID,
    # the official embed title/URL, and the server-name field ending in
    # 「をアップしたよ!」. Do not depend on message.content or /up being present.
    embeds = getattr(message, "embeds", ()) or ()
    disoku_signature = any(
        getattr(embed, "title", "") == "ディス速 | Discordサーバー・友達募集・ボット掲示板"
        and getattr(embed, "url", "") == "https://dissoku.net/ja"
        and any(
            "をアップしたよ" in (getattr(field, "name", "") or "")
            for field in (getattr(embed, "fields", ()) or ())
        )
        for embed in embeds
    )
    app_ids = {
        str(value) for value in (
            author_id,
            getattr(message, "application_id", None),
            getattr(message, "webhook_id", None),
        ) if value is not None
    }
    app_id_set = {int(value) for value in app_ids if value.isdigit()}
    is_disoku = DISOKU_BOT_ID in app_id_set and disoku_signature
    is_disboard = author_id == DISBOARD_BOT_ID
    # 鯖ちゃんねる: 送信者Bot ID + 成功Embedフッター 'voted'
    is_sabacha = SABACHA_BOT_ID in app_id_set and any(
        "voted" in (getattr(getattr(embed, "footer", None), "text", "") or "")
        for embed in embeds
    )
    # TakasumiBOT: 送信者Bot ID + Embed本文の成功文 (実地観測 2026-11-05)
    is_takasumi = TAKASUMI_BOT_ID in app_id_set and any(
        "UPしました" in (getattr(embed, "description", "") or "")
        and "表示順位が更新されました" in (getattr(embed, "description", "") or "")
        for embed in embeds
    )
    if not (is_disboard or is_disoku or is_sabacha or is_takasumi):
        return None


    if is_sabacha:
        kind = "vote"
    elif is_takasumi:
        kind = "takasumi"
    elif is_disboard:
        if "表示順をアップしたよ" not in text and "bump done" not in folded:
            return None
        kind = "bump"
    else:
        # Dis速 may describe a successful bump without including "/up" in the
        # embed text.  The brand/app check above scopes these phrases to its response.
        if not any(phrase in folded for phrase in (
            "アップしたよ", "をアップ", "アップしました", "アップ完了", "up done", "bump done"
        )):
            logger.info(
                "Disoku message ignored (no recognized success phrase): message=%s text=%r",
                getattr(message, "id", None), text[:1500],
            )
            return None
        kind = "up"

    metadata = getattr(message, "interaction_metadata", None)
    if metadata is not None and getattr(metadata, "type", None) not in (
        None, discord.InteractionType.application_command
    ):
        logger.info("Ignored non-application_command type: %s", getattr(metadata, "type", None))
        return None
    user = getattr(metadata, "user", None)
    user_id = getattr(user, "id", None)
    if user_id is None:
        legacy_interaction = getattr(message, "interaction", None)
        user_id = getattr(getattr(legacy_interaction, "user", None), "id", None)
    try:
        event_at = _event_time(message)
    except (TypeError, ValueError, OverflowError):
        logger.exception("Could not decode message Snowflake timestamp: %s", getattr(message, "id", None))
        return None
    due_at = _sabacha_next_time(embeds, event_at) if kind == "vote" else None
    return kind, int(user_id) if user_id is not None else None, event_at, due_at
