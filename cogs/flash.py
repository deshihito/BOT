"""Slim entry point for the flash cog.

The implementation lives in core.game.flash.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.flash keep working."
"""
from core.game.flash.cog import (
    asyncio,
    random,
    discord,
    commands,
    game_records,
    FlashModal,
    FlashMentalArithmetic,
    setup,
)
