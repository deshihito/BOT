"""Slim entry point for the sokunuke_rta cog.

The implementation lives in core.game.sokunuke_rta.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.sokunuke_rta keep working."
"""
from core.game.sokunuke_rta.cog import (
    annotations,
    asyncio,
    datetime,
    timedelta,
    timezone,
    logging,
    discord,
    app_commands,
    commands,
    guild_settings,
    logger,
    SECTION,
    LIMIT,
    _settings,
    _enabled,
    _duration,
    _human_voice_states,
    SokuNukeRta,
    setup,
)
