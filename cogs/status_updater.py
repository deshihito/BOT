"""Slim entry point for the status_updater cog.

The implementation lives in core.support.status_updater.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.status_updater keep working."
"""
from core.support.status_updater.cog import (
    annotations,
    asyncio,
    logging,
    discord,
    commands,
    tasks,
    logger,
    _ensure_log_output,
    STATUS_MODE,
    STATUS_SOURCE,
    TARGET_GUILD_ID,
    UPDATE_MINUTES,
    TEXT_TEMPLATE,
    _ACTIVITY_TYPES,
    truncate_text,
    StatusUpdater,
    setup,
)
