"""Slim entry point for the ito cog.

The implementation lives in core.game.ito.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ito keep working."
"""
from core.game.ito.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    game_records,
    GamePanelView,
    text_panel,
    ROUNDS_DEFAULT,
    THEMES,
    ItoSession,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    ROUND_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    Ito,
    setup,
)
