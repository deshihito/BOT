"""Guild-scoped automatic message translation settings."""
from __future__ import annotations

from typing import Any

from core import localization
from core.guild_settings import get_store
from core.libretranslate import LibreTranslateClient

TRANSLATION_SECTION = "translation"
TRANSLATION_DEFAULTS = {"enabled": False}


def translation_settings(guild_id: int, store=None) -> dict[str, Any]:
    """Return normalized automatic translation settings for a guild."""
    store = store or get_store()
    raw = store.get(guild_id, TRANSLATION_SECTION)
    return {
        "enabled": raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False,
        "locale": localization.guild_locale(guild_id, store),
    }


async def translate_message(text: str, locale: str, *, client: LibreTranslateClient | None = None) -> str:
    """Translate user text through the same LibreTranslate route used by the bot."""
    if not isinstance(text, str) or not text.strip():
        return text
    locale = localization.normalize_locale(locale)
    client = client or LibreTranslateClient()
    return await client.translate(text, source="auto", target=locale)
