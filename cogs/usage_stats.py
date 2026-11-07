"""Slim entry point for the usage_stats cog.

The implementation lives in core.support.usage_stats.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.usage_stats keep working."
"""
from core.support.usage_stats.cog import (
    annotations,
    logging,
    datetime,
    discord,
    commands,
    ALLOWED_USER_IDS,
    action_registry,
    usage_stats,
    logger,
    _action_label,
    _started_date,
    UsageStatsCog,
    setup,
)
