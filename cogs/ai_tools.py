"""Slim entry point for the ai_tools cog.

The implementation lives in core.general.ai_tools.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ai_tools keep working."
"""
from core.general.ai_tools.cog import (
    annotations,
    logging,
    os,
    re,
    Any,
    discord,
    commands,
    logfare,
    ai_tools_router,
    logger,
    GENERIC_FAILURE_MESSAGE,
    _enabled,
    _is_miq_trigger,
    _resolve_invoker,
    _parse_param_input,
    AIToolsConfirmView,
    AIToolsParamModal,
    AIToolsParamCompletionView,
    AIToolsCog,
    setup,
)
