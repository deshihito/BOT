"""Slim entry point for the terminal cog.

The implementation lives in core.support.terminal.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.terminal keep working."
"""
from core.support.terminal.cog import (
    asyncio,
    os,
    pty,
    discord,
    commands,
    ALLOWED_USER_IDS,
    TARGET_DIR,
    run_interactive_terminal,
    TerminalModal,
    TerminalView,
    TerminalCog,
    guild_list_messages,
    setup,
)
