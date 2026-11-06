"""Slim entry point for the game2048 cog.

The implementation lives in core.game.game2048_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.game2048 keep working."
"""
from core.game.game2048_cog.cog import (
    discord,
    commands,
    game_records,
    Game2048,
    GAME_ID,
    game_embed,
    Board2048View,
    Game2048Cog,
    setup,
)
