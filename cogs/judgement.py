"""Slim entry point for the judgement cog.

The implementation lives in core.general.judgement.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.judgement keep working."
"""
from core.general.judgement.cog import (
    asyncio,
    logging,
    random,
    Literal,
    discord,
    app_commands,
    commands,
    Field,
    create_model,
    needle,
    log,
    LEVELS,
    LEVEL_SCORES,
    JUDGE_TYPES,
    _build_rating_model,
    JudgeCog,
    setup,
)
