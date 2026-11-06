"""Slim entry point for the ruins cog.

The implementation lives in core.game.ruins_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ruins keep working."
"""
from core.game.ruins_cog.cog import (
    asyncio,
    io,
    logging,
    discord,
    commands,
    party_ranking,
    render_tiles,
    GamePanelView,
    text_panel,
    TOTAL_ROUNDS,
    RuinsGame,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    DECIDE_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    HAZARD_TILE,
    path_png,
    event_text,
    Ruins,
    setup,
)
