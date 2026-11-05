import os
import discord
import json
import random
import asyncio
import base64
import io
import time
import hashlib
import aiohttp
from core import logfare
import datetime
import logging
from discord.ui import View
from discord import app_commands, Interaction
from discord.ext import commands, tasks
from cogs.terminal import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw, ImageEnhance
from zoneinfo import ZoneInfo
from core.api_client import APIError
from core.api_retry import run_with_retry

from core.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.dungeon.common import D_ACTIVE_ELEMENTS, D_ACTIVE_STATUSES, D_BOSS_NAMES, D_ENEMY_NAMES, D_INTENT_LABELS, D_SUPERENEMY_NAMES, ELEMENTS, ENEMY_STATS_MASTER  # noqa: F401
from core.dungeon.player import d_enemy_archetype, d_ensure_intent, d_intent_at  # noqa: F401
from core.dungeon.world import d_get_biome  # noqa: F401

logger = logging.getLogger("cogs.dangeon")




def d_advance_intent(enemy):
    """敵の意図をサイクルの次へ進め、新しい意図を返す。"""
    d_ensure_intent(enemy)
    enemy["intent_turn"] = int(enemy.get("intent_turn", 0)) + 1
    enemy["intent"] = d_intent_at(enemy["archetype"], enemy["intent_turn"])
    return enemy["intent"]


def d_intent_label(enemy):
    """表示用に、敵の現在の意図のラベルを返す。"""
    d_ensure_intent(enemy)
    return D_INTENT_LABELS.get(enemy.get("intent", "attack"), "通常攻撃")


def d_element_weakness(element):
    """その属性を持つ敵に有効な攻撃属性（弱点）を返す。無ければ None。"""
    weak = ELEMENTS.get(element, {}).get("weak", [])
    return weak[0] if weak else None


def d_make_enemy(floor, forced_name=None, forced_rank=None):
    """敵を生成。forced_rank ("normal"/"elite"/"boss") でランク抽選を固定できる（Phase 1-D）。"""
    base_hp  = 15 + floor * 8
    base_atk = 4  + floor * 2
    base_def = 1  + floor
    bname, _, _, _, _ = d_get_biome(floor)

    # ランクと名前の決定
    if forced_name:
        name = forced_name
        etype = "normal"
    elif forced_rank in ("normal", "elite", "boss"):
        etype = forced_rank
        name = random.choice({
            "boss": D_BOSS_NAMES.get(bname, ["ボス"]),
            "elite": D_SUPERENEMY_NAMES.get(bname, ["精鋭"]),
        }.get(etype, D_ENEMY_NAMES.get(bname, ["謎の敵"])))
    else:
        r = random.random()
        if r < 0.01:
            etype = "boss"
            name = random.choice(D_BOSS_NAMES.get(bname, ["ボス"]))
        elif r < 0.11:
            etype = "elite"
            name = random.choice(D_SUPERENEMY_NAMES.get(bname, ["精鋭"]))
        else:
            etype = "normal"
            name = random.choice(D_ENEMY_NAMES.get(bname, ["謎の敵"]))

    # マスタから個別パラメータを取得
    clean_key = name.split()[0].replace("👾", "").strip()
    m = ENEMY_STATS_MASTER.get(clean_key, ENEMY_STATS_MASTER["default"])

    # ランクによる倍率補正（精鋭は実機感想を受けて控えめに弱体化:
    # HP 4.0→3.0 / ATK 2.5→2.0 / DEF 1.5→1.25。通常・ボスと報酬は不変）
    rank_hp_mul  = 3.0 if etype == "elite" else (15.0 if etype == "boss" else 1.0)
    rank_atk_mul = 2.0 if etype == "elite" else (4.0 if etype == "boss" else 1.0)
    rank_def_mul = 1.25 if etype == "elite" else (2.0 if etype == "boss" else 1.0)

    # ステータス確定
    hp = int((base_hp + random.randint(-3, 3)) * m.get("hp_m") * rank_hp_mul)
    atk = int((base_atk + random.randint(-1, 1)) * m.get("atk_m", 1.0) * rank_atk_mul)
    defe = int(base_def * m.get("def_m", 1.0) * rank_def_mul)
    
    # 報酬計算
    m_coin_m = m.get("coin_m", 1.0)
    m_xp_m   = m.get("xp_m", 1.0)
    m_boxes  = m.get("boxes", 0)

    if etype == "elite":
        reward_coins = int(random.randint(80, 150) * floor * m_coin_m)
        reward_xp    = int(random.randint(100, 800) * floor * m_xp_m)
        reward_box   = max(1, m_boxes)
    elif etype == "boss":
        reward_coins = int(random.randint(2000, 4000) * floor * m_coin_m)
        reward_xp    = int(random.randint(1000, 2000) * floor * m_xp_m)
        reward_box   = max(5, m_boxes)
    else:
        reward_coins = int(random.randint(20, 80) * floor * m_coin_m)
        reward_xp    = int(random.randint(10, 30) * floor * m_xp_m)
        reward_box   = m_boxes if m_boxes > 0 else (1 if random.random() < 0.05 else 0)

    archetype = d_enemy_archetype(name, etype, m)
    return {
        "name":         name,
        "type":         etype,
        "hp":           hp,
        "max_hp":       hp,
        "atk":          atk,
        "def_":         defe,
        "spd":          m.get("spd", 10),
        "crit":         m.get("crit", 0.05),
        # Phase 2-A: 新規生成の属性・状態異常は現行3種だけを使う。
        # 全ての敵に属性（＝弱点）を持たせ、弱点はダメージ計算で実際に効く。
        "element":      random.choice(D_ACTIVE_ELEMENTS),
        "status_effect": random.choice(D_ACTIVE_STATUSES),
        "archetype":    archetype,
        "intent_turn":  0,
        "intent":       d_intent_at(archetype, 0),
        "reward_coins": reward_coins,
        "reward_xp":    reward_xp,
        "reward_box":   reward_box,
    }
