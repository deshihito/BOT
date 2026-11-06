"""Slim entry point for the codenames cog.

The implementation lives in core.game.codenames_cog.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.codenames keep working."
"""
from core.game.codenames_cog.cog import (
    asyncio,
    logging,
    random,
    FAILED,
    discord,
    commands,
    party_ranking,
    game_panels,
    TEAM_LABEL,
    CodenamesGame,
    other_team,
    logger,
    GAME_ID,
    COLOR,
    RECRUIT_SECONDS,
    KIND_MARK,
    board_text,
    status_text,
    HintModal,
    ControlPanel,
    ControlView,
    GuessSelect,
    TeamJoinPanel,
    TeamJoinView,
    Codenames,
    setup,
)
