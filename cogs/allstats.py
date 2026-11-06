"""Slim entry point for the allstats cog.

The implementation lives in core.support.allstats.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.allstats keep working."
"""
from core.support.allstats.cog import (
    datetime,
    os,
    platform,
    subprocess,
    Path,
    discord,
    commands,
    psutil,
    FIELD_VALUE_LIMIT,
    _limit_field_value,
    SystemStatsCog,
    setup,
)
