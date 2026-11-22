# -*- coding: utf-8 -*-
"""コメントガチャのサーバー単位設定（/support「自動化」>「コメントガチャ」）。

従来は設定なしの常時オンだったが、サーバー管理者が制限できるよう
GuildSettings の ``commentgacha`` セクションに保存する。未設定の
サーバーは従来どおり（有効・クールダウン1秒・ブラックリストなし）。

- enabled: サーバー全体のオン/オフ
- cooldown_seconds: 発動チャンネル単位のクールダウン（プリセットのみ）
- blocked_source_channel_ids: 掘り返し元にできないチャンネル（最大25）
- blocked_trigger_channel_ids: 発動自体を無視するチャンネル（最大25）

読み取りはフェイルオープン: 設定の読み込みに失敗しても通常動作を
止めない（BOT fixer の guard と同じ方針）。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("cogs.commentgacha")

SECTION = "commentgacha"

COOLDOWN_PRESETS: tuple[int, ...] = (0, 1, 5, 10, 30, 60, 300)
COOLDOWN_LABELS = {
    0: "なし",
    1: "1秒",
    5: "5秒",
    10: "10秒",
    30: "30秒",
    60: "60秒",
    300: "5分",
}
DEFAULT_COOLDOWN_SECONDS = 1
MAX_BLOCKED_CHANNELS = 25

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "cooldown_seconds": DEFAULT_COOLDOWN_SECONDS,
    "blocked_source_channel_ids": [],
    "blocked_trigger_channel_ids": [],
}


def _clean_channel_ids(value: Any) -> list[int]:
    result: list[int] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, bool) or not isinstance(item, int):
                continue
            if item not in result:
                result.append(item)
            if len(result) >= MAX_BLOCKED_CHANNELS:
                break
    return result


def normalize_settings(raw: Any) -> dict[str, Any]:
    """保存済みの生 dict を検証済み設定に整える（壊れた値は既定に倒す）。"""
    if not isinstance(raw, dict):
        raw = {}
    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        enabled = True
    cooldown = raw.get("cooldown_seconds")
    if isinstance(cooldown, bool) or cooldown not in COOLDOWN_PRESETS:
        cooldown = DEFAULT_COOLDOWN_SECONDS
    return {
        "enabled": enabled,
        "cooldown_seconds": cooldown,
        "blocked_source_channel_ids": _clean_channel_ids(
            raw.get("blocked_source_channel_ids")),
        "blocked_trigger_channel_ids": _clean_channel_ids(
            raw.get("blocked_trigger_channel_ids")),
    }


def get_settings(store, guild_id: int) -> dict[str, Any]:
    """GuildSettings ストアから検証済みの設定を読む（未設定なら既定）。"""
    return normalize_settings(store.get(guild_id, SECTION))


async def fetch_settings(guild_id: int) -> dict[str, Any]:
    """ギルド設定を読み込む（失敗時は既定値を返して通常動作を続ける）。"""
    try:
        from core.support import guild_settings

        store = guild_settings.get_store()
        await store.ensure_loaded()
        return get_settings(store, guild_id)
    except Exception:
        logger.exception("コメントガチャ設定の読み込みに失敗しました（既定値で続行）")
        return normalize_settings(None)
