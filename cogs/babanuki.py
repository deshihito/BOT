"""Slim entry point for the babanuki cog.

The implementation lives in core.game.babanuki.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.babanuki keep working."
"""
from core.game.babanuki.cog import (
    asyncio,
    logging,
    random,
    discord,
    game_panels,
    game_restore,
    CROCK,
    recruit_join_prompt,
    commands,
    autoplay,
    party_ranking,
    logger,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    BOT_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    BOT_ID,
    JOKER,
    SUITS,
    RANKS,
    make_deck,
    rank,
    discard_pairs,
    deal,
    BabanukiGame,
    JoinView,
    PickButton,
    HandButton,
    TurnView,
    Babanuki,
    setup,
)
