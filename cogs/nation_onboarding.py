"""Slim entry point for the nation_onboarding cog.

The implementation lives in core.game.nation_onboarding.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.nation_onboarding keep working."
"""
from core.game.nation_onboarding.cog import (
    annotations,
    asyncio,
    logging,
    discord,
    commands,
    NATION_TUTORIAL,
    KVStore,
    log,
    NAMESPACE,
    COLOR,
    tutorial_embed,
    TutorialView,
    NationOnboardingCog,
    setup,
)
