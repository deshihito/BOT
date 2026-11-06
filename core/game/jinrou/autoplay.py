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
from core.game.jinrou.common import _is_wolf_side, uranai_color  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


class AutoplayMixin:
    AUTOPLAY_NIGHT_ROLES = ("占い師", "騎士", "罠師", "マサイ族")


    def _member_name(self, game, p_id) -> str:
        guild = getattr(game.game_channel, "guild", None)
        m = guild.get_member(p_id) if guild else None
        return m.display_name if m else str(p_id)


    def _autoplay_state(self, game, p_id, phase: str) -> dict:
        return {"game": "jinrou", "phase": phase, "day": game.day_count,
                "my_role": game.roles.get(p_id),
                "alive": [self._member_name(game, p.id) for p in game.alive_players]}


    async def _autoplay_pick_target(self, game, p_id, phase, legal_ids, instructions, describe_verb, fallback=None):
        names = {}
        for t in legal_ids:  # 同名の人がいても選択肢が重ならないようにする
            n = self._member_name(game, t)
            names[t] = n if n not in names.values() else f"{n} ({t})"
        legal = list(names.values())
        result = await autoplay.take_idle_turn(
            game.game_channel, guild_id=getattr(getattr(game.game_channel, "guild", None), "id", None),
            player_name=self._member_name(game, p_id), game=game,
            state=self._autoplay_state(game, p_id, phase), legal_actions=legal, instructions=instructions,
            describe=describe_verb, fallback=names.get(fallback, None))
        if result is None or result.action is None:
            return result, None
        return result, next(t for t, n in names.items() if n == result.action)


    async def _autoplay_night(self, game):
        """夜のアクションをしなかった人の分を代わりに選ぶ（代打ちがオフのサーバーでは何もしない）。"""
        try:
            alive_ids = [p.id for p in game.alive_players]
            wolves = [pid for pid in alive_ids if game.roles.get(pid) in ("人狼", "デカ狼")]
            if wolves and not any(w in game.night_actions for w in wolves):
                targets = [pid for pid in alive_ids if not _is_wolf_side(game, pid)]
                if targets:
                    result, t_id = await self._autoplay_pick_target(
                        game, wolves[0], "night", targets, "人狼として今夜襲撃する相手を 1 人選んでください。",
                        lambda a: "夜のアクションを")
                    if result is None:
                        return
                    if t_id is not None and wolves[0] not in game.night_actions:
                        game.night_actions[wolves[0]] = t_id
            for pid in alive_ids:
                role = game.roles.get(pid)
                is_wan = role == "ワンころ" and game.day_count == 1
                if pid in game.night_actions or not (role in self.AUTOPLAY_NIGHT_ROLES or is_wan):
                    continue
                targets = [t for t in alive_ids if t != pid]
                if not targets:
                    continue
                result, t_id = await self._autoplay_pick_target(
                    game, pid, "night", targets, f"{role}として今夜の対象を 1 人選んでください。",
                    lambda a: "夜のアクションを")
                if result is None:
                    return
                if t_id is None or pid in game.night_actions:
                    continue
                game.night_actions[pid] = t_id
                await self._notify_autoplay_night(game, pid, role, t_id)
        except Exception:
            logger.exception("人狼の夜の代打ちでエラー（放置のまま続けます）")


    async def _notify_autoplay_night(self, game, pid, role, t_id):
        """代わりに選んだ結果を、本人にだけ DM で知らせる（占いの結果・マサイ族の回避など）。"""
        t_name = self._member_name(game, t_id)
        if role == "占い師":
            r = game.roles.get(t_id)
            res = "白" if r == "デカ狼" else uranai_color(r)
            if any(game.roles.get(p.id) == "ビー玉ブレイカー" for p in game.alive_players) and random.random() < 0.3:
                res = "白" if res == "黒" else "黒"
            jinrou_review.note_divine(game, pid, t_id, res)
            text = f"放置したため、代わりに {t_name} を占いました。占い結果: 【{res}】"
        elif role == "マサイ族":
            if game.roles.get(t_id) in ["人狼", "デカ狼"]:
                game.masai_evasion[pid] = True
            text = f"放置したため、代わりに {t_name} を観察しました。"
        else:
            text = f"放置したため、代わりに {t_name} を対象に選びました。"
        guild = getattr(game.game_channel, "guild", None)
        m = guild.get_member(pid) if guild else None
        try:
            if m is not None:
                await m.send(text)
        except Exception:
            logger.debug("人狼: 代打ち通知のDM送信に失敗しました", exc_info=True)


    async def _autoplay_votes(self, game):
        """投票しなかった生存者の分を代わりに選ぶ（d1 が使えないときはスキップ。オフのサーバーでは何もしない）。"""
        try:
            for p in list(game.alive_players):
                if p.id in game.voted_count:
                    continue
                legal = [t.id for t in game.alive_players if t.id != p.id]
                names = {}
                for t in legal:
                    n = self._member_name(game, t)
                    names[str(t)] = n if n not in names.values() else f"{n} ({t})"
                names["skip"] = "スキップ"
                result = await autoplay.take_idle_turn(
                    game.game_channel, guild_id=getattr(getattr(game.game_channel, "guild", None), "id", None),
                    player_name=self._member_name(game, p.id), game=game,
                    state=self._autoplay_state(game, p.id, "vote"), legal_actions=list(names.values()),
                    instructions="追放する人に投票してください。決められないときは「スキップ」を選んでください。",
                    describe=lambda a: "スキップに投票" if a == "スキップ" else f"{a} さんに投票",
                    fallback="スキップ")
                if result is None:
                    return
                if result.action is None or p.id in game.voted_count:
                    continue
                game.voted_count[p.id] = next(k for k, n in names.items() if n == result.action)
        except Exception:
            logger.exception("人狼の投票の代打ちでエラー（放置のまま続けます）")
