"""Slim entry point for the judge_comment cog.

The implementation lives in core.general.judge_comment.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.judge_comment keep working."
"""
from core.general.judge_comment.cog import (
    aiohttp,
    discord,
    commands,
    DEFAULT_D1_ENDPOINT,
    JudgeCommentCog,
    setup,
)
