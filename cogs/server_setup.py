"""Slim entry point for the server_setup cog.

The implementation lives in core.support.server_setup.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.server_setup keep working."
"""
from core.support.server_setup.cog import (
    annotations,
    logging,
    Optional,
    discord,
    commands,
    permission_label,
    FAILED,
    SUCCESS,
    NATION_SECTION,
    NOTIFY_LEVELS,
    NOTIFY_MAJOR,
    get_store,
    nation_settings,
    localization,
    logger,
    EMBED_COLOR,
    can_post,
    pick_welcome_channel,
    welcome_embed,
    language_panel_embed,
    _missing,
    check_permissions,
    format_permission_report,
    ModerationModal,
    SetupWizard,
    ServerSetup,
    setup,
)
