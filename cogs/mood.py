"""Slim entry point for the mood cog.

The implementation lives in core.general.mood.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.mood keep working."
"""
from core.general.mood.cog import (
    discord,
    commands,
    datetime,
    AsyncGroq,
    os,
    MoodAnalysis,
    setup,
)
