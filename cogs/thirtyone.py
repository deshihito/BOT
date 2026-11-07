"""Slim entry point for the thirtyone cog.

The implementation lives in core.game.thirtyone.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.thirtyone keep working."
"""
from core.game.thirtyone.cog import (
    asyncio,
    logging,
    discord,
    commands,
    party_ranking,
    game_panels,
    ThirtyOneGame,
    logger,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    MAX_PLAYERS,
    state_text,
    CountPanel,
    CountView,
    ThirtyOne,
    setup,
)
