"""Slim entry point for the uno cog.

The implementation lives in core.game.uno.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.uno keep working."
"""
from core.game.uno.cog import (
    discord,
    game_panels,
    game_restore,
    commands,
    autoplay,
    party_ranking,
    random,
    asyncio,
    logging,
    logger,
    SELECT_LIMIT,
    TURN_TIMEOUT,
    COLOR_TIMEOUT,
    COLORS,
    UnoGame,
    JoinView,
    CardSelect,
    WildColorView,
    GameControlView,
    UnoDeclareView,
    Uno,
    setup,
)
