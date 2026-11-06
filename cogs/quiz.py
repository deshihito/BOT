"""Slim entry point for the quiz cog.

The implementation lives in core.game.quiz.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.quiz keep working."
"""
from core.game.quiz.cog import (
    asyncio,
    logging,
    time,
    discord,
    commands,
    party_ranking,
    default_source,
    QuizSession,
    logger,
    GAME_ID,
    QUESTION_COUNT,
    QUESTION_SECONDS,
    RECRUIT_SECONDS,
    standings_text,
    AnswerView,
    RecruitView,
    Quiz,
    setup,
)
