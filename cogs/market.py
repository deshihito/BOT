"""Slim entry point for the market cog.

The implementation lives in core.general.market.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.market keep working."
"""

from pathlib import Path as _Path

# Chart image / bundled font locations. The constants live in this entry
# because tests patch cogs.market.CHART_PATH; the implementation reads
# them lazily through the entry module.
CHART_PATH = _Path(__file__).resolve().parent.parent / "data" / "market_chart.png"
CHART_FONT_PATH = (_Path(__file__).resolve().parent.parent
                   / "assets" / "fonts" / "MPLUSRounded1c-Regular.ttf")
from core.general.market.cog import (
    annotations,
    SUCCESS,
    asyncio,
    io,
    logging,
    datetime,
    timedelta,
    Path,
    discord,
    commands,
    tasks,
    config,
    economy_core,
    items_core,
    market_core,
    prison_core,
    MARKET_INVALID_AMOUNT,
    market_trade_failed,
    as_panel_v2,
    edit_panel_v2,
    INSUFFICIENT,
    logger,
    CHART_FILENAME,
    MARKET_COLOR,
    _wrap,
    _edit_panel,
    _fmt_tokens,
    _market_embed,
    _chart_font_ready,
    _ensure_chart_font,
    _render_chart,
    TradeModal,
    MarketView,
    MarketCog,
    setup,
)
