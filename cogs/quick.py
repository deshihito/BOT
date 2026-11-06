"""Slim entry point for the quick cog.

The implementation lives in core.general.quick.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.quick keep working."
"""
from core.general.quick.cog import (
    annotations,
    logging,
    Any,
    discord,
    app_commands,
    commands,
    action_registry,
    logger,
    AUTOCOMPLETE_LIMIT,
    QuickError,
    palette_actions,
    _matches,
    filter_palette_actions,
    autocomplete_choices,
    _send_ephemeral,
    dispatch_action,
    missing_required_params,
    _convert_param_input,
    QuickParamModal,
    QuickParamPromptView,
    QuickCog,
    setup,
)
