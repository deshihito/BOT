"""Slim entry point for the sudoku cog.

The implementation lives in core.game.sudoku_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.sudoku keep working."
"""
from core.game.sudoku_cog.cog import (
    asyncio,
    io,
    random,
    time,
    datetime,
    discord,
    commands,
    game_records,
    render_cached,
    render_sudoku,
    GamePanelView,
    DIFFICULTIES,
    board_text,
    daily_puzzle,
    generate,
    is_complete_and_valid,
    edit_panel_v2,
    GAME_ID,
    sudoku_embed,
    board_png,
    board_file,
    SudokuView,
    ModeView,
    Sudoku,
    setup,
)
