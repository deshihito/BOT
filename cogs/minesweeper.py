"""Slim entry point for the minesweeper cog.

The implementation lives in core.game.minesweeper_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.minesweeper keep working."
"""
from core.game.minesweeper_cog.cog import (
    time,
    discord,
    commands,
    game_records,
    GAME_GUIDES,
    COLS,
    ROWS,
    DIFFICULTIES,
    MinesweeperBoard,
    GAME_ID,
    NUMBER_LABELS,
    board_embed,
    BoardView,
    DifficultyView,
    Minesweeper,
    setup,
)
