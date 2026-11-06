"""Slim entry point for the hanabi cog.

The implementation lives in core.game.hanabi_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.hanabi keep working."
"""
from core.game.hanabi_cog.cog import (
    asyncio,
    io,
    logging,
    discord,
    commands,
    game_records,
    render_tiles,
    GamePanelView,
    text_panel,
    COLOR_EMOJI,
    COLORS,
    HanabiGame,
    edit_message_v2,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    TILE_COLORS,
    board_png,
    board_text,
    ActionSelectView,
    HintView,
    Hanabi,
    setup,
)
