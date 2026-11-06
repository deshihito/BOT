"""Slim entry point for the guess cog.

The implementation lives in core.game.guess.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.guess keep working."
"""
from core.game.guess.cog import (
    asyncio,
    logging,
    math,
    random,
    discord,
    commands,
    config,
    game_records,
    logger,
    WIN_MULTIPLIER,
    LOSS_MULTIPLIER,
    UPDATE_ATTEMPTS,
    resolve_guess,
    max_loss,
    max_bet,
    GuessModal,
    Guess,
    setup,
)
