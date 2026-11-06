"""Slim entry point for the dice cog.

The implementation lives in core.game.dice.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.dice keep working."
"""
from core.game.dice.cog import (
    annotations,
    DICE,
    random,
    re,
    discord,
    commands,
    MAX_SIDES_DIGITS,
    MAX_SIDES,
    MAX_DICE_COUNT,
    _DICE_PATTERN,
    parse_dice_message,
    roll_dice,
    DiceCog,
    setup,
)
