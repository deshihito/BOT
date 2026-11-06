"""Slim entry point for the d1_test cog.

The implementation lives in core.general.d1_test.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.d1_test keep working."
"""
from core.general.d1_test.cog import (
    time,
    asyncio,
    aiohttp,
    commands,
    ALLOWED_USER_IDS,
    DEFAULT_D1_ENDPOINT,
    D1TestCog,
    setup,
)
