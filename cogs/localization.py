"""Slim entry point for the localization cog.

The implementation lives in core.support.localization.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.localization keep working."
"""
from core.support.localization.cog import (
    annotations,
    logging,
    discord,
    commands,
    localization,
    get_store,
    logger,
    _PATCHED,
    install_discord_localization,
    LanguageSelect,
    LanguageView,
    LocalizationCog,
    setup,
)
