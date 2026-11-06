"""Slim entry point for the items cog.

The implementation lives in core.general.items_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.items keep working."
"""
from core.general.items_cog.cog import (
    annotations,
    SUCCESS,
    asyncio,
    logging,
    datetime,
    discord,
    commands,
    tasks,
    config,
    items_core,
    prison_core,
    ITEM_INVALID_INPUT,
    ITEM_NOT_FOUND,
    item_action_failed,
    as_panel_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    ITEMS_COLOR,
    SHOP_ID,
    BOX_ID,
    _wrap,
    _edit_panel,
    _item_name,
    _shop_lines,
    _items_embed,
    ItemAmountModal,
    ItemQuantityModal,
    _item_pick_options,
    ItemPickView,
    _send_item_pick,
    ItemsView,
    ItemsCog,
    setup,
)
