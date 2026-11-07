"""Slim entry point for the loveletter cog.

The implementation lives in core.game.loveletter.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.loveletter keep working."
"""
from core.game.loveletter.cog import (
    asyncio,
    logging,
    random,
    discord,
    commands,
    party_ranking,
    game_panels,
    CARD_INFO,
    NEEDS_TARGET,
    LoveLetterGame,
    card_name,
    logger,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    MAX_PLAYERS,
    public_state_text,
    PlayConfirmView,
    TurnPanel,
    TurnView,
    LoveLetter,
    setup,
)
