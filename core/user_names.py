# -*- coding: utf-8 -*-
"""ランキング等でのユーザー名解決（メンションを使わない通常表記用）。

ランキングはグローバル（全サーバー横断）集計のため、載るユーザーの多くは
実行したサーバーのメンバーではない。Discord ではサーバーにいないユーザーの
メンション（<@id>）が「不明のユーザー」と表示されてしまうので、ランキング類の
氏名はメンションではなく通常のユーザー名テキストで出す（2026-11-06 の方針）。

解決順: 保存名 → モジュール内キャッシュ（TTL 1時間）→ bot.get_user（キャッシュ）
→ bot.fetch_user（ギルド所属を問わないので unknown にならない）。
fetch は表示件数分（最大25件）に絞り、結果はキャッシュして API 連打を防ぐ。
全て失敗した場合のフォールバックは ``ユーザー(…{ID下4桁})`` で全箇所統一する。
"""
from __future__ import annotations

import time

_CACHE: dict[int, tuple[str, float]] = {}
_CACHE_TTL = 3600.0
_MAX_FETCH = 25


def fallback_name(user_id) -> str:
    """名前が一切解決できない場合の統一フォールバック表記。"""
    return f"ユーザー(…{str(user_id)[-4:].rjust(4, '0')})"


def _cache_get(user_id: int) -> str | None:
    entry = _CACHE.get(user_id)
    if entry is None:
        return None
    name, saved_at = entry
    if time.monotonic() - saved_at > _CACHE_TTL:
        _CACHE.pop(user_id, None)
        return None
    return name


def _cache_put(user_id: int, name: str) -> None:
    if name:
        _CACHE[user_id] = (name, time.monotonic())


def cached_display_name(bot, user_id, stored: str | None = None) -> str:
    """同期文脈用: fetch せず、保存名／キャッシュ／bot.get_user だけで解決する。"""
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return fallback_name(user_id)
    if stored:
        _cache_put(uid, stored)
        return stored
    name = _cache_get(uid)
    if name:
        return name
    user = None
    if bot is not None:
        try:
            user = bot.get_user(uid)
        except Exception:
            user = None
    if user is not None:
        _cache_put(uid, user.display_name)
        return user.display_name
    return fallback_name(uid)


async def resolve_display_names(bot, user_ids, stored: dict | None = None) -> dict:
    """複数ユーザーの表示名を一括解決する。fetch は未解決分を最大25件まで。"""
    stored = stored or {}
    result: dict[int, str] = {}
    pending: list[int] = []
    for raw in user_ids:
        try:
            uid = int(raw)
        except (TypeError, ValueError):
            continue
        if uid in result:
            continue
        name = stored.get(uid) or stored.get(str(uid))
        if name:
            _cache_put(uid, str(name))
            result[uid] = str(name)
            continue
        name = _cache_get(uid)
        if name:
            result[uid] = name
            continue
        user = None
        if bot is not None:
            try:
                user = bot.get_user(uid)
            except Exception:
                user = None
        if user is not None:
            _cache_put(uid, user.display_name)
            result[uid] = user.display_name
            continue
        pending.append(uid)
    if bot is not None and hasattr(bot, "fetch_user"):
        for uid in pending[:_MAX_FETCH]:
            try:
                user = await bot.fetch_user(uid)
            except Exception:
                user = None
            if user is not None:
                _cache_put(uid, user.display_name)
                result[uid] = user.display_name
    for uid in pending:
        result.setdefault(uid, fallback_name(uid))
    return result


async def display_name(bot, user_id, stored: str | None = None) -> str:
    """1人分の表示名を解決する（ランキングの単独表示用）。"""
    names = await resolve_display_names(bot, [user_id],
                                        {user_id: stored} if stored else None)
    try:
        return names.get(int(user_id), fallback_name(user_id))
    except (TypeError, ValueError):
        return fallback_name(user_id)
