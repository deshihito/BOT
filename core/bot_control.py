# -*- coding: utf-8 -*-
"""BOT fixer ②: 他ボット発言制限（/support「モデレーション」>「BOT fixer」）。

ギルド管理者が、サーバー内の他のボットの発言を制限するための判定と執行。
設定は GuildSettings の ``bot_control`` セクションに、対象ボットの
ユーザーID（文字列）-> {"allowed_channel_ids": [...], "rate": {...} | None}
の形で保存する。

執行は on_message リスナーから ``enforce_message`` を呼ぶ:
- 許可チャンネル外の発言を削除する
- レート設定がある場合、期間内の上限超過分の発言を削除する

安全策:
- AGO BOT 自身は絶対に対象にしない
- Webhook 経由のメッセージは対象外（自動翻訳の再投稿などを壊さない）
- DM は対象外。内容ベースの判定はしない（著者・チャンネル・件数だけ）ので
  Message Content Intent には依存しない
- 許可チャンネルが1件も無いエントリは成立しない（全チャンネルで消える事故防止）
- 権限不足や削除失敗はログのみで、他の処理を止めない

レートのカウンタはメモリ内（再起動でリセットされる）。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from core.command_control import RATE_MAX_COUNT, RATE_MAX_WINDOW_SECONDS, RateCounter

logger = logging.getLogger(__name__)

BOT_CONTROL_SECTION = "bot_control"

_counter = RateCounter()


def _clean_rate(rule: Any) -> Optional[dict[str, int]]:
    if not isinstance(rule, dict):
        return None
    try:
        count = int(rule.get("count"))
        window = int(rule.get("window_seconds"))
    except (TypeError, ValueError):
        return None
    if 1 <= count <= RATE_MAX_COUNT and 1 <= window <= RATE_MAX_WINDOW_SECONDS:
        return {"count": count, "window_seconds": window}
    return None


def _clean_channel_ids(values: Any) -> list[int]:
    cleaned: list[int] = []
    seen: set[int] = set()
    for value in values or []:
        try:
            channel_id = int(value)
        except (TypeError, ValueError):
            continue
        if channel_id > 0 and channel_id not in seen:
            seen.add(channel_id)
            cleaned.append(channel_id)
    return cleaned


def normalize_settings(raw: Any) -> dict[str, dict[str, Any]]:
    """保存済みの生 dict を検証済み設定に整える。

    許可チャンネルが空のエントリは落とす（全チャンネルで発言が消える
    事故を防ぐため、そのようなエントリは存在できない）。
    """
    if not isinstance(raw, dict):
        return {}
    cleaned: dict[str, dict[str, Any]] = {}
    for bot_id, entry in raw.items():
        try:
            bot_key = str(int(bot_id))
        except (TypeError, ValueError):
            continue
        if not isinstance(entry, dict):
            continue
        channels = _clean_channel_ids(entry.get("allowed_channel_ids"))
        if not channels:
            continue
        cleaned[bot_key] = {
            "allowed_channel_ids": channels,
            "rate": _clean_rate(entry.get("rate")),
        }
    return cleaned


def get_settings(store, guild_id: int) -> dict[str, dict[str, Any]]:
    """GuildSettings ストアから検証済みのボット制限設定を読む（未設定なら空）。"""
    return normalize_settings(store.get(guild_id, BOT_CONTROL_SECTION))


def plan(settings: dict[str, dict[str, Any]], *, guild_id: int, bot_id: int,
         channel_id: int, counter: Optional[RateCounter] = None,
         now: Optional[float] = None) -> Optional[str]:
    """削除すべきなら理由（"channel" / "rate"）、しなければ None を返す純粋判定。"""
    entry = settings.get(str(bot_id))
    if entry is None:
        return None
    if channel_id not in entry["allowed_channel_ids"]:
        return "channel"
    rule = entry.get("rate")
    if rule:
        counter = counter or _counter
        retry = counter.check_and_record(
            guild_id, bot_id, "bot_control", rule["count"], rule["window_seconds"], now=now)
        if retry is not None:
            return "rate"
    return None


async def enforce_message(self_bot_id: Optional[int], message, store=None) -> bool:
    """対象ボットの発言なら削除を試みる。削除したら True。

    どの段階で失敗しても例外を外へ出さず、他の on_message 処理を止めない。
    """
    try:
        guild = getattr(message, "guild", None)
        if guild is None:
            return False
        if getattr(message, "webhook_id", None):
            return False
        author = getattr(message, "author", None)
        if author is None or not getattr(author, "bot", False):
            return False
        if self_bot_id is not None and getattr(author, "id", None) == self_bot_id:
            return False
        if store is None:
            from core import guild_settings

            store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_settings(store, guild.id)
        if not settings:
            return False
        reason = plan(settings, guild_id=guild.id, bot_id=author.id,
                      channel_id=message.channel.id)
        if reason is None:
            return False
        try:
            await message.delete()
        except Exception:
            logger.warning(
                "ボット制限: 発言を削除できませんでした (guild=%s bot=%s reason=%s)",
                guild.id, author.id, reason, exc_info=True)
            return False
        logger.info(
            "ボット制限: 発言を削除しました (guild=%s bot=%s reason=%s)",
            guild.id, author.id, reason)
        return True
    except Exception:
        logger.exception("ボット制限の執行に失敗しました（通常処理を続行）")
        return False
