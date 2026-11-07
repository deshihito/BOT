"""Slim entry point for the role_shop cog.

The implementation lives in core.general.role_shop.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.role_shop keep working."
"""
from core.general.role_shop.cog import (
    annotations,
    asyncio,
    logging,
    datetime,
    discord,
    commands,
    tasks,
    config,
    guild_settings,
    prison_core,
    shop_core,
    as_panel_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    SHOP_COLOR,
    _wrap,
    shop_embed,
    RoleShopView,
    RegisterRoleView,
    RegisterModal,
    DeleteProductView,
    RoleShopCog,
    setup,
)
