"""Slim entry point for the gacha cog.

The implementation lives in core.game.gacha.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.gacha keep working."
"""
from core.game.gacha.cog import (
    annotations,
    asyncio,
    logging,
    random,
    discord,
    commands,
    tasks,
    config,
    clan_core,
    gacha_core,
    prison_core,
    as_panel_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    GACHA_COLOR,
    _wrap,
    summary_embed,
    collection_embed,
    GachaView,
    PartyView,
    GachaCog,
    setup,
)
