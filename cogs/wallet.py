"""Slim entry point for the wallet cog.

The implementation lives in core.general.wallet.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.wallet keep working."
"""
from core.general.wallet.cog import (
    discord,
    commands,
    app_commands,
    asyncio,
    logging,
    config,
    os,
    traceback,
    APIError,
    run_with_retry,
    logger,
    COIN_SETTER_USER_ID,
    NEW_USER_BALANCE,
    BALANCE_UPDATE_ATTEMPTS,
    INSUFFICIENT,
    COIN_PATH,
    COIN_FILENAME,
    COIN_COLOR,
    coin_embed,
    WalletCog,
    setup,
)
