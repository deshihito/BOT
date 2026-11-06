"""Slim entry point for the errorhandler cog.

The implementation lives in core.support.errorhandler.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.errorhandler keep working."
"""
from core.support.errorhandler.cog import (
    annotations,
    logging,
    uuid,
    Optional,
    discord,
    app_commands,
    commands,
    permission_label,
    FAILED,
    logger,
    new_error_id,
    _permissions_text,
    prefix_usage,
    _with_usage,
    classify,
    unexpected_message,
    _cog_overrides,
    prefix_has_local_handler,
    app_has_local_handler,
    ErrorHandler,
    setup,
)
