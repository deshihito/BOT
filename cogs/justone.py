"""Slim entry point for the justone cog.

The implementation lives in core.game.justone.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.justone keep working."
"""
from core.game.justone.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    game_records,
    GamePanelView,
    text_panel,
    ROUNDS_DEFAULT,
    WORDS,
    JustOneSession,
    logger,
    GAME_ID,
    RECRUIT_SECONDS,
    HINT_SECONDS,
    GUESS_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    HintModal,
    GuessModal,
    JustOne,
    setup,
)
