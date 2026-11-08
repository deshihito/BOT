# -*- coding: utf-8 -*-
"""グローバルVCの言語まわり（ルームの言語と、サーバーごとの表示フィルタ）。

ルームは作成したサーバーの言語設定（/support の言語設定）を持ち、ルーム一覧は
原則として「見る側のサーバーと同じ言語のルーム」だけを出す。言語が未設定の
ルーム（この仕組みより前に作られたルーム）は全言語に表示する。

サーバーごとの上書きは guild_settings の "gvc" セクションに保存する:
- 未設定: サーバーの言語設定に従う（デフォルト）
- "all": すべての言語のルームを表示
- 言語コード: その言語のルームだけを表示
"""
from __future__ import annotations

import logging

logger = logging.getLogger("cogs.sio_globalVC")

GVC_SETTINGS_SECTION = "gvc"
LANG_OVERRIDE_KEY = "lang_filter"

LOCALE_LABELS = {
    "ja": "日本語", "en": "English", "zh": "中文", "ko": "한국어",
    "id": "Bahasa Indonesia", "th": "ไทย", "ar": "العربية", "hi": "हिन्दी",
}


def locale_label(code: str) -> str:
    return LOCALE_LABELS.get(code, code)


def _store():
    from core.support import guild_settings

    return guild_settings.get_store()


def server_locale(guild_id: int) -> str:
    """サーバーの言語設定（localization の guild_locale）。失敗時は既定の ja。"""
    try:
        from core.support.localization import localization

        return localization.guild_locale(guild_id)
    except Exception:
        logger.debug("グローバルVC: サーバー言語の取得に失敗しました", exc_info=True)
        return "ja"


def lang_override(guild_id: int) -> str | None:
    """GVC表示言語の上書き。None = サーバー設定に従う、"all" = すべて、それ以外は言語コード。"""
    try:
        raw = _store().get(guild_id, GVC_SETTINGS_SECTION).get(LANG_OVERRIDE_KEY)
    except Exception:
        logger.debug("グローバルVC: 言語設定の取得に失敗しました", exc_info=True)
        return None
    return raw if isinstance(raw, str) and raw else None


def effective_filter_lang(guild_id: int | None) -> str | None:
    """一覧に出す言語。None なら全言語を出す（フィルタなし）。"""
    if guild_id is None:
        return None
    override = lang_override(guild_id)
    if override == "all":
        return None
    if override:
        return override
    return server_locale(guild_id)


def room_visible(room_language: str, filter_lang: str | None) -> bool:
    """そのルームを一覧に出すか。言語未設定のルームは常に出す。"""
    if filter_lang is None:
        return True
    if not room_language:
        return True
    return room_language == filter_lang
