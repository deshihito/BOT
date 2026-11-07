"""Slim entry point for the gauge cog.

The implementation lives in core.general.gauge.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.gauge keep working."
"""
from core.general.gauge.cog import (
    asyncio,
    io,
    logging,
    discord,
    commands,
    party_ranking,
    render_gauge,
    GamePanelView,
    text_panel,
    SCALE,
    TARGET_SCORE,
    GaugeGame,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    HINT_SECONDS,
    GUESS_SECONDS,
    COUNTER_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    gauge_panel,
    HintModal,
    Gauge,
    setup,
)
