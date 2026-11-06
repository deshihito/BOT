"""Slim entry point for the sudoku cog.

The implementation lives in core.game.sudoku_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.sudoku keep working."
"""
from core.game.sudoku_cog.cog import (
    asyncio,
    random,
    time,
    datetime,
    discord,
    commands,
    game_records,
    DIFFICULTIES,
    board_text,
    daily_puzzle,
    generate,
    is_complete_and_valid,
    GAME_ID,
    sudoku_embed,
    SudokuView,
    ModeView,
    Sudoku,
    setup,
)
