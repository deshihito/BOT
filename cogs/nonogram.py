"""Slim entry point for the nonogram cog.

The implementation lives in core.game.nonogram.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.nonogram keep working."
"""
from core.game.nonogram.cog import (
    random,
    time,
    discord,
    commands,
    game_records,
    SIZES,
    NonogramBoard,
    NonogramPuzzle,
    GAME_ID,
    CELL_LABEL,
    board_embed,
    NonogramView,
    SizeView,
    Nonogram,
    setup,
)
