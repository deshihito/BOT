"""Slim entry point for the workshop cog.

The implementation lives in core.general.workshop.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.workshop keep working."
"""
from core.general.workshop.cog import (
    annotations,
    SUCCESS,
    asyncio,
    logging,
    datetime,
    discord,
    commands,
    tasks,
    config,
    clan_core,
    craft_core,
    items_core,
    prison_core,
    workshop_core,
    craft_action_failed,
    workshop_action_failed,
    as_panel_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    WORKSHOP_COLOR,
    WORKSHOP_ID,
    _wrap,
    _edit_panel,
    _item_name,
    _tier_lines,
    _workshop_embed,
    _craft_embed,
    BuyMachineView,
    WorkshopView,
    CraftView,
    WorkshopCog,
    setup,
)
