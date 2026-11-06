"""Slim entry point for the globalchat cog.

The implementation lives in core.support.globalchat.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.globalchat keep working."
"""
from core.support.globalchat.cog import (
    discord,
    commands,
    json,
    logging,
    os,
    mod,
    CROCK,
    FAILED,
    logger,
    GlobalChatCog,
    setup,
)
