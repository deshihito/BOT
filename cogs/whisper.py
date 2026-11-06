"""Slim entry point for the whisper cog.

The implementation lives in core.general.whisper.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.whisper keep working."
"""
from core.general.whisper.cog import (
    discord,
    commands,
    logging,
    logger,
    WhisperModal,
    WhisperView,
    WhisperCog,
    setup,
)
