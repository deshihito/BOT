"""Slim entry point for the thirtyone cog.

The implementation lives in core.game.thirtyone_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.thirtyone keep working."
"""
from core.game.thirtyone_cog.cog import (
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
    CountView,
    JoinView,
    ThirtyOne,
    setup,
)
