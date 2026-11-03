"""Guild-scoped automatic message translation settings."""
from __future__ import annotations

from typing import Any

from core import localization
from core.guild_settings import get_store
from core.libretranslate import LibreTranslateClient

TRANSLATION_SECTION = "translation"
TRANSLATION_DEFAULTS = {"enabled": False, "source_locale": "auto"}
SOURCE_LOCALES = ("auto",) + localization.SUPPORTED_LOCALES
SOURCE_LOCALE_LABELS = {"auto": "自動検出", **localization.LOCALE_LABELS}
SOURCE_LOCALE_FLAGS = {"auto": "🌐", **localization.LOCALE_FLAGS}


def normalize_source_locale(value: Any) -> str:
    value = str(value or "auto").lower().replace("-", "_").split("_")[0]
    return value if value in SOURCE_LOCALES else "auto"


def translation_settings(guild_id: int, store=None) -> dict[str, Any]:
    """Return normalized automatic translation settings for a guild.

    ``target_locale`` falls back to the existing localization locale so that
    servers using the first version of this feature keep their behavior.
    """
    store = store or get_store()
    raw = store.get(guild_id, TRANSLATION_SECTION)
    target = raw.get("target_locale") if isinstance(raw, dict) else None
    if not target and isinstance(raw, dict):
        # Backward compatibility with the original target-only UI.
        target = raw.get("locale")
    return {
        "enabled": raw.get("enabled") if isinstance(raw, dict) and isinstance(raw.get("enabled"), bool) else False,
        "source_locale": normalize_source_locale(raw.get("source_locale") if isinstance(raw, dict) else None),
        "target_locale": localization.normalize_locale(
            target or localization.guild_locale(guild_id, store)
        ),
    }


async def translate_message(
    text: str,
    source_locale: str,
    target_locale: str,
    *,
    client: LibreTranslateClient | None = None,
) -> str:
    """Translate user text through the existing LibreTranslate route."""
    if not isinstance(text, str) or not text.strip():
        return text
    source_locale = normalize_source_locale(source_locale)
    target_locale = localization.normalize_locale(target_locale)
    if source_locale != "auto" and source_locale == target_locale:
        return text
    client = client or LibreTranslateClient()
    return await client.translate(text, source=source_locale, target=target_locale)
