"""Slim entry point for the janken cog.

The implementation lives in core.game.janken.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.janken keep working."
"""
from core.game.janken.cog import (
    asyncio,
    random,
    CROCK,
    discord,
    INSUFFICIENT,
    game_panels,
    recruit_join_prompt,
    commands,
    party_ranking,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    HAND_SECONDS,
    MAX_PLAYERS,
    MAX_ROUNDS,
    BOT_ID,
    HANDS,
    HAND_LABELS,
    BEATS,
    judge,
    auto_hand,
    JankenGame,
    JoinView,
    HandView,
    Janken,
    setup,
)
