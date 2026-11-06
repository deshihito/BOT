"""Slim entry point for the ngword cog.

The implementation lives in core.support.ngword.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.ngword keep working."
"""
from core.support.ngword.cog import (
    asyncio,
    random,
    discord,
    game_panels,
    recruit_join_prompt,
    commands,
    party_ranking,
    COLOR,
    RECRUIT_SECONDS,
    GAME_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    NG_WORDS,
    TIME_CHOICES,
    DEFAULT_MINUTES,
    MODES,
    NG_CHARS,
    _SMALL,
    normalize_kana,
    contains_ng_char,
    contains_ng,
    NGGame,
    PlayPanel,
    PlayView,
    NGWord,
    setup,
)
