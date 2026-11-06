"""Slim entry point for the bingo cog.

The implementation lives in core.game.bingo_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.bingo keep working."
"""
from core.game.bingo_cog.cog import (
    asyncio,
    logging,
    discord,
    commands,
    party_ranking,
    BingoSession,
    format_card,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    DRAW_INTERVAL,
    MIN_PLAYERS,
    CardCheckView,
    RecruitView,
    Bingo,
    setup,
)
