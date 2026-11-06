"""Slim entry point for the shiritori cog.

The implementation lives in core.game.shiritori.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.shiritori keep working."
"""
from core.game.shiritori.cog import (
    asyncio,
    logging,
    random,
    unicodedata,
    discord,
    game_panels,
    game_restore,
    recruit_join_prompt,
    commands,
    party_ranking,
    CROCK,
    FAILED,
    logger,
    COLOR,
    RECRUIT_SECONDS,
    TURN_SECONDS,
    VOTE_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    TOPICS,
    SMALL,
    VOWELS,
    to_hiragana,
    is_kana_word,
    normalize,
    loose,
    first_kana,
    last_kana,
    check_answer,
    ShiritoriGame,
    topic_verdict,
    JoinView,
    VoteView,
    OdaiShiritori,
    setup,
)
