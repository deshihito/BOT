"""Slim entry point for the ai cog.

The implementation lives in core.general.ai.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ai keep working."
"""
from core.general.ai.cog import (
    annotations,
    asyncio,
    dataclasses,
    io,
    json,
    logging,
    re,
    discord,
    commands,
    logfare,
    ai_context,
    ai_input,
    ai_latex,
    ai_omnirush,
    ai_preferences,
    ai_provider_router,
    ai_tools,
    logger,
    _reply_without_localization,
    HISTORY_AUTO_DEFAULT,
    HISTORY_AUTO_MAX,
    HISTORY_JUDGE_PROMPT,
    _parse_history_decision,
    _judge_history,
    _with_history,
    AICog,
    setup,
)
