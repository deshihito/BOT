"""Slim entry point for the money_panel cog.

The implementation lives in core.general.money_panel.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.money_panel keep working."
"""
from core.general.money_panel.cog import (
    annotations,
    asyncio,
    inspect,
    logging,
    datetime,
    Callable,
    discord,
    commands,
    config,
    market_core,
    prison_core,
    starter_core,
    as_panel_v2,
    edit_message_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    MONEY_PANEL_COLOR,
    _wrap,
    CATEGORIES,
    CATEGORY_LABELS,
    _SESSION_LABELS,
    _fmt_tokens,
    _fmt_minutes,
    status_embed,
    MoneyPanelView,
    MoneyPanelCog,
    setup,
)
