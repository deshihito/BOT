"""Slim entry point for the server_assist cog.

The implementation lives in core.support.server_assist_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.server_assist keep working."
"""
from core.support.server_assist_cog.cog import (
    annotations,
    importlib,
    inspect,
    logging,
    Any,
    discord,
    commands,
    guild_settings,
    as_panel_v2,
    edit_panel_v2,
    discover_features,
    has_manage_permission,
    logger,
    AssistFeatureSelect,
    ServerAssistHomeView,
    ServerAssistCog,
    setup,
)
