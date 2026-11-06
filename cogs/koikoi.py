"""Slim entry point for the koikoi cog.

The implementation lives in core.game.koikoi_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.koikoi keep working."
"""
from core.game.koikoi_cog.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    party_ranking,
    game_panels,
    CARDS,
    KoikoiMatch,
    card_label,
    cpu_choose_capture,
    cpu_choose_play,
    cpu_decide,
    evaluate,
    logger,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    CPU_ID,
    _cards_text,
    public_state_text,
    CaptureSelectView,
    HandView,
    PanelView,
    JoinView,
    Koikoi,
    setup,
)
