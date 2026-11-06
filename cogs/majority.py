"""Slim entry point for the majority cog.

The implementation lives in core.game.majority_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.majority keep working."
"""
from core.game.majority_cog.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    party_ranking,
    TOPICS,
    MajoritySession,
    logger,
    GAME_ID,
    ROUNDS,
    ANSWER_SECONDS,
    RECRUIT_SECONDS,
    MIN_PLAYERS,
    AnswerModal,
    AnswerPanel,
    AnswerView,
    Majority,
    setup,
)
