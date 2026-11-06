import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core import game_panels
from core.emojis import FAILED, SUCCESS
from core import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core import autoplay, jinrou_review
from core import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.jinrou.common import ELO_BASE_K, ELO_WOLF_WIN_K  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


def calculate_elo_change(winner_rating, loser_rating, winner_is_wolf: bool):
    """Elo式レート計算。人狼陣営の勝利時はK値を大きくする"""
    K = ELO_WOLF_WIN_K if winner_is_wolf else ELO_BASE_K

    expected_score = 1 / (1 + 10 ** ((loser_rating - winner_rating) / 400))
    rating_change = K * (1 - expected_score)

    return rating_change, -rating_change


def can_end_game(game, user) -> bool:
    """人狼を途中で終了できるか：参加者・ホスト・サーバー管理者（administrator / manage_guild）。"""
    perms = getattr(user, "guild_permissions", None)
    if perms and (perms.administrator or perms.manage_guild):
        return True
    return user.id == game.host_id or any(p.id == user.id for p in game.players)
