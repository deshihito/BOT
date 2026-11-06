"""Slim entry point for the twochoice cog.

The implementation lives in core.game.twochoice_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.twochoice keep working."
"""
from core.game.twochoice_cog.cog import (
    asyncio,
    random,
    discord,
    commands,
    game_panels,
    game_records,
    QUESTIONS_PER_SESSION,
    minority_side,
    pick_questions,
    tally,
    GAME_ID,
    VOTE_SECONDS,
    COLOR,
    VoteView,
    TwoChoice,
    setup,
)
