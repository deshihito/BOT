"""Slim entry point for the clear cog.

The implementation lives in core.support.clear.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.clear keep working."
"""
from core.support.clear.cog import (
    discord,
    app_commands,
    commands,
    Optional,
    MAX_CLEAR,
    ClearCog,
    setup,
)
