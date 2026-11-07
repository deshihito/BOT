"""Slim entry point for the minesweeper cog.

The implementation lives in core.game.minesweeper.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.minesweeper keep working.

盤面画像化タスク（2026-11-06）で実装側は画像盤面＋V2 パネルに再設計され、
旧 BoardView / DifficultyView / board_embed / NUMBER_LABELS は
BoardPanel / DifficultyPanel / board_png 等に置き換わった。
"""
from core.game.minesweeper.cog import (
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
    tile_for,
    coord,
    board_states,
    board_png,
    board_file,
    BoardPanel,
    DifficultyPanel,
    Minesweeper,
    setup,
)
