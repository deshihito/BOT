"""Slim entry point for the imakita cog.

The implementation lives in core.general.imakita.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.imakita keep working."
"""
from core.general.imakita.cog import (
    annotations,
    asyncio,
    logging,
    os,
    time,
    discord,
    commands,
    APIStatusError,
    AsyncGroq,
    RateLimitError,
    guild_locale,
    logger,
    TRIGGER_PHRASE,
    MODEL,
    HISTORY_LIMIT,
    MAX_HISTORY_MESSAGES,
    MAX_HISTORY_CHARS,
    COOLDOWN_SECONDS,
    FAILURE_MESSAGE,
    ImakitaSummaryCog,
    setup,
)
