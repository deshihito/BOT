"""Slim entry point for the auth cog.

The implementation lives in core.support.auth_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.auth keep working."
"""
from core.support.auth_cog.cog import (
    logging,
    re,
    discord,
    SUCCESS,
    FAILED,
    app_commands,
    commands,
    get_store,
    logger,
    INTRO_CHANNEL_ID,
    WEBHOOK_NAME,
    PANEL_SETTINGS_ID,
    auth_settings,
    sanitize_webhook_name,
    get_intro_webhook,
    role_failure_reason,
    QuestionModal,
    VerifyView,
    VerificationCog,
    sync_category_perms,
    setup,
)
