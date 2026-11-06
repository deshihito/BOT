"""Slim entry point for the muted cog.

The implementation lives in core.support.muted.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.muted keep working."
"""
from core.support.muted.cog import (
    logging,
    discord,
    commands,
    tasks,
    datetime,
    timedelta,
    timezone,
    KVStore,
    logger,
    NAMESPACE,
    parse_guild,
    Muted,
    setup,
)
