"""Slim entry point for the insider cog.

The implementation lives in core.game.insider_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.insider keep working."
"""
from core.game.insider_cog.cog import (
    asyncio,
    logging,
    discord,
    commands,
    party_ranking,
    GamePanelView,
    text_panel,
    QUESTION_LIMIT,
    InsiderGame,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    VOTE_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    GuessModal,
    Insider,
    setup,
)
