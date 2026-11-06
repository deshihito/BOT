"""Slim entry point for the giveaway cog.

The implementation lives in core.game.giveaway.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.giveaway keep working."
"""
from core.game.giveaway.cog import (
    annotations,
    asyncio,
    logging,
    random,
    time,
    Any,
    Optional,
    discord,
    app_commands,
    commands,
    RESTART,
    TICKET,
    KVStore,
    INSUFFICIENT,
    coin_embed,
    log,
    NAMESPACE,
    JOIN_PREFIX,
    MANAGE_PREFIX,
    MAX_WINNERS,
    MAX_MINUTES,
    MAX_COST,
    KEEP_FINISHED_SECONDS,
    draw,
    build_embed,
    build_view,
    ManageView,
    GiveawayCog,
    setup,
    RUNNING,
    ENDED,
    CANCELLED,
)
