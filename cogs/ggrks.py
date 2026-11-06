"""Slim entry point for the ggrks cog.

The implementation lives in core.general.ggrks.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ggrks keep working."
"""
from core.general.ggrks.cog import (
    discord,
    commands,
    urllib,
    GoogleSearch,
    setup,
)
