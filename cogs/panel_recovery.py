"""Slim entry point for the panel_recovery cog.

The implementation lives in core.support.panel_recovery.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.panel_recovery keep working."
"""

# Tests patch this constant on the entry module; the implementation
# reads it lazily through the entry.
RECOVERY_WAIT_SECONDS = 0.4
from core.support.panel_recovery.cog import (
    annotations,
    asyncio,
    logging,
    discord,
    commands,
    as_panel_v2,
    logger,
    CUSTOM_ID_PREFIX,
    KNOWN_ROOTS,
    FALLBACK_MESSAGE,
    build_panel,
    PanelRecoveryCog,
    setup,
)
