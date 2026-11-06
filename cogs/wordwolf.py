"""Slim entry point for the wordwolf cog.

The implementation lives in core.game.wordwolf.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.wordwolf keep working."
"""
from core.game.wordwolf.cog import (
    discord,
    game_panels,
    commands,
    party_ranking,
    asyncio,
    logging,
    random,
    logger,
    RECRUIT_SECONDS,
    CHAT_MINUTES,
    LIST_NAMES,
    WordWolfSession,
    CustomWordWolf,
    CheckWordPanel,
    CheckWordView,
    setup,
)
