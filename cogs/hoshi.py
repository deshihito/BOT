"""Slim entry point for the hoshi cog.

The implementation lives in core.game.hoshi_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.hoshi keep working."
"""
from core.game.hoshi_cog.cog import (
    asyncio,
    logging,
    discord,
    commands,
    party_ranking,
    GamePanelView,
    text_panel,
    BOMB,
    FLOWER,
    HoshiGame,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    PHASE_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    status_text,
    Hoshi,
    setup,
)
