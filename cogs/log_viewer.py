"""Slim entry point for the log_viewer cog.

The implementation lives in core.support.log_viewer.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.log_viewer keep working."
"""
from core.support.log_viewer.cog import (
    io,
    logging,
    datetime,
    discord,
    commands,
    FAILED,
    logger,
    ALLOWED_USER_IDS,
    VALID_LEVELS,
    is_log_allowed,
    LogViewer,
    setup,
)
