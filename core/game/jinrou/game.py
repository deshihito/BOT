import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.support.emojis import FAILED, SUCCESS
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core.game import autoplay
from core.game import jinrou_review
from core.game import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers

logger = logging.getLogger("cogs.jinrou")


class JinrouGame:
    def __init__(self):
        self.is_running = False
        self.players = []
        self.roles = {}
        self.display_roles = {}  # 表示用役職（裏役職を考慮した偽装役職）
        self.ura_reveal_triggers = {}  # 裏役職の判明トリガー状態 {player_id: True/False}
        self.aho_fake_role = {}  # アホの偽装役職 {player_id: "偽装役職名"}
        self.alive_players = []
        self.last_speak_time = {}
        self.night_actions = {}
        self.voted_count = {}
        self.last_executed = None
        self.game_channel = None
        self.used_hadouhou = False
        self.day_count = 0
        self.wan_owner = {}
        self.masai_evasion = {}
        self.silenced_players = set()
        self.chairman_skip_event = None
        self.chairman_ketsugu_used = False
        self.chairman_ketsugu_target = None
        self.chairman_forced_vote = False
        self.chairman_vote_event = None
        self.in_discussion = False
        self.in_night_phase = False  # 夜フェーズ（夜アクション収集中）の間だけ True
        self.riacchu_pairs = []
        self.kizoku_slave = {}
        self.musician_party_used = False
        self.required_roles = []
        self.excluded_roles = []
        self.host_id = None
        self.game_mode = "プロ"
        self.mokumoku_turns = 0
        self.yandere_targets = {}
        self.is_global = False
        self.channels = []
        self._original_channel = None
        self.review = []          # 振り返り表の記録（core/game/jinrou_review.py）
        self.review_divines = {}  # その夜の占い結果 {占い師: (対象, 白/黒)}
        self.started = False  # 役職を配ってゲームループが動いている間 True（募集中は False）

    # 新しいゲームでも引き継ぐ項目（チャンネルの紐付け）。それ以外はすべて初期値に戻す。
    _KEEP_ON_RESET = ("is_global", "channels", "_original_channel", "game_channel")

    def reset_for_new_game(self):
        """前のゲームの状態（メンヘラの対象・もくもくのターン数など）を残さないよう、全項目を初期化する"""
        kept = {name: getattr(self, name) for name in self._KEEP_ON_RESET}
        self.__init__()
        for name, value in kept.items():
            setattr(self, name, value)

    def is_dead_player(self, user_id) -> bool:
        """ゲームに参加していて、既に死亡・追放された人か"""
        if not self.started:
            return False
        return any(p.id == user_id for p in self.players) and not any(p.id == user_id for p in self.alive_players)
