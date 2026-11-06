"""Slim entry point for the shinkei cog.

The implementation lives in core.game.shinkei.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.shinkei keep working."
"""
from core.game.shinkei.cog import (
    asyncio,
    logging,
    random,
    discord,
    game_panels,
    game_restore,
    CROCK,
    logger,
    recruit_join_prompt,
    commands,
    autoplay,
    party_ranking,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    REVEAL_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    PAIRS,
    ROW_SIZES,
    SYMBOLS,
    BACK,
    deal,
    row_of,
    ShinkeiGame,
    CardButton,
    BoardView,
    JoinView,
    Shinkei,
    setup,
)
