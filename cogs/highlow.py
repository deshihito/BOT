"""Slim entry point for the highlow cog.

The implementation lives in core.game.highlow_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.highlow keep working."
"""
from core.game.highlow_cog.cog import (
    random,
    discord,
    commands,
    game_records,
    HighLowGame,
    card_label,
    GAME_ID,
    card_spec_of,
    state_file,
    game_text,
    HighLowPanel,
    HighLowView,
    HighLow,
    setup,
)
