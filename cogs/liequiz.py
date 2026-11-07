"""Slim entry point for the liequiz cog.

The implementation lives in core.game.liequiz.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.liequiz keep working."
"""
from core.game.liequiz.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    party_ranking,
    GamePanelView,
    text_panel,
    QUESTIONS,
    ROUNDS_DEFAULT,
    LieQuizSession,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    LIE_SECONDS,
    VOTE_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    LieModal,
    LieQuiz,
    setup,
)
