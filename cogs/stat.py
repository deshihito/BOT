"""Slim entry point for the stat cog.

The implementation lives in core.support.stat.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.stat keep working."
"""
from core.support.stat.cog import (
    discord,
    commands,
    ALLOWED_USER_IDS,
    sys,
    importlib,
    io,
    SystemInfoCog,
    setup,
)
