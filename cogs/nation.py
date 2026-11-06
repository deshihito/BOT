"""Slim entry point for the nation cog.

The implementation lives in core.game.nation.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.nation keep working."
"""
from core.game.nation.cog import (
    annotations,
    asyncio,
    logging,
    os,
    time,
    discord,
    commands,
    COIN,
    nation_settings,
    API_NOT_CONFIGURED_MESSAGE,
    get_client,
    run_with_retry,
    log,
    MAX_HUNGER,
    ROLE_NAMES,
    FOUND_ERRORS,
    HUNGER_INTERVAL,
    HUNGER_PER_MESSAGE,
    COIN_PATH,
    DISABLED_TEXT,
    COLOR_OK,
    COLOR_INFO,
    COLOR_ERROR,
    hunger_bar,
    NationCog,
    setup,
)
