"""User-scoped automatic message translation settings."""
from __future__ import annotations

from typing import Any

from core import localization
from core.guild_settings import get_store as get_guild_store
from core.libretranslate import LibreTranslateClient
from core.storage import KVStore

TRANSLATION_NAMESPACE = "translation_preferences"
SOURCE_LOCALES = ("auto",) + localization.SUPPORTED_LOCALES
SOURCE_LOCALE_LABELS = {"auto": "自動検出", **localization.LOCALE_LABELS}
SOURCE_LOCALE_FLAGS = {"auto": "🌐", **localization.LOCALE_FLAGS}

_store = KVStore(TRANSLATION_NAMESPACE)


async def ensure_loaded() -> None:
    """Load persisted user settings before handling messages."""
    await _store.load_all()


def normalize_source_locale(value: Any) -> str:
    value = str(value or "auto").lower().replace("-", "_").split("_")[0]
    return value if value in SOURCE_LOCALES else "auto"


def translation_settings(user_id: int, guild_id: int | None = None, store=None) -> dict[str, Any]:
    """Return normalized translation settings for one user.

    The target defaults to the current guild's localization language only when
    the user has not selected a target language yet.
    """
    store = store or _store
    if hasattr(store, "get"):
        raw = store.get(str(user_id), {})
    else:
        raw = store.load_local().get(str(user_id), {})
    if not isinstance(raw, dict):
        raw = {}
    target = raw.get("target_locale") or raw.get("locale")
    if target is None and guild_id is not None:
        target = localization.guild_locale(guild_id, get_guild_store())
    return {
        "enabled": raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False,
        "source_locale": normalize_source_locale(raw.get("source_locale")),
        "target_locale": localization.normalize_locale(target),
    }


async def update_translation_settings(
    user_id: int, *, enabled: bool | None = None,
    source_locale: str | None = None, target_locale: str | None = None,
) -> dict[str, Any]:
    """Update and persist one user's translation settings."""
    key = str(user_id)
    current = _store.load_local().get(key)
    values = dict(current) if isinstance(current, dict) else {}
    if enabled is not None:
        values["enabled"] = bool(enabled)
    if source_locale is not None:
        values["source_locale"] = normalize_source_locale(source_locale)
    if target_locale is not None:
        values["target_locale"] = localization.normalize_locale(target_locale)
    await _store.set(key, values)
    return values


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
