import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.emojis import FAILED, SUCCESS
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core import autoplay
from core.game import jinrou_review
from core import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.jinrou.common import URA_YAKUSHOKU  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


def _guide_role_lookup(game):
    """「？」ボタン用: 押した人の表示用役職（裏役職は偽装したまま）。参加していなければ None。"""
    return lambda uid: _get_display_role(game, uid, reveal_hidden=False) if game.roles.get(uid) else None


def _get_display_role(game, player_id: int, reveal_hidden: bool = False) -> str:
    """
    プレイヤーの表示用役職を取得。
    裏役職の場合、判明トリガーが満たされていなければ偽装役職を返す。
    reveal_hidden=True の場合は、判明トリガーに関わらず本当の役職を返す（最終開示用）。
    """
    real_role = game.roles.get(player_id)
    if not real_role:
        return "不明"

    # 強制開示モード
    if reveal_hidden:
        return real_role

    # 裏役職の判明判定
    if real_role in URA_YAKUSHOKU:
        trigger, fake = URA_YAKUSHOKU[real_role]
        revealed = game.ura_reveal_triggers.get(player_id, False)

        if not revealed:
            # 未判明の場合、偽装役職を返す
            if real_role == "アホ":
                return game.aho_fake_role.get(player_id, "一般通過あごむに")
            else:
                return fake if fake else "一般通過あごむに"

    return real_role


async def _check_and_reveal_ura_yakushoku(game, player_id: int, trigger_type: str):
    """
    trigger_type: "death" or "end"
    該当するトリガーが満たされたプレイヤーの裏役職を判明させる。
    """
    real_role = game.roles.get(player_id)
    if not real_role or real_role not in URA_YAKUSHOKU:
        return

    ura_trigger, _ = URA_YAKUSHOKU[real_role]
    should_reveal = False

    if trigger_type == "death" and ura_trigger == "death_or_end":
        should_reveal = True
    elif trigger_type == "end":
        should_reveal = True

    if should_reveal:
        game.ura_reveal_triggers[player_id] = True
