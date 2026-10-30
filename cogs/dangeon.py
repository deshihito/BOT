# -*- coding: utf-8 -*-
"""
ダンジョンシステム Cog（スタンドアロン版）
dungeon.py - Discord.py Cog形式

【必須設定】
  .env:
    DUNGEON_IMG_CHANNEL_ID=画像投稿チャンネルID
  
  Supabase テーブル:
    - dungeon_maps (floor, grid, used_coords, start_pos)
    - dungeon_players (user_id, floor, x, y, hp, max_hp, atk, def_, spd, crit)
    - dungeon_bases (user_id, floor, x, y)
  
  main.py:
    await bot.load_extension('cogs.dungeon')
"""

import os
import discord
import json
import random
import asyncio
import io
import time
import base64
import hashlib
import aiohttp
import datetime
import logging
from discord.ui import View
from discord import app_commands, Interaction
from discord.ext import commands, tasks
from cogs.terminal import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw
from zoneinfo import ZoneInfo

# ============================================================
#  タイムゾーン
# ============================================================
JST = ZoneInfo("Asia/Tokyo")

# ============================================================
#  定数（ダンジョンシステム用）
# ============================================================

# マップ定義
D_MAP_W = 101
D_MAP_H = 101
D_FLOORS = 40
D_VIEW_R = 5
TILE = 32

# タイルタイプ
D_WALL = "wall"
D_FLOOR = "floor"
D_START = "start"
D_STAIRS = "stairs"
D_CHEST = "chest"
D_TRAP = "trap"
D_SHOP = "shop"
D_BASE = "base"
D_MINE = "mine"
D_REST = "rest"
D_SHRINE = "shrine"
D_EVENT = "event"

I_WALL = "i_wall"
I_FLOOR = "i_floor"
I_EXIT = "i_exit"
I_COUNTER = "i_counter"
I_REST = "i_rest"
I_STORAGE = "i_storage"
I_BAKERY = "i_bakery"
I_DOUBLE = "i_double"
I_SLOT = "i_slot"

# バイオーム定義 (フロア範囲, 名前, 壁emoji, 床emoji, 霧emoji, 色)
D_BIOMES = [
    (range(1,  10),  "洞窟",     "⬜", "<:b_:1563559473422016512>", "🌫️", 0x5C4033),
    (range(10,  20),  "森",       "🟫", "<:g_:1563559471048032376>", "🌫️", 0x2D5A1B),
    (range(20,  30),  "氷雪地帯", "⬜", "🔹", "🌫️", 0x5B9BD5),
    (range(30, 41),  "砂漠地帯", "🟧", "<:y_:1563559481768411257>", "🌫️", 0xC8600A),
]

# エンカウント率
D_ENCOUNTER_RATES = {
    "洞窟":     0.05,
    "森":       0.20,
    "氷雪地帯": 0.07,
    "砂漠地帯": 0.13,
}

SEASON_ID = os.environ.get(
    "DUNGEON_SEASON_ID",
    f"season-{datetime.datetime.now(JST).strftime('%Y-%m')}",
)
JOB_MASTER = {
    "warrior": {"name": "戦士", "atk": 4, "def_": 4, "max_hp": 30, "spd": 0, "crit": 0.00, "skill": "power_strike"},
    "rogue": {"name": "盗賊", "atk": 2, "def_": 0, "max_hp": 0, "spd": 5, "crit": 0.08, "skill": "smoke_bomb"},
    "mage": {"name": "魔術師", "atk": 7, "def_": -1, "max_hp": -10, "spd": 1, "crit": 0.02, "skill": "fireball"},
}
EQUIPMENT_MASTER = {
    "iron_sword": {"name": "鉄の剣", "slot": "weapon", "atk": 5, "def_": 0, "hp": 0, "crit": 0},
    "leather_armor": {"name": "革鎧", "slot": "armor", "atk": 0, "def_": 3, "hp": 15, "crit": 0},
    "lucky_charm": {"name": "幸運のお守り", "slot": "accessory", "atk": 0, "def_": 0, "hp": 0, "crit": 0.10},
    "desert_ring": {"name": "砂漠の指輪", "slot": "accessory", "atk": 3, "def_": 0, "hp": 5, "crit": 0.02},
}
# 拡張コンテンツ定義。既存データに後方互換で追加できるよう、報酬はinventoryへ格納する。
ELEMENTS = {
    "none": {"name": "無", "weak": [], "resist": []},
    "fire": {"name": "火", "weak": ["ice"], "resist": ["fire"]},
    "ice": {"name": "氷", "weak": ["fire", "thunder"], "resist": ["ice"]},
    "thunder": {"name": "雷", "weak": ["water"], "resist": ["thunder"]},
    "water": {"name": "水", "weak": ["fire"], "resist": ["water"]},
    "light": {"name": "光", "weak": ["dark"], "resist": ["light"]},
    "dark": {"name": "闇", "weak": ["light"], "resist": ["dark"]},
}
STATUS_EFFECTS = {
    "poison": {"name": "毒", "turns": 3}, "burn": {"name": "火傷", "turns": 3},
    "freeze": {"name": "凍結", "turns": 1}, "paralyze": {"name": "麻痺", "turns": 1},
    "bleed": {"name": "出血", "turns": 3}, "silence": {"name": "沈黙", "turns": 2},
    "curse": {"name": "呪い", "turns": 4},
}
WEAPON_TYPES = {
    "iron_sword": {"name": "鉄の剣", "kind": "sword", "element": "none", "description": "安定した単体攻撃"},
    "moon_blade": {"name": "月影剣", "kind": "sword", "element": "light", "description": "闇属性への特効"},
    "giant_axe": {"name": "巨人斧", "kind": "axe", "element": "none", "description": "高威力・低速度"},
    "venom_dagger": {"name": "毒牙短剣", "kind": "dagger", "element": "dark", "description": "毒を付与"},
    "storm_bow": {"name": "嵐の弓", "kind": "bow", "element": "thunder", "description": "先制しやすい"},
    "frost_staff": {"name": "氷晶杖", "kind": "staff", "element": "ice", "description": "凍結を付与"},
    "sun_spear": {"name": "陽光槍", "kind": "spear", "element": "light", "description": "アンデッド特効"},
}
EQUIPMENT_MASTER.update({
    key: {"name": data["name"], "slot": "weapon", "atk": atk, "def_": 0, "hp": hp, "crit": crit,
          "element": data["element"], "kind": data["kind"], "description": data["description"]}
    for key, data, atk, hp, crit in [
        ("moon_blade", WEAPON_TYPES["moon_blade"], 9, 0, 0.04),
        ("giant_axe", WEAPON_TYPES["giant_axe"], 14, -5, -0.02),
        ("venom_dagger", WEAPON_TYPES["venom_dagger"], 6, 0, 0.12),
        ("storm_bow", WEAPON_TYPES["storm_bow"], 7, 0, 0.08),
        ("frost_staff", WEAPON_TYPES["frost_staff"], 8, 0, 0.03),
        ("sun_spear", WEAPON_TYPES["sun_spear"], 10, 5, 0.02),
    ]
})
RELIC_MASTER = {
    "lucky_coin": {"name": "幸運硬貨", "description": "宝箱報酬の抽選が少し良くなる", "effect": "treasure"},
    "phoenix_ash": {"name": "不死鳥の灰", "description": "HP0時に一度だけ30%で復活", "effect": "revive"},
    "explorer_compass": {"name": "探検家の羅針盤", "description": "隠し部屋とイベントを発見しやすい", "effect": "explore"},
    "iron_will": {"name": "鉄の意志", "description": "HP30%未満で防御力+8", "effect": "survive"},
    "d1_tactics": {"name": "作戦教本", "description": "D1の安全重視作戦を強化", "effect": "d1"},
}
QUEST_MASTER = {
    "first_10_steps": {"name": "最初の遠征", "description": "10ターン移動する", "kind": "turns", "target": 10, "reward": {"xp": 80, "season_score": 50}},
    "monster_hunter": {"name": "魔物狩り", "description": "敵を5体倒す", "kind": "kills", "target": 5, "reward": {"coins": 250, "season_score": 80}},
    "treasure_route": {"name": "宝物街道", "description": "宝箱を3個開ける", "kind": "chests", "target": 3, "reward": {"bread": 5, "season_score": 80}},
    "deep_explorer": {"name": "深層探索", "description": "10階へ到達する", "kind": "floor", "target": 10, "reward": {"relic": "explorer_compass", "season_score": 150}},
}
ROOM_MODIFIERS = {
    "fog": {"name": "濃霧", "description": "エンカウント率が上がる"},
    "blessing": {"name": "祝福の階", "description": "回復量が増える"},
    "cursed": {"name": "呪われた階", "description": "報酬は増えるが罠も増える"},
    "treasure": {"name": "宝物の階", "description": "宝箱が多い"},
}
D1_PLANS = {
    "safe": "安全探索", "speed": "最短攻略", "treasure": "財宝優先",
    "battle": "戦闘優先", "explore": "探索優先", "boss": "ボス準備優先",
    "xp": "経験値優先",
}
# D1は小型の意思決定モデルなので、渡す文脈は常に短く保つ（コンテキスト長対策）。
D1_STATE_CHARS = int(os.environ.get("D1_STATE_CHARS", 2400))
D1_LOG_LINES = int(os.environ.get("D1_LOG_LINES", 6))
D1_MAX_TURNS = int(os.environ.get("D1_MAX_TURNS", 10))
# pingではなく画像付き推論の完了までを測る。画像モデルの初回推論は
# モデルロード直後に30秒を超えることがあるため、短いpingのtimeoutと分離する。
D1_HTTP_TIMEOUT = float(os.environ.get("D1_HTTP_TIMEOUT", 90))
D1_HTTP_RETRIES = max(1, int(os.environ.get("D1_HTTP_RETRIES", 2)))
D1_HTTP_RETRY_DELAY = float(os.environ.get("D1_HTTP_RETRY_DELAY", 1.5))
D1_READY_CACHE_SECONDS = float(os.environ.get("D1_READY_CACHE_SECONDS", 300))
D1_TIMING_LOG = os.environ.get("D1_TIMING_LOG", "0").lower() in ("1", "true", "yes", "on")
# 移動判断に必要な盤面情報はstate/criteriaのテキストで渡す。
# visionは必要な環境でのみ明示的に有効化する（既定: 無効）。
D1_SEND_IMAGES = os.environ.get("D1_SEND_IMAGES", "0").lower() in ("1", "true", "yes", "on")
# 8方向の定義。移動・経路探索・選択肢の基準提示で共通利用する。
_DIRECTIONS = {
    "up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0),
    "leftup": (-1, -1), "rightup": (1, -1), "leftdown": (-1, 1), "rightdown": (1, 1),
}
_DIRECTION_LABELS = {
    "up": "北", "down": "南", "left": "西", "right": "東",
    "leftup": "北西", "rightup": "北東", "leftdown": "南西", "rightdown": "南東",
}
ACHIEVEMENTS = {
    "first_step": "初めての一歩", "floor_10": "森の踏破者", "floor_20": "氷原の生存者",
    "floor_40": "深層の覇者", "first_boss": "ボスブレイカー", "treasure_hunter": "宝箱荒らし",
    "skill_user": "スキルの使い手", "camp_builder": "野営地の開拓者",
}
# NPCとフロア目標。D1へ渡すゴール提示にも利用する。
NPC_MASTER = {
    "traveler": {"name": "旅人レオン", "steps": [{"text": "安全な道を教える", "flag": "traveler_help", "reward": {"bread": 2}}, {"text": "地図を交換する", "flag": "traveler_map", "reward": {"material": "map_fragment"}}]},
    "blacksmith": {"name": "鍛冶師ミナ", "steps": [{"text": "素材を渡す", "flag": "forge_help", "reward": {"material": "iron_ore"}}, {"text": "武器を強化する", "flag": "forge_upgrade", "reward": {"season_score": 30}}]},
    "scholar": {"name": "学者ユイ", "steps": [{"text": "図鑑を読む", "flag": "library_seen", "reward": {"xp": 50}}, {"text": "古代文字を解読する", "flag": "library_decode", "reward": {"relic": "explorer_compass"}}]},
    "prisoner": {"name": "囚人カイ", "steps": [{"text": "救出する", "flag": "prisoner_saved", "reward": {"coins": 100}}, {"text": "秘密を聞く", "flag": "prisoner_secret", "reward": {"season_score": 50}}]},
    "guildmaster": {"name": "ギルド長", "steps": [{"text": "依頼を受ける", "flag": "guild_quest", "reward": {"xp": 100}}, {"text": "深層の報告をする", "flag": "guild_report", "reward": {"relic": "d1_tactics"}}]},
}
FLOOR_GOALS = {
    "open_chests": {"name": "宝箱を開ける", "kind": "chests", "target": 3, "reward": {"relic": "lucky_coin"}},
    "defeat_enemies": {"name": "敵を倒す", "kind": "kills", "target": 3, "reward": {"season_score": 100}},
    "reach_floor": {"name": "深層へ進む", "kind": "floor", "target": 5, "reward": {"material": "ancient_shard"}},
}

# タイルカラー (RGB)
TILE_COLORS = {
    D_WALL:   {"洞窟": (80,60,50),    "森": (40,60,20),   "氷雪地帯": (200,220,240), "砂漠地帯": (120,80,30)},
    D_FLOOR:  {"洞窟": (40,30,25),    "森": (60,100,30),  "氷雪地帯": (100,160,200), "砂漠地帯": (200,160,60)},
    D_START:  (30,100,220),
    D_STAIRS: (220,60,60),
    D_CHEST:  (220,200,30),
    D_TRAP:   None,
    D_SHOP:   (180,80,200),
    D_BASE:   (80,120,220),
    D_MINE:   (255,0,120),
    D_REST:   (80,180,120),
    D_SHRINE: (180,120,255),
    D_EVENT:  (255,150,60),
    "player": (30,220,120),
    "fog":    (0,0,0),
}

# アセット設定
ASSET_CONFIG = {
    ("洞窟", D_WALL): "rock.PNG",
    ("洞窟", D_FLOOR): "jimen.png",
    ("森", D_WALL): "mori_kabe.png",
    ("森", D_FLOOR): "mori_yuka.png",
    ("氷雪地帯", D_WALL): "Y_k.png",
    ("氷雪地帯", D_FLOOR): "Y_y.png",
    ("砂漠地帯", D_WALL): "Y_k.png",
    ("砂漠地帯", D_FLOOR): "Y_y.png",
}

# 敵データベース
D_ENEMY_NAMES = {
    "洞窟":     ["コウモリ","ゴブリン","岩石スライム"],
    "森":       ["オオカミ","毒キノコ","トレント"],
    "氷雪地帯": ["雪男","アイスゴーレム","白熊"],
    "砂漠地帯": ["サソリ","砂蛇","炎トカゲ"],
}

D_SUPERENEMY_NAMES = {
    "洞窟":     ["セミオートキラーマシン"],
    "森":       ["邪蛇"],
    "氷雪地帯": ["雪女"],
    "砂漠地帯": ["鬼"],
}

D_BOSS_NAMES = {
    "洞窟":     ["ドラゴン"],
    "森":       ["ヌシ","ぱすた"],
    "氷雪地帯": ["凍ったコッペパン"],
    "砂漠地帯": ["炎龍"],
}

ENEMY_STATS_MASTER = {
    "コウモリ":       {"hp_m": 0.7, "atk_m": 0.5, "def_m": 0.5, "spd": 10, "crit": 0,    "ai": ["attack","wait"], "coin_m": 0.8, "xp_m": 0.8, "boxes": 0},
    "ゴブリン":       {"hp_m": 1.0, "atk_m": 1.1, "def_m": 0.8, "spd": 15, "crit": 0.08, "ai": ["attack"], "coin_m": 1.0, "xp_m": 1.0, "boxes": 0},
    "岩石スライム":   {"hp_m": 1.5, "atk_m": 0.8, "def_m": 1.8, "spd": 5,  "crit": 0.02, "ai": ["attack"], "coin_m": 1.2, "xp_m": 1.1, "boxes": 0},
    "オオカミ":       {"hp_m": 0.9, "atk_m": 1.2, "def_m": 0.7, "spd": 20, "crit": 0.10, "ai": ["attack"], "coin_m": 1.1, "xp_m": 1.2, "boxes": 0},
    "毒キノコ":       {"hp_m": 1.2, "atk_m": 0.8, "def_m": 1.0, "spd": 5,  "crit": 0.05, "ai": ["attack"], "coin_m": 1.0, "xp_m": 1.0, "boxes": 0},
    "トレント":       {"hp_m": 2.0, "atk_m": 1.0, "def_m": 1.5, "spd": 3,  "crit": 0.03, "ai": ["attack","attack","heal"], "coin_m": 1.5, "xp_m": 1.5, "boxes": 0},
    
    "セミオートキラーマシン": {"hp_m": 4.5, "atk_m": 2.8, "def_m": 1.5, "spd": 22, "crit": 0.25, "ai": ["attack"], "coin_m": 3.0, "xp_m": 5.0, "boxes": 1},
    "邪蛇":           {"hp_m": 3.0, "atk_m": 3.4, "def_m": 1.2, "spd": 28, "crit": 0.15, "ai": ["attack"], "coin_m": 2.5, "xp_m": 4.0, "boxes": 1},
    
    "ヌシ":           {"hp_m": 20.0, "atk_m": 4.5, "def_m": 2.2, "spd": 12, "crit": 0.10, "ai": ["attack"], "coin_m": 10.0, "xp_m": 10.0, "boxes": 5},
    "ドラゴン":       {"hp_m": 18.0, "atk_m": 5.0, "def_m": 2.5, "spd": 20, "crit": 0,    "ai": ["attack"], "coin_m": 12.0, "xp_m": 12.0, "boxes": 5},
    "ぱすた":        {"hp_m": 100, "atk_m": 0, "def_m": 10, "spd": 100, "crit": 0,     "ai": ["wait"], "coin_m": 0.1, "xp_m": 0.1, "boxes": 0},

    "ミミック":       {"hp_m": 2.5, "atk_m": 2.0, "def_m": 1.2, "spd": 8,  "crit": 0.25, "ai": ["attack"], "coin_m": 5.0, "xp_m": 3.0, "boxes": 1},
    "default":        {"hp_m": 1.0, "atk_m": 1.0, "def_m": 1.0, "spd": 10, "crit": 0.05, "ai": ["attack"], "coin_m": 1.0, "xp_m": 1.0, "boxes": 0}
}
ENEMY_STATS_MASTER.update({
    "洞窟コウモリ王": {"hp_m": 2.0, "atk_m": 1.4, "def_m": 0.8, "spd": 25, "crit": 0.18, "ai": ["attack", "strong_attack"], "coin_m": 2.0, "xp_m": 2.0, "boxes": 1},
    "毒沼蛙": {"hp_m": 1.3, "atk_m": 1.0, "def_m": 1.0, "spd": 8, "crit": 0.05, "ai": ["attack", "heal"], "coin_m": 1.4, "xp_m": 1.5, "boxes": 0},
    "森の狩人": {"hp_m": 1.1, "atk_m": 1.8, "def_m": 0.8, "spd": 18, "crit": 0.2, "ai": ["attack", "wait"], "coin_m": 1.8, "xp_m": 1.6, "boxes": 0},
    "氷晶精": {"hp_m": 1.4, "atk_m": 1.5, "def_m": 1.5, "spd": 12, "crit": 0.08, "ai": ["attack", "wait"], "coin_m": 1.6, "xp_m": 1.8, "boxes": 1},
    "砂漠盗賊": {"hp_m": 1.0, "atk_m": 1.7, "def_m": 0.9, "spd": 24, "crit": 0.16, "ai": ["attack", "attack", "wait"], "coin_m": 2.2, "xp_m": 1.7, "boxes": 0},
    "雷獣": {"hp_m": 2.2, "atk_m": 2.1, "def_m": 1.2, "spd": 30, "crit": 0.22, "ai": ["strong_attack", "attack"], "coin_m": 2.8, "xp_m": 2.5, "boxes": 2},
    "深淵騎士": {"hp_m": 3.0, "atk_m": 2.4, "def_m": 2.4, "spd": 10, "crit": 0.12, "ai": ["attack", "heal"], "coin_m": 3.2, "xp_m": 3.0, "boxes": 2},
})
D_ENEMY_NAMES["洞窟"].extend(["洞窟コウモリ王", "毒沼蛙"])
D_ENEMY_NAMES["森"].extend(["森の狩人"])
D_ENEMY_NAMES["氷雪地帯"].extend(["氷晶精", "雷獣"])
D_ENEMY_NAMES["砂漠地帯"].extend(["砂漠盗賊", "深淵騎士"])

# ============================================================
#  グローバルメモリキャッシュ
# ============================================================

dg_maps    = {}  # {floor: [[...], [...]]}
dg_players = {}  # {uid: {floor, x, y, hp, max_hp, atk, def_, spd, crit}}
dg_starts  = {}  # {floor: (x, y)}
dg_used    = {}  # {floor: set((x, y), ...)}
dg_bases   = {}  # {uid: (floor, x, y)}
_ASSET_CACHE = {}
_PLAYER_LOCKS = {}
# 正常保存済みペイロードのハッシュ。同一状態の再保存を省略して、
# 巨大なマップ／プレイヤーJSONの不要なPostgREST・WAL書き込みを防ぐ。
_MAP_SAVE_DIGESTS = {}
_PLAYER_SAVE_DIGESTS = {}

# 環境変数
DUNGEON_IMG_CHANNEL_ID = int(os.environ.get("DUNGEON_IMG_CHANNEL_ID", 0))
D1_ENDPOINT = os.environ.get("D1_ENDPOINT", "http://127.0.0.1:8082/v1/systemone")
logger = logging.getLogger(__name__)

# ============================================================
#  ヘルパー関数
# ============================================================

def d_get_biome(floor):
    """フロアからバイオーム情報を取得"""
    for r, name, wall_e, floor_e, fog_e, color in D_BIOMES:
        if floor in r:
            return name, wall_e, floor_e, fog_e, color
    return "洞窟", "⬜", "<:b_:1563559473422016512>", "🌫️", 0x5C4033

def d_ensure_map(floor):
    """フロアのマップが存在しなければ生成"""
    if floor not in dg_maps:
        dg_maps[floor] = d_gen_floor(floor)
        dg_used[floor] = set()

def d_get_cell(floor, x, y):
    """指定座標のセルタイプを取得"""
    d_ensure_map(floor)
    if 0 <= y < D_MAP_H and 0 <= x < D_MAP_W:
        return dg_maps[floor][y][x]
    return D_WALL

def d_consume(floor, x, y):
    """座標を消費（床に変更）"""
    dg_used[floor].add((x, y))
    dg_maps[floor][y][x] = D_FLOOR

def d_default_player():
    """新規プレイヤーの初期状態。拡張項目も含めてここで一元管理する。"""
    return {
        "floor": 1, "x": 1, "y": 1,
        "hp": 100, "max_hp": 100,
        "atk": 10, "def_": 3, "spd": 10, "crit": 0.05,
        "xp": 0, "level": 1, "boxes": 0,
        "bread": 0, "chips": 0,
        "job": "warrior", "equipment": {}, "inventory": {},
        "achievements": [], "season_id": SEASON_ID, "season_score": 0,
        "turns": 0, "cooldowns": {},
        "relics": [], "active_effects": [], "materials": {},
        "quests": {key: {"progress": 0, "completed": False} for key in QUEST_MASTER},
        "run_modifiers": [], "camp_facilities": {"inn": 1, "forge": 0, "guild": 0},
        "battle_stats": {"kills": 0, "chests": 0, "escapes": 0},
        "skill_points": 0, "skills": [], "npc_flags": {}, "story_flags": {},
        "run_id": None, "run_started_at": None, "run_summary": {},
        "floor_goals": {}, "pending_rewards": [], "reward_ledger": [],
        "action_log": [], "state_version": 0, "front_back": "front",
        "battle_resource": {"mp": 20, "max_mp": 20, "rage": 0, "combo": 0, "guard": 0},
        "battle_flags": {},
    }

def d_get_player(uid):
    """プレイヤーのダンジョンデータを取得する。未保存の新規ユーザーも安全な初期値を持つ。"""
    uid = str(uid)
    p = dg_players.get(uid)
    if p is None:
        p = dg_players[uid] = d_default_player()
    else:
        for key, value in d_default_player().items():
            if key not in p:
                p[key] = value
        for key in QUEST_MASTER:
            p["quests"].setdefault(key, {"progress": 0, "completed": False})
        if p.get("season_id") != SEASON_ID:
            p["season_id"] = SEASON_ID
            p["season_score"] = 0
    return p


def d_effective_stats(player):
    """職業・装備・強化・パッシブ込みの実効ステータスを返す。"""
    p = player
    job = JOB_MASTER.get(p.get("job", "warrior"), JOB_MASTER["warrior"])
    stats = {
        "atk": p.get("atk", 10) + job["atk"],
        "def_": p.get("def_", 3) + job["def_"],
        "max_hp": p.get("max_hp", 100) + job["max_hp"],
        "spd": p.get("spd", 10) + job["spd"],
        "crit": p.get("crit", 0.05) + job["crit"],
    }
    equipped = list(p.get("equipment", {}).values())
    for key in equipped:
        item = EQUIPMENT_MASTER.get(key, {})
        stats["atk"] += item.get("atk", 0)
        stats["def_"] += item.get("def_", 0)
        stats["max_hp"] += item.get("hp", 0)
        stats["crit"] += item.get("crit", 0)
        # 強化レベルとパッシブは保存済みJSON状態から決定的に再現する。
        upgrade = int(item.get("upgrade_level", 0))
        stats["atk"] += upgrade
        stats["def_"] += upgrade
        if "speed_up" in item.get("passive_effects", []):
            stats["spd"] += 2
    if "set_steel" in [EQUIPMENT_MASTER.get(k, {}).get("set_id") for k in equipped]:
        stats["def_"] += 3
    if p.get("battle_resource", {}).get("guard", 0) > 0:
        stats["def_"] += p["battle_resource"]["guard"]
    if "iron_will" in p.get("relics", []) and p.get("hp", 0) <= stats["max_hp"] * 0.30:
        stats["def_"] += 8
    if "storm_bow" in p.get("inventory", {}) and p.get("inventory", {}).get("storm_bow", 0) > 0:
        stats["spd"] += 2
    if "giant_axe" in equipped:
        stats["spd"] -= 2
    stats["max_hp"] = max(1, stats["max_hp"])
    stats["def_"] = max(0, stats["def_"])
    stats["spd"] = max(0, stats["spd"])
    return stats


def d_progress_quest(uid, kind, amount=1, supabase=None):
    """既存JSON状態だけで進むクエスト。報酬は完了時に一度だけ付与する。"""
    p = d_get_player(uid)
    completed = []
    for key, quest in QUEST_MASTER.items():
        state = p["quests"].setdefault(key, {"progress": 0, "completed": False})
        if state.get("completed") or quest["kind"] != kind:
            continue
        state["progress"] = min(quest["target"], state.get("progress", 0) + int(amount))
        if state["progress"] >= quest["target"]:
            state["completed"] = True
            completed.append(key)
    return completed

def d_grant_relic(uid, relic_key):
    p = d_get_player(uid)
    if relic_key in RELIC_MASTER and relic_key not in p["relics"]:
        p["relics"].append(relic_key)
        return RELIC_MASTER[relic_key]["name"]
    return None

def d_apply_special_status(uid, key, turns=None):
    """状態異常を付与し、戦闘フラグにも反映する。"""
    d_apply_status(uid, key, turns)
    flags = d_get_player(uid).setdefault("battle_flags", {})
    if key == "freeze":
        flags["skip_next"] = True
    elif key == "paralyze":
        flags["paralyzed"] = True
    elif key == "silence":
        flags["silenced"] = True
    elif key == "curse":
        flags["cursed"] = True

def d_apply_floor_goal(uid, kind, amount=1):
    """フロア目標の進捗を進め、達成時は目標を返す。"""
    p = d_get_player(uid)
    goal = p.setdefault("floor_goals", {}).setdefault(
        str(p["floor"]), {"kind": "chests", "progress": 0, "target": 3, "completed": False}
    )
    if goal.get("completed") or goal.get("kind") != kind:
        return None
    goal["progress"] = min(goal.get("target", 1), goal.get("progress", 0) + int(amount))
    if goal["progress"] >= goal["target"]:
        goal["completed"] = True
        return goal
    return None

def d_equipment_profile(uid):
    """所持している装備の一覧を返す。"""
    p = d_get_player(uid)
    return [dict(EQUIPMENT_MASTER.get(k, {}), key=k) for k in p.get("inventory", {}) if k in EQUIPMENT_MASTER]

def d_upgrade_equipment(uid, key, material="iron_ore"):
    """素材を消費して装備を1段階強化する。"""
    p = d_get_player(uid)
    if key not in EQUIPMENT_MASTER or p.get("materials", {}).get(material, 0) <= 0:
        return False
    p["materials"][material] -= 1
    EQUIPMENT_MASTER[key]["upgrade_level"] = int(EQUIPMENT_MASTER[key].get("upgrade_level", 0)) + 1
    return True

def d_floor_modifier(floor):
    """フロアごとの軽量な変異。固定化してD1にもログで伝えられる。"""
    key = list(ROOM_MODIFIERS)[(floor - 1) % len(ROOM_MODIFIERS)]
    return ROOM_MODIFIERS[key]["name"]

def d_content_summary(uid):
    p = d_get_player(uid)
    quests = [f"{QUEST_MASTER[k]['name']} {v.get('progress',0)}/{QUEST_MASTER[k]['target']}" for k, v in p["quests"].items() if not v.get("completed")]
    relics = [RELIC_MASTER[k]["name"] for k in p.get("relics", []) if k in RELIC_MASTER]
    return quests[:2], relics[:3]

def d_apply_status(uid, status_key, turns=None):
    p = d_get_player(uid)
    if status_key not in STATUS_EFFECTS:
        return
    turns = turns or STATUS_EFFECTS[status_key]["turns"]
    effects = p.setdefault("active_effects", [])
    for effect in effects:
        if isinstance(effect, dict) and effect.get("key") == status_key:
            effect["turns"] = max(effect.get("turns", 0), turns)
            return
    effects.append({"key": status_key, "turns": turns})

def d_tick_status(uid):
    """状態異常を1ターン進め、表示用ログとダメージを返す。"""
    p = d_get_player(uid)
    logs = []
    remaining = []
    for effect in p.setdefault("active_effects", []):
        if not isinstance(effect, dict):
            continue
        key = effect.get("key")
        turns = int(effect.get("turns", 0))
        if key in ("poison", "burn", "bleed"):
            damage = max(1, int(d_effective_stats(p)["max_hp"] * (0.03 if key == "poison" else 0.04)))
            p["hp"] = max(0, p["hp"] - damage)
            logs.append(f"{STATUS_EFFECTS.get(key, {}).get('name', key)}で{damage}ダメージ")
        turns -= 1
        if turns > 0:
            remaining.append({"key": key, "turns": turns})
    p["active_effects"] = remaining
    return logs

def d_unlock_achievement(uid, key):
    p = d_get_player(uid)
    if key in ACHIEVEMENTS and key not in p["achievements"]:
        p["achievements"].append(key)
        p["season_score"] += 100
        return ACHIEVEMENTS[key]
    return None


def d_job_name(uid):
    return JOB_MASTER.get(d_get_player(uid).get("job", "warrior"), JOB_MASTER["warrior"])["name"]


def d_get_lock(uid):
    """ユーザー単位の排他ロックを取得する。"""
    uid = str(uid)
    return _PLAYER_LOCKS.setdefault(uid, asyncio.Lock())


async def d_apply_economy(uid, supabase, coins=0):
    """ウォレットを更新する。SQL RPCがあれば原子処理を優先し、旧環境には安全なフォールバックを使う。"""
    if not supabase or not coins:
        return True

    def _apply():
        try:
            result = supabase.rpc("dungeon_apply_coins", {
                "p_user_id": str(uid), "p_delta": int(coins)
            }).execute()
            if result.data is not False:
                return True
        except Exception:
            logger.warning("dungeon_apply_coins RPC unavailable; using fallback", exc_info=True)

        row = supabase.table("users").select("balance").eq("user_id", str(uid)).execute()
        current = int(row.data[0].get("balance") or 0) if row.data else 10
        # 罠などの減算は残高0を下限とし、ゲーム操作自体は失敗させない。
        new_balance = max(0, current + int(coins))
        if row.data:
            updated = (supabase.table("users").update({"balance": new_balance})
                       .eq("user_id", str(uid)).eq("balance", current).execute())
            return bool(updated.data)
        inserted = supabase.table("users").insert({
            "user_id": str(uid), "balance": new_balance, "debt": 0
        }).execute()
        return bool(inserted.data)

    return await asyncio.to_thread(_apply)


async def d_apply_reward(uid, supabase, *, coins=0, xp=0, boxes=0, bread=0, chips=0, items=None, equipment=None, relic=None, material=None, achievement=None, season_score=0):
    """戦利品をプレイヤーとウォレットへ一度のアクションで反映する。"""
    if not await d_apply_economy(uid, supabase, coins):
        raise RuntimeError("コイン残高を更新できませんでした")
    p = d_get_player(uid)
    p["xp"] = max(0, p["xp"] + int(xp))
    p["boxes"] = max(0, p["boxes"] + int(boxes))
    p["bread"] = max(0, p["bread"] + int(bread))
    p["chips"] = max(0, p["chips"] + int(chips))
    for item_key, amount in (items or {}).items():
        p["inventory"][item_key] = max(0, p["inventory"].get(item_key, 0) + int(amount))
    if equipment:
        p["inventory"][equipment] = p["inventory"].get(equipment, 0) + 1
        slot = EQUIPMENT_MASTER.get(equipment, {}).get("slot")
        if slot and slot not in p["equipment"]:
            p["equipment"][slot] = equipment
    if relic:
        d_grant_relic(uid, relic)
    if material:
        p["materials"][material] = p["materials"].get(material, 0) + 1
    if achievement:
        d_unlock_achievement(uid, achievement)
    p["season_score"] += int(season_score)
    while p["xp"] >= p["level"] * 100:
        p["xp"] -= p["level"] * 100
        p["level"] += 1
        p["max_hp"] += 10
        p["hp"] = p["max_hp"]
        p["atk"] += 1
    return p

def d_hpbar(hp, max_hp, width=10):
    """HP バーを生成"""
    filled = int(width * hp / max(max_hp, 1))
    return "█" * filled + "░" * (width - filled)

def d_open_chest(uid, supabase):
    """宝箱の結果を決定する。反映は呼び出し側のd_apply_rewardで行う。"""
    p = d_get_player(uid)
    stats = p.setdefault("battle_stats", {})
    stats["chests"] = stats.get("chests", 0) + 1
    d_progress_quest(uid, "chests", 1)
    d_apply_floor_goal(uid, "chests", 1)
    if "lucky_coin" in p.get("relics", []) and random.random() < 0.25:
        coins = random.randint(100, 350)
        return f"幸運硬貨が輝いた！ 宝箱からコイン **+{coins}** 枚", {"coins": coins}
    roll = random.random()
    if roll < 0.5:
        coins = random.randint(50, 300)
        return f"宝箱！ コイン **+{coins}** 枚", {"coins": coins}
    if roll < 0.8:
        bread = random.randint(3, 15)
        return f"宝箱！ レアパン **+{bread}** 個", {"bread": bread}
    if roll < 0.93:
        boxes = random.randint(1, 3)
        return f"宝箱！ 宝箱 **+{boxes}** 個", {"boxes": boxes}
    if roll < 0.98:
        relic = random.choice(list(RELIC_MASTER))
        return f"宝箱！ 遺物 **{RELIC_MASTER[relic]['name']}** を発見", {"relic": relic}
    equipment = random.choice(list(EQUIPMENT_MASTER))
    return f"宝箱！ 装備 **{EQUIPMENT_MASTER[equipment]['name']}** を発見", {"equipment": equipment, "achievement": "treasure_hunter"}

def d_trigger_trap(uid):
    """罠の結果を決定し、HPだけ即時反映する。資産減少は呼び出し側で反映する。"""
    p = d_get_player(uid)
    if "explorer_compass" in p.get("relics", []) and random.random() < 0.25:
        return "羅針盤が罠を発見し、回避しました。", {}
    roll = random.random()
    if roll < 0.4:
        loss = random.randint(30, 150)
        return f"罠！ コイン **-{loss}** 枚", {"coins": -loss}
    if roll < 0.7:
        dmg = random.randint(10, 30)
        p["hp"] = max(0, p["hp"] - dmg)
        return f"罠！ HP **-{dmg}**", {}
    if roll < 0.85:
        loss = random.randint(1, 5)
        return f"罠！ レアパン **-{loss}** 個", {"bread": -loss}
    loss = random.randint(50, 200)
    return f"罠！ チップ **-{loss}** 枚", {"chips": -loss}

def d_do_mine(uid):
    """採掘する"""
    gain = random.randint(30, 200)
    return gain

def d_make_enemy(floor, forced_name=None):
    """敵を生成"""
    base_hp  = 15 + floor * 8
    base_atk = 4  + floor * 2
    base_def = 1  + floor
    bname, _, _, _, _ = d_get_biome(floor)

    # ランクと名前の決定
    if forced_name:
        name = forced_name
        etype = "normal"
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

    # ランクによる倍率補正
    rank_hp_mul  = 4.0 if etype == "elite" else (15.0 if etype == "boss" else 1.0)
    rank_atk_mul = 2.5 if etype == "elite" else (4.0 if etype == "boss" else 1.0)
    rank_def_mul = 1.5 if etype == "elite" else (2.0 if etype == "boss" else 1.0)

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

    return {
        "name":         name,
        "type":         etype,
        "hp":           hp,
        "max_hp":       hp,
        "atk":          atk,
        "def_":         defe,
        "spd":          m.get("spd", 10),
        "crit":         m.get("crit", 0.05),
        "element":      random.choice(["none", "fire", "ice", "thunder"] if bname != "砂漠地帯" else ["none", "fire", "dark"]),
        "status_effect": random.choice(["poison", "burn", "freeze", "bleed"]),
        "reward_coins": reward_coins,
        "reward_xp":    reward_xp,
        "reward_box":   reward_box,
    }

def d_gen_floor(floor):
    """セルオートマトン法でフロアを生成"""
    grid = [[D_WALL if (x == 0 or y == 0 or x == D_MAP_W-1 or y == D_MAP_H-1)
             else (D_WALL if random.random() < 0.45 else D_FLOOR)
             for x in range(D_MAP_W)] for y in range(D_MAP_H)]
    
    for _ in range(5):
        new = [[D_WALL]*D_MAP_W for _ in range(D_MAP_H)]
        for y in range(D_MAP_H):
            for x in range(D_MAP_W):
                if x == 0 or y == 0 or x == D_MAP_W-1 or y == D_MAP_H-1:
                    new[y][x] = D_WALL
                    continue
                walls = sum(1 for dy in range(-1, 2) for dx in range(-1, 2)
                          if grid[y+dy][x+dx] == D_WALL)
                new[y][x] = D_WALL if walls >= 5 else D_FLOOR
        grid = new
    
    visited = set()
    best = set()
    for sy in range(1, D_MAP_H-1):
        for sx in range(1, D_MAP_W-1):
            if grid[sy][sx] == D_FLOOR and (sx, sy) not in visited:
                region = set()
                queue = [(sx, sy)]
                while queue:
                    cx, cy = queue.pop()
                    if (cx, cy) in region:
                        continue
                    region.add((cx, cy))
                    for dx, dy in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                        nx, ny = cx + dx, cy + dy
                        if (0 < nx < D_MAP_W-1 and 0 < ny < D_MAP_H-1
                                and grid[ny][nx] == D_FLOOR
                                and (nx, ny) not in region):
                            queue.append((nx, ny))
                visited |= region
                if len(region) > len(best):
                    best = region
    
    for y in range(D_MAP_H):
        for x in range(D_MAP_W):
            if grid[y][x] == D_FLOOR and (x, y) not in best:
                grid[y][x] = D_WALL
    
    candidates = list(best)
    random.shuffle(candidates)
    sx, sy = candidates[0]
    grid[sy][sx] = D_START
    dg_starts[floor] = (sx, sy)
    
    for ex, ey in candidates[1:]:
        if abs(ex-sx) + abs(ey-sy) > 20:
            grid[ey][ex] = D_STAIRS
            break
    else:
        if len(candidates) > 1:
            grid[candidates[1][1]][candidates[1][0]] = D_STAIRS
    
    floor_cells = [p for p in best if grid[p[1]][p[0]] == D_FLOOR]
    random.shuffle(floor_cells)
    
    placed_chest = 0
    placed_trap = 0
    placed_shop = 0
    placed_mine = 0
    placed_rest = 0
    placed_shrine = 0
    placed_event = 0
    max_chest = max(3, len(floor_cells)//80)
    max_trap  = max(2, len(floor_cells)//120)
    max_shop  = max(1, len(floor_cells)//300)
    max_mine  = max(2, len(floor_cells)//150)
    max_rest = max(1, len(floor_cells)//500)
    max_shrine = max(1, len(floor_cells)//450)
    max_event = max(1, len(floor_cells)//400)
    
    for fx, fy in floor_cells:
        if all([placed_chest >= max_chest, placed_trap >= max_trap,
                placed_shop >= max_shop, placed_mine >= max_mine,
                placed_rest >= max_rest, placed_shrine >= max_shrine,
                placed_event >= max_event]):
            break
        r = random.random()
        if placed_shop < max_shop and r < 0.03:
            grid[fy][fx] = D_SHOP
            placed_shop += 1
        elif placed_mine < max_mine and r < 0.10:
            grid[fy][fx] = D_MINE
            placed_mine += 1
        elif placed_rest < max_rest and r < 0.13:
            grid[fy][fx] = D_REST
            placed_rest += 1
        elif placed_shrine < max_shrine and r < 0.18:
            grid[fy][fx] = D_SHRINE
            placed_shrine += 1
        elif placed_event < max_event and r < 0.23:
            grid[fy][fx] = D_EVENT
            placed_event += 1
        elif placed_chest < max_chest and r < 0.60:
            grid[fy][fx] = D_CHEST
            placed_chest += 1
        elif placed_trap < max_trap:
            grid[fy][fx] = D_TRAP
            placed_trap += 1
    
    return grid

def load_all_assets():
    """Assetsフォルダから画像を読み込みキャッシュする"""
    global _ASSET_CACHE
    base_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(base_dir, "..", "Assets")
    
    _ASSET_CACHE = {}
    for (biome, tid), fname in ASSET_CONFIG.items():
        path = os.path.join(assets_dir, fname)
        if os.path.isfile(path):
            try:
                img = Image.open(path).convert("RGBA").resize((TILE, TILE), Image.Resampling.NEAREST)
                _ASSET_CACHE[(biome, tid)] = img
                print(f"✓ {fname} を読み込みました")
            except Exception as e:
                print(f"<:failed:1490986584676368535> {fname} ロード失敗: {e}")

def _draw_tile(draw, img, x, y, cell, biome, is_player=False, is_fog=False):
    """タイルを描画"""
    px, py = x * TILE, y * TILE
    if is_fog:
        draw.rectangle([px, py, px+TILE-1, py+TILE-1], fill=(0, 0, 0))
        return
    
    if is_player:
        floor_col = TILE_COLORS[D_FLOOR].get(biome, (40, 30, 25)) if isinstance(TILE_COLORS[D_FLOOR], dict) else TILE_COLORS[D_FLOOR]
        draw.rectangle([px, py, px+TILE-1, py+TILE-1], fill=floor_col)
        col = TILE_COLORS["player"]
        margin = 6
        draw.ellipse([px+margin, py+margin, px+TILE-margin-1, py+TILE-margin-1], fill=col)
        return

    tile_img = _ASSET_CACHE.get((biome, cell))
    if tile_img is not None:
        img.paste(tile_img, (px, py), tile_img)
        return

    if cell == D_TRAP:
        col_src = TILE_COLORS[D_FLOOR]
        col = col_src.get(biome, (40, 30, 25)) if isinstance(col_src, dict) else col_src
        draw.rectangle([px, py, px+TILE-1, py+TILE-1], fill=col)
        return
    
    col_src = TILE_COLORS.get(cell, (80, 80, 80))
    if isinstance(col_src, dict):
        col = col_src.get(biome, (80, 80, 80))
    else:
        col = col_src
    draw.rectangle([px, py, px+TILE-1, py+TILE-1], fill=col)
    
    if cell == D_CHEST:
        margin = 8
        draw.rectangle([px+margin, py+margin, px+TILE-margin-1, py+TILE-margin-1],
                       fill=(255, 255, 100), outline=(180, 140, 0), width=2)
    elif cell == D_STAIRS:
        for s in range(3):
            sx = px + 6 + s*6
            sy = py + TILE - 8 - s*6
            draw.rectangle([sx, sy, sx+TILE-14, sy+4], fill=(255, 255, 255))
    elif cell == D_SHOP:
        draw.text((px+TILE//2, py+TILE//2), "S", fill=(255, 255, 255))
    elif cell == D_MINE:
        draw.text((px+TILE//2-4, py+TILE//2-6), "⛏", fill=(200, 200, 200))
    elif cell == D_REST:
        draw.text((px+TILE//2-5, py+TILE//2-7), "R", fill=(255, 255, 255))
    elif cell == D_SHRINE:
        draw.text((px+TILE//2-5, py+TILE//2-7), "✦", fill=(255, 255, 255))
    elif cell == D_EVENT:
        draw.text((px+TILE//2-5, py+TILE//2-7), "?", fill=(255, 255, 255))
    elif cell == D_BASE:
        draw.text((px+TILE//2-4, py+TILE//2-6), "🏠", fill=(255, 255, 255))

def d_build_map_image(uid, floor, px, py, radius=D_VIEW_R):
    """マップをPillow Imageとして生成"""
    d_ensure_map(floor)
    bname, *_ = d_get_biome(floor)
    size = radius * 2 + 1
    img = Image.new("RGB", (size * TILE, size * TILE), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    for vy_i, vy in enumerate(range(py - radius, py + radius + 1)):
        for vx_i, vx in enumerate(range(px - radius, px + radius + 1)):
            is_player = (vx == px and vy == py)
            if not (0 <= vx < D_MAP_W and 0 <= vy < D_MAP_H):
                _draw_tile(draw, img, vx_i, vy_i, D_WALL, bname, is_fog=True)
                continue
            cell = dg_maps[floor][vy][vx]
            _draw_tile(draw, img, vx_i, vy_i, cell, bname, is_player=is_player)

    return img

# Discordはメッセージ編集で同名添付のURLを再利用するため、同じmap.pngを使い回すと
# クライアント/CDNキャッシュが古いフレームを表示し続ける（別のPNGに見える）。
# フレームごとに一意な添付名を発行し、Embed画像URLもその名前へ合わせる。
_MAP_SEQ = 0

def d_next_map_filename():
    """フレームごとに一意な添付ファイル名を発行する。"""
    global _MAP_SEQ
    _MAP_SEQ += 1
    return f"map_{_MAP_SEQ:06d}.png"

def d_map_attachment(uid, floor, px, py, radius=D_VIEW_R):
    """現在の状態を描画し、(discord.File, Embed用画像URL) を返す。"""
    filename = d_next_map_filename()
    img = d_build_map_image(uid, floor, px, py, radius)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return discord.File(fp=buf, filename=filename), f"attachment://{filename}"

def d_render_pillow(uid, floor, px, py, radius=D_VIEW_R):
    """マップをPillow画像として生成しdiscord.Fileを返す（互換API）。"""
    return d_map_attachment(uid, floor, px, py, radius)[0]

async def d_render_image(uid, floor, px, py, bot, radius=D_VIEW_R):
    """マップを画像として生成しDiscordにアップロード、URLを返す"""
    img = d_build_map_image(uid, floor, px, py, radius)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    try:
        ch = bot.get_channel(DUNGEON_IMG_CHANNEL_ID) or \
             await bot.fetch_channel(DUNGEON_IMG_CHANNEL_ID)
        msg = await ch.send(file=discord.File(buf, filename="map.png"))
        return msg.attachments[0].url
    except Exception as e:
        print(f"画像アップロード失敗: {e}")
        return None

# ============================================================
#  DB 操作
# ============================================================

async def dg_load_all(supabase):
    """Supabaseから全ダンジョンデータを読み込む"""
    global dg_maps, dg_players, dg_starts, dg_used, dg_bases
    
    try:
        res = supabase.table("dungeon_maps").select("*").execute()
        for row in res.data:
            floor = row["floor"]
            dg_maps[floor] = json.loads(row["grid"])
            dg_used[floor] = set(tuple(p) for p in json.loads(row.get("used_coords", "[]")))
            if "start_pos" in row and row["start_pos"]:
                dg_starts[floor] = tuple(row["start_pos"])
        print(f"✓ ダンジョンマップ読み込み完了: {len(dg_maps)}フロア")
    except Exception as e:
        print(f"<:failed:1490986584676368535> ダンジョンマップ読み込み失敗: {e}")
    
    try:
        res = supabase.table("dungeon_players").select("*").execute()
        for row in res.data:
            inventory = dict(row.get("inventory", {}) or {})
            meta = inventory.pop("_dungeon_meta", {}) if isinstance(inventory, dict) else {}
            dg_players[row["user_id"]] = {
                "floor": row.get("floor", 1),
                "x": row.get("x", 1),
                "y": row.get("y", 1),
                "hp": row.get("hp", 100),
                "max_hp": row.get("max_hp", 100),
                "atk": row.get("atk", 10),
                "def_": row.get("def_", 3),
                "spd": row.get("spd", 10),
                "crit": row.get("crit", 0.05),
                "xp": row.get("xp", 0), "level": row.get("level", 1),
                "boxes": row.get("boxes", 0), "bread": row.get("bread", 0),
                "chips": row.get("chips", 0),
                "job": row.get("job", "warrior"),
                "equipment": row.get("equipment", {}) or {},
                "inventory": inventory,
                "achievements": row.get("achievements", []) or [],
                "season_id": row.get("season_id", SEASON_ID),
                "season_score": row.get("season_score", 0),
                "turns": row.get("turns", 0), "cooldowns": row.get("cooldowns", {}) or {},
                "relics": meta.get("relics", []) or [],
                "active_effects": meta.get("active_effects", []) or [],
                "materials": meta.get("materials", {}) or {},
                "quests": meta.get("quests", {}) or {},
                "run_modifiers": meta.get("run_modifiers", []) or [],
                "camp_facilities": meta.get("camp_facilities", {"inn": 1, "forge": 0, "guild": 0}),
                "battle_stats": meta.get("battle_stats", {"kills": 0, "chests": 0, "escapes": 0}),
                "skill_points": meta.get("skill_points", 0), "skills": meta.get("skills", []) or [],
                "npc_flags": meta.get("npc_flags", {}) or {}, "story_flags": meta.get("story_flags", {}) or {},
                "run_id": meta.get("run_id"), "run_summary": meta.get("run_summary", {}) or {},
                "pending_rewards": meta.get("pending_rewards", []) or [], "reward_ledger": meta.get("reward_ledger", []) or [],
                "action_log": meta.get("action_log", []) or [], "state_version": meta.get("state_version", 0),
                "front_back": meta.get("front_back", "front"), "battle_resource": meta.get("battle_resource", {"mp": 20, "max_mp": 20, "rage": 0, "combo": 0, "guard": 0}),
                "floor_goals": meta.get("floor_goals", {}) or {},
            }
        print(f"✓ ダンジョンプレイヤー読み込み完了: {len(dg_players)}人")
    except Exception as e:
        print(f"<:failed:1490986584676368535> ダンジョンプレイヤー読み込み失敗: {e}")
    
    try:
        res = supabase.table("dungeon_bases").select("*").execute()
        for row in res.data:
            dg_bases[row["user_id"]] = (row["floor"], row["x"], row["y"])
        print(f"✓ ダンジョン拠点読み込み完了: {len(dg_bases)}個")
    except Exception as e:
        print(f"<:failed:1490986584676368535> ダンジョン拠点読み込み失敗: {e}")

async def dg_save_map(floor, supabase):
    """フロアマップをSupabaseに保存"""
    if floor not in dg_maps:
        return
    try:
        grid_json = json.dumps(dg_maps[floor], ensure_ascii=False, separators=(",", ":"))
        used_coords = sorted(dg_used.get(floor, set()))
        start_pos = dg_starts.get(floor, (1, 1))
        payload = {
            "floor": floor,
            "grid": grid_json,
            "used_coords": json.dumps(used_coords, separators=(",", ":")),
            "start_pos": list(start_pos),
        }
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode()).hexdigest()
        if _MAP_SAVE_DIGESTS.get(floor) == digest:
            return
        supabase.table("dungeon_maps").upsert(payload, on_conflict="floor").execute()
        _MAP_SAVE_DIGESTS[floor] = digest
    except Exception as e:
        print(f"dg_save_map失敗 floor={floor}: {e}")

async def dg_save_player(uid, supabase):
    """プレイヤーのダンジョンデータをSupabaseに保存"""
    if uid not in dg_players:
        return
    try:
        p = dg_players[uid]
        inventory = dict(p.get("inventory", {}))
        # テーブル列を増やさずに拡張状態を保存するため、JSONメタへ集約する。
        inventory["_dungeon_meta"] = {
            "relics": p.get("relics", []),
            "active_effects": p.get("active_effects", []),
            "materials": p.get("materials", {}),
            "quests": p.get("quests", {}),
            "run_modifiers": p.get("run_modifiers", []),
            "camp_facilities": p.get("camp_facilities", {"inn": 1, "forge": 0, "guild": 0}),
            "battle_stats": p.get("battle_stats", {"kills": 0, "chests": 0, "escapes": 0}),
            "skill_points": p.get("skill_points", 0),
            "skills": p.get("skills", []),
            "npc_flags": p.get("npc_flags", {}),
            "story_flags": p.get("story_flags", {}),
            "run_id": p.get("run_id"),
            "run_summary": p.get("run_summary", {}),
            "pending_rewards": p.get("pending_rewards", []),
            "reward_ledger": p.get("reward_ledger", []),
            "action_log": p.get("action_log", [])[-100:],
            "state_version": p.get("state_version", 0),
            "front_back": p.get("front_back", "front"),
            "battle_resource": p.get("battle_resource", {}),
            "floor_goals": p.get("floor_goals", {}),
        }
        payload = {
            "user_id": uid,
            "floor": p["floor"],
            "x": p["x"],
            "y": p["y"],
            "hp": p["hp"],
            "max_hp": p["max_hp"],
            "atk": p["atk"],
            "def_": p["def_"],
            "spd": p["spd"],
            "crit": p["crit"],
            "xp": p.get("xp", 0), "level": p.get("level", 1),
            "boxes": p.get("boxes", 0), "bread": p.get("bread", 0),
            "chips": p.get("chips", 0),
            "job": p.get("job", "warrior"),
            "equipment": p.get("equipment", {}), "inventory": inventory,
            "achievements": p.get("achievements", []),
            "season_id": p.get("season_id", SEASON_ID),
            "season_score": p.get("season_score", 0), "turns": p.get("turns", 0),
            "cooldowns": p.get("cooldowns", {}),
        }
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode()).hexdigest()
        if _PLAYER_SAVE_DIGESTS.get(uid) == digest:
            return
        supabase.table("dungeon_players").upsert(payload, on_conflict="user_id").execute()
        _PLAYER_SAVE_DIGESTS[uid] = digest
    except Exception as e:
        print(f"dg_save_player失敗 uid={uid}: {e}")

async def dg_save_base(uid, floor, x, y, supabase):
    """プレイヤーの拠点をSupabaseに保存"""
    dg_bases[uid] = (floor, x, y)
    try:
        supabase.table("dungeon_bases").upsert({
            "user_id": uid,
            "floor": floor,
            "x": x,
            "y": y,
        }, on_conflict="user_id").execute()
    except Exception as e:
        print(f"dg_save_base失敗 uid={uid}: {e}")

# ============================================================
#  Views
# ============================================================
# ============================================================
#  D1 作戦ヘルパー（旧 d1_dangeon.py から統廃合）
# ============================================================
# D1へ渡す合法手。待機（enter/check）は選択肢に含めない。
D1_MOVE_KEYS = tuple(_DIRECTIONS)

D1_PLAN_GUIDANCE = {
    "safe": "HPと被弾を最優先で避け、敵の少ない経路で階段を目指す",
    "speed": "最短手数で階段へ向かう",
    "treasure": "宝箱・鉱山・祭壇などの報酬タイルを優先して回収する",
    "battle": "敵との戦闘を積極的に選び、経験値とドロップを稼ぐ",
    "explore": "未探索の床を広く踏んでマップを開拓する",
    "boss": "回復と装備を整え、ボスに備えてHPを高く保つ",
    "xp": "経験値効率の良い行動を選ぶ",
}


def d1_plan_key(plan):
    """表示名・キーのどちらからでも作戦キーを解決する。"""
    if plan in D1_PLANS:
        return plan
    for key, name in D1_PLANS.items():
        if name == plan:
            return key
    return "safe"


def d1_plan_guidance(plan):
    """作戦ごとの優先基準。D1への指示文に含める。"""
    return D1_PLAN_GUIDANCE.get(d1_plan_key(plan), D1_PLAN_GUIDANCE["safe"])


def d_floor_routes(uid):
    """フロア内の代表的な進み方。作戦スコアの比較対象。"""
    return [
        {"id": "safe", "label": "安全", "risk": 1, "reward": 1, "score": 4},
        {"id": "treasure", "label": "財宝", "risk": 3, "reward": 4, "score": 3},
        {"id": "battle", "label": "戦闘", "risk": 4, "reward": 5, "score": 2},
    ]


def d1_action_candidates(uid, plan="安全探索"):
    """作戦の重みを掛けた候補評価。危険度と報酬のどちらを取るかを明示する。"""
    routes = d_floor_routes(uid)
    weights = {"safe": (3, -2), "speed": (1, 5), "treasure": (4, 0), "battle": (-1, 2),
               "explore": (2, 1), "boss": (1, 3), "xp": (0, 4)}
    risk_w, reward_w = weights.get(d1_plan_key(plan), weights["safe"])
    for route in routes:
        route["plan_score"] = route["reward"] * reward_w - route["risk"] * risk_w
    return routes


def d1_candidate_log(uid, plan):
    """画面表示用の候補評価ログ。D1への入力には含めない（コンテキスト長対策）。"""
    candidates = d1_action_candidates(uid, plan)
    return "候補評価: " + " / ".join(
        f"{c['id']}:{c['label']} 危険度{c['risk']} 報酬{c['reward']} 作戦点{c['plan_score']}" for c in candidates
    )


def d_normalize_choice(value, legal, fallback=None):
    """D1の応答を合法手へ寄せる。表記ゆれだけを吸収し、それ以外はfallbackを返す。"""
    value = str(value or "").strip().lower().replace(" ", "")
    aliases = {"north": "up", "south": "down", "west": "left", "east": "right",
               "upward": "up", "downward": "down", "leftward": "left", "rightward": "right",
               "northeast": "rightup", "northwest": "leftup", "southeast": "rightdown", "southwest": "leftdown"}
    value = aliases.get(value, value)
    return value if value in legal else (fallback if fallback in legal else None)


def d1_cell_label(floor, x, y):
    """セルの日本語ラベル。D1へ選択肢の基準を渡すために使う。"""
    cell = d_get_cell(floor, x, y)
    return {
        D_WALL: "壁", D_FLOOR: "床", D_START: "開始地点", D_STAIRS: "階段", D_CHEST: "宝箱",
        D_TRAP: "罠", D_SHOP: "商店", D_BASE: "拠点", D_MINE: "鉱山", D_REST: "休憩所",
        D_SHRINE: "祭壇", D_EVENT: "イベント",
    }.get(cell, "床")


def d1_relative_label(dx, dy):
    """差分ベクトルを方角ラベルへ変換する。"""
    if dx == 0 and dy == 0:
        return "現在地"
    parts = []
    if dy < 0:
        parts.append("北")
    elif dy > 0:
        parts.append("南")
    if dx < 0:
        parts.append("西")
    elif dx > 0:
        parts.append("東")
    return "".join(parts)


def d1_bfs(floor, x, y):
    """現在地からの歩数マップ（8方向・壁と角抜けは通行不可）。"""
    dist = {(x, y): 0}
    queue = [(x, y)]
    head = 0
    while head < len(queue):
        cx, cy = queue[head]
        head += 1
        step = dist[(cx, cy)] + 1
        for dx, dy in _DIRECTIONS.values():
            nx, ny = cx + dx, cy + dy
            if (nx, ny) in dist or not (0 <= nx < D_MAP_W and 0 <= ny < D_MAP_H):
                continue
            if d_get_cell(floor, nx, ny) == D_WALL:
                continue
            if dx and dy and (d_get_cell(floor, cx + dx, cy) == D_WALL or d_get_cell(floor, cx, cy + dy) == D_WALL):
                continue
            dist[(nx, ny)] = step
            queue.append((nx, ny))
    return dist


def d1_stairs_cell(floor):
    """フロア内の階段座標を返す。"""
    d_ensure_map(floor)
    for gy, row in enumerate(dg_maps[floor]):
        for gx, cell in enumerate(row):
            if cell == D_STAIRS:
                return (gx, gy)
    return None


def d1_stairs_hint(floor, x, y, dist=None):
    """階段までの方角と歩数。D1が迷わないための明示的な目標情報。"""
    stairs = d1_stairs_cell(floor)
    if not stairs:
        return "このフロアに階段なし"
    if dist is None:
        dist = d1_bfs(floor, x, y)
    steps = dist.get(stairs)
    if steps is None:
        return "階段は壁で区切られ到達不可"
    return f"{d1_relative_label(stairs[0] - x, stairs[1] - y)} {steps}マス"


def d1_surround_text(floor, x, y):
    """現在地と8方向のタイルを短く列挙する。"""
    parts = [f"現在地={d1_cell_label(floor, x, y)}"]
    for key, (dx, dy) in _DIRECTIONS.items():
        parts.append(f"{_DIRECTION_LABELS[key]}={d1_cell_label(floor, x + dx, y + dy)}")
    return " ".join(parts)


def d1_local_grid(floor, x, y):
    """画像に依存しない3x3局所盤面。#は壁、@は現在地、.は通行可能。"""
    symbols = {
        D_WALL: "#", D_FLOOR: ".", D_START: ".", D_STAIRS: "S", D_CHEST: "C",
        D_TRAP: "T", D_SHOP: "$", D_BASE: "B", D_MINE: "M", D_REST: "R",
        D_SHRINE: "H", D_EVENT: "E",
    }
    rows = []
    for dy in (-1, 0, 1):
        cells = []
        for dx in (-1, 0, 1):
            cells.append("@" if (dx, dy) == (0, 0) else symbols.get(d_get_cell(floor, x + dx, y + dy), "#"))
        rows.append("".join(cells))
    return " / ".join(rows) + "（#=壁・進入不可 @=現在地 .=通行可 S=階段）"


def d1_move_criteria(floor, x, y, dist=None):
    """D1へ渡す「各方向がどういう状況か」の基準。壁・特殊タイル・階段距離を明示する。"""
    if dist is None:
        dist = d1_bfs(floor, x, y)
    stairs = d1_stairs_cell(floor)
    stairs_steps = dist.get(stairs) if stairs else None
    criteria = {}
    for key, (dx, dy) in _DIRECTIONS.items():
        label = _DIRECTION_LABELS[key]
        nx, ny = x + dx, y + dy
        if not (0 <= nx < D_MAP_W and 0 <= ny < D_MAP_H):
            criteria[key] = f"{label}はマップ外（進めない）"
            continue
        if d_get_cell(floor, nx, ny) == D_WALL:
            criteria[key] = f"{label}は壁（進めない）"
            continue
        if dx and dy and (d_get_cell(floor, x + dx, y) == D_WALL or d_get_cell(floor, x, y + dy) == D_WALL):
            criteria[key] = f"{label}は角の壁に阻まれて進めない"
            continue
        note = f"{label}は{d1_cell_label(floor, nx, ny)}（移動可）"
        steps = dist.get((nx, ny))
        if stairs_steps is not None and steps is not None:
            note += f" 階段まで{steps}マス" + ("（近づく）" if steps < stairs_steps else "")
        criteria[key] = note
    return criteria


def d1_goal_text(uid):
    """D1へ渡すゴール。階層目標・フロア目標・クエストを短くまとめる。"""
    p = d_get_player(uid)
    floor = p["floor"]
    parts = [f"{min(floor + 1, D_FLOORS)}Fへ進むため階段を探す"]
    goal = p.get("floor_goals", {}).get(str(floor))
    if goal and not goal.get("completed"):
        name = next((v["name"] for v in FLOOR_GOALS.values() if v["kind"] == goal.get("kind")), "フロア目標")
        parts.append(f"フロア目標: {name} {goal.get('progress', 0)}/{goal.get('target', 3)}")
    quests, _ = d_content_summary(uid)
    if quests:
        parts.append("クエスト: " + "、".join(quests[:2]))
    return " / ".join(parts)


def d1_best_direction(uid, plan="安全探索", dist=None):
    """D1の応答が使えない時のフォールバック。作戦に沿った合法手を必ず1つ返す。"""
    p = d_get_player(uid)
    floor, x, y = p["floor"], p["x"], p["y"]
    if dist is None:
        dist = d1_bfs(floor, x, y)
    criteria = d1_move_criteria(floor, x, y, dist)
    legal = [key for key, text in criteria.items() if "移動可" in text]
    if not legal:
        return "up"
    specials = ("宝箱", "鉱山", "祭壇", "イベント", "商店", "休憩所", "階段")
    if d1_plan_key(plan) == "treasure":
        ranked = sorted(legal, key=lambda k: (
            not any(word in criteria[k] for word in specials),
            dist.get((x + _DIRECTIONS[k][0], y + _DIRECTIONS[k][1]), 9999),
        ))
    else:
        ranked = sorted(legal, key=lambda k: dist.get((x + _DIRECTIONS[k][0], y + _DIRECTIONS[k][1]), 9999))
    return ranked[0]


def d_make_reward_choices(uid, enemy):
    """戦闘勝利時の3候補。作戦教本を持つとコイン報酬が少し強化される。"""
    p = d_get_player(uid)
    base = [
        {"label": "コイン", "reward": {"coins": enemy.get("reward_coins", 0)}},
        {"label": "経験値", "reward": {"xp": enemy.get("reward_xp", 0)}},
        {"label": "宝箱", "reward": {"boxes": max(1, enemy.get("reward_box", 0))}},
    ]
    if "d1_tactics" in p.get("relics", []):
        base[0]["reward"]["season_score"] = 10
    return base


def d_choose_reward(uid, choice):
    """保留中の報酬から1つだけ取り出し、残りは破棄する。

    候補を残したままにすると、古い報酬ボタンをもう一度押された時に
    2つ目の報酬まで受け取れてしまうため、選択と同時に必ず空にする。
    """
    p = d_get_player(uid)
    pending = p.setdefault("pending_rewards", [])
    if not pending or choice not in range(len(pending)):
        return None
    reward = pending[choice]
    p["pending_rewards"] = []
    return reward


def d_begin_run(uid, mode="manual"):
    """既存のゲームハブから開始したダンジョン状態を引き継いで走行記録だけを開始する。"""
    p = d_get_player(uid)
    p["run_id"] = f"run-{uid}-{int(datetime.datetime.now().timestamp())}"
    p["run_started_at"] = datetime.datetime.now(JST).isoformat()
    p["run_summary"] = {
        "mode": mode, "turns": p.get("turns", 0), "kills": p.get("battle_stats", {}).get("kills", 0),
        "floor": p["floor"], "inherited": True,
    }
    return p["run_id"]


def d_end_run(uid, reason="ended"):
    """走行記録だけを閉じる。HP・状態異常・クールダウンはダンジョンと共有のため初期化しない。"""
    p = d_get_player(uid)
    p.setdefault("run_summary", {})["end_reason"] = reason
    p["run_id"] = None
    return p["run_summary"]


def d_record_action(uid, action, source="manual", result=None, reward=None, hp_before=None):
    """行動ログを記録する。D1の判断材料とUI表示の双方で使う。"""
    p = d_get_player(uid)
    p["state_version"] += 1
    entry = {
        "id": p["state_version"], "run_id": p.get("run_id"), "turn": p.get("turns", 0),
        "floor": p["floor"], "x": p["x"], "y": p["y"], "action": action, "source": source,
        "result": result, "reward": reward, "hp_before": hp_before, "hp_after": p["hp"],
        "created_at": datetime.datetime.now(JST).isoformat(),
    }
    p["action_log"] = (p.get("action_log", []) + [entry])[-100:]
    return entry


def d_record_reward(uid, action_id, reward):
    """同じ行動への二重付与を防ぐ台帳。"""
    p = d_get_player(uid)
    if action_id in [x.get("action_id") for x in p.get("reward_ledger", [])]:
        return False
    p["reward_ledger"].append({
        "action_id": action_id, "reward": reward, "created_at": datetime.datetime.now(JST).isoformat()
    })
    return True


def d_use_job_skill(uid, enemy):
    """職業スキルを1回実行し、表示用ログとダメージを返す。"""
    p = d_get_player(uid)
    job = JOB_MASTER.get(p.get("job", "warrior"), JOB_MASTER["warrior"])
    skill = job.get("skill", "power_strike")
    cooldowns = p.setdefault("cooldowns", {})
    if cooldowns.get(skill, 0) > 0:
        return f"{skill}はあと{cooldowns[skill]}ターン使用できません。", 0
    stats = d_effective_stats(p)
    cooldowns[skill] = 3
    if skill == "power_strike":
        damage = max(1, stats["atk"] * 2 - enemy.get("def_", 0))
        cooldowns[skill] = 2
        return f"戦士の強撃！ {damage}ダメージ", damage
    if skill == "smoke_bomb":
        cooldowns["smoke_buff"] = 2
        return "盗賊の煙幕！ 次の逃走成功率が上がった。", 0
    if skill == "fireball":
        damage = max(1, int(stats["atk"] * 2.2) - enemy.get("def_", 0))
        return f"魔術師の火球！ {damage}ダメージ", damage
    if skill == "heal":
        before = p["hp"]
        p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
        return f"僧侶の回復！ HPが{p['hp'] - before}回復", 0
    if skill == "blessing":
        cooldowns["blessing_buff"] = 3
        return "僧侶の祝福！ 次の防御力が上昇", 0
    if skill in ("cleanse", "tonic"):
        p["active_effects"] = []
        p.setdefault("battle_flags", {}).clear()
        return "状態異常を解除しました", 0
    if skill in ("mark", "curse", "acid"):
        d_apply_special_status(uid, "curse" if skill == "curse" else "bleed", 3)
        damage = max(1, int(stats["atk"] * 1.4) - enemy.get("def_", 0))
        return f"{job['name']}の{skill}！ {damage}ダメージ", damage
    if skill in ("first_shot", "scout", "lucky_find"):
        damage = max(1, int(stats["atk"] * 1.8) - enemy.get("def_", 0))
        return f"{job['name']}の先制攻撃！ {damage}ダメージ", damage
    if skill in ("taunt", "iron_wall"):
        p.setdefault("battle_resource", {})["guard"] = 8
        return f"{job['name']}の鉄壁！ 防御力が上昇", 0
    if skill in ("counter", "drain"):
        damage = max(1, int(stats["atk"] * 1.6) - enemy.get("def_", 0))
        return f"{job['name']}の反撃！ {damage}ダメージ", damage
    if skill in ("cook", "feast"):
        resource = p.setdefault("battle_resource", {"mp": 20, "max_mp": 20, "rage": 0, "combo": 0, "guard": 0})
        resource["rage"] = min(100, resource.get("rage", 0) + 30)
        return "料理人の料理！ 怒気が上昇", 0
    return "様子を見た。", 0


class _NoopResponse:
    """自動操作中に画面更新を無効化するためのダミー応答。"""

    async def edit_original_response(self, **kwargs):
        return None

    async def send_message(self, *args, **kwargs):
        return None


class _NoopInteraction:
    """自動操作から既存のView処理を再利用するためのダミーInteraction。"""
    response = _NoopResponse()

    async def edit_original_response(self, **kwargs):
        return None


# 実行中の自動操作ヤー。DungeonCogが生成し、各Viewから参照する。
_D1_PLAYER = None


def d_lock_callback(func):
    """ユーザー単位のロックを取り、同時操作による二重適用を防ぐ。"""
    async def wrapped(self, interaction, button):
        lock = d_get_lock(self.uid)
        if lock.locked():
            await interaction.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        async with lock:
            return await func(self, interaction, button)
    wrapped.__name__ = func.__name__
    wrapped.__doc__ = func.__doc__
    return wrapped


class DungeonViewBase(View):
    """全ダンジョンUIの共通基底。所有者以外の操作を拒否し、常に最新のプレイヤー状態を参照する。"""

    def __init__(self, uid, *, timeout):
        super().__init__(timeout=timeout)
        self.uid = str(uid)

    def sync_state(self):
        """生成時のスナップショットではなく、保存済みプレイヤー状態を正とする。"""
        p = d_get_player(self.uid)
        self.floor, self.x, self.y = p["floor"], p["x"], p["y"]
        return p

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if str(interaction.user.id) != self.uid:
            await interaction.response.send_message(
                "このダンジョン画面は開始者本人のみ操作できます。", ephemeral=True
            )
            return False
        return True

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True


def d_dungeon_view(uid, supabase=None, plan=None):
    """保存済み状態から統合パネルを作り直す。全画面の「戻る」はここへ揃える。"""
    p = d_get_player(uid)
    return DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], supabase, plan=plan)


async def d_return_to_dungeon(interaction, uid, supabase, msg=""):
    """現在状態の統合パネルへ戻る。全画面共通の復帰処理。"""
    p = d_get_player(uid)
    view = d_dungeon_view(uid, supabase)
    map_file, map_url = d_map_attachment(uid, p["floor"], p["x"], p["y"])
    await interaction.edit_original_response(
        embed=view._embed(msg, image_url=map_url), view=view, attachments=[map_file]
    )


def d1_plan_for(uid):
    """現在のD1作戦。実行中は実行中のもの、停止中は最後に選んだものを返す。"""
    if _D1_PLAYER is None:
        return D1_PLANS["safe"]
    return _D1_PLAYER.plan_for(uid)


def d1_status_text(uid):
    """ステータス画面に表示するD1の実行状況。"""
    if _D1_PLAYER is None:
        return "未初期化"
    return _D1_PLAYER.status_text(uid)


class DungeonStatusView(DungeonViewBase):
    """ステータス表示。自動操作の接続と作戦選択はこの画面へ集約する。"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=300)
        self.floor = floor
        self.x = x
        self.y = y
        self.supabase = supabase
        self.d1_plan = d1_plan_for(uid)

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        em = discord.Embed(title="ダンジョン ステータス", description=msg, color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="現在位置", value=f"フロア **{p['floor']}** ({p['x']}, {p['y']}) / {d_floor_modifier(p['floor'])}", inline=False)
        em.add_field(name="HP", value=f"{d_hpbar(p['hp'], stats['max_hp'])} {p['hp']}/{stats['max_hp']}", inline=False)
        em.add_field(name="職業", value=d_job_name(self.uid), inline=True)
        em.add_field(name="ステータス", value=f"ATK:{stats['atk']} DEF:{stats['def_']} SPD:{stats['spd']} CRIT:{int(stats['crit']*100)}%", inline=False)
        effects = [STATUS_EFFECTS.get(e.get('key'), {}).get('name', e.get('key')) for e in p.get('active_effects', []) if isinstance(e, dict)]
        em.add_field(name="成長", value=f"Lv.{p['level']} XP:{p['xp']} / 次:{p['level']*100}\n実績:{len(p['achievements'])}/{len(ACHIEVEMENTS)} スコア:{p['season_score']}", inline=False)
        em.add_field(name="状態異常", value="、".join(effects) if effects else "なし", inline=True)
        em.add_field(name="遺物・属性", value=f"遺物: {', '.join(RELIC_MASTER.get(k, {}).get('name', k) for k in p.get('relics', [])) or 'なし'}\n装備属性: {', '.join(EQUIPMENT_MASTER.get(k, {}).get('element', 'none') for k in p.get('equipment', {}).values()) or 'none'}", inline=False)
        quests, _ = d_content_summary(self.uid)
        em.add_field(name="クエスト", value="\n".join(quests) if quests else "全クエスト達成", inline=False)
        em.add_field(name="自動操作", value=f"作戦: **{self.d1_plan}**\n状態: {d1_status_text(self.uid)}", inline=False)
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    @discord.ui.button(label="自動操作開始", style=discord.ButtonStyle.blurple, row=0)
    async def start_d1(self, interaction, button):
        if _D1_PLAYER is None:
            await interaction.response.send_message("自動操作機能が初期化されていません。", ephemeral=True)
            return
        # 押した時点の現在状態と作戦でD1を開始する（状態はダンジョンと共有）。
        await _D1_PLAYER.start(interaction, self.d1_plan)

    @discord.ui.button(label="操作メニュー", style=discord.ButtonStyle.green, row=0)
    async def operations(self, interaction, button):
        await interaction.response.defer()
        p = self.sync_state()
        op = DungeonOperationView(self.uid, p["floor"], p["x"], p["y"], self.supabase)
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=op._embed("操作メニュー", image_url=map_url), view=op, attachments=[map_file]
        )

    @discord.ui.button(label="ダンジョンへ戻る", style=discord.ButtonStyle.grey, row=0)
    async def back(self, interaction, button):
        await interaction.response.defer()
        await d_return_to_dungeon(interaction, self.uid, self.supabase, "")

    @discord.ui.select(
        placeholder="D1作戦を選択",
        options=[discord.SelectOption(label=name, value=key) for key, name in D1_PLANS.items()],
        row=1,
    )
    async def select_plan(self, interaction, select):
        await interaction.response.defer()
        self.d1_plan = D1_PLANS.get(select.values[0], D1_PLANS["safe"])
        if _D1_PLAYER is not None:
            # 実行中の場合は走行中の作戦も即時更新する。
            _D1_PLAYER.set_plan(self.uid, self.d1_plan)
        await self._render(interaction, f"D1作戦を **{self.d1_plan}** に設定しました。")


class DungeonStairsView(DungeonViewBase):
    """階段View"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=180)
        self.floor = floor
        self.x = x
        self.y = y
        self.supabase = supabase

    def _embed(self, msg="", image_url=None):
        em = discord.Embed(title="階段がある", color=0xFFFFFF, description=msg)
        if image_url:
            em.set_image(url=image_url)
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    @discord.ui.button(label="上へ進む", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def up(self, i, b):
        await i.response.defer()
        p = self.sync_state()
        floor = p["floor"]
        if floor < D_FLOORS:
            p["floor"] = floor + 1
            p["hp"] = d_effective_stats(p)["max_hp"]
            d_ensure_map(p["floor"])
            p["x"], p["y"] = dg_starts[p["floor"]]
            d_progress_quest(self.uid, "floor", 1)
            await dg_save_player(self.uid, self.supabase)
            await d_return_to_dungeon(i, self.uid, self.supabase, f"フロア {p['floor']}へ到達！")
        else:
            await i.edit_original_response(embed=discord.Embed(title="ゴール！", description="ダンジョンをクリアしました！", color=0xFFFFFF))

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.supabase, "")


class DungeonMineView(DungeonViewBase):
    """採掘View"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=60)
        self.floor = floor
        self.x = x
        self.y = y
        self.supabase = supabase

    def _embed(self, msg="", image_url=None):
        em = discord.Embed(title="鉱山", color=0xFFFFFF, description=msg)
        if image_url:
            em.set_image(url=image_url)
        return em

    @discord.ui.button(label="⛏ 採掘する", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def mine(self, i, b):
        await i.response.defer()
        gain = d_do_mine(self.uid)
        await d_apply_reward(self.uid, self.supabase, coins=gain)
        d_consume(self.floor, self.x, self.y)
        await dg_save_map(self.floor, self.supabase)
        await dg_save_player(self.uid, self.supabase)
        await d_return_to_dungeon(i, self.uid, self.supabase, f"採掘！ **+{gain}** コイン")

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.supabase, "")


class DungeonShopView(DungeonViewBase):
    """軽量な商店View。購入はサーバー側で価格を検証する。"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.supabase = floor, x, y, supabase

    def _embed(self, msg="", image_url=None):
        p = d_get_player(self.uid)
        em = discord.Embed(title="旅の商店", description=msg, color=0xB450C8)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="レアパン 30 AGO", value="HPを回復するアイテム", inline=True)
        em.add_field(name="革鎧 250 AGO", value="DEF+3 / HP+15", inline=True)
        em.add_field(name="所持", value=f"レアパン:{p['bread']} / 宝箱:{p['boxes']}", inline=False)
        return em

    async def _buy(self, i, price, reward, label):
        await i.response.defer()
        try:
            await d_apply_reward(self.uid, self.supabase, coins=-price, **reward)
            msg = f"{label}を購入しました。"
        except Exception:
            msg = "コインが足りないか、購入に失敗しました。"
        await dg_save_player(self.uid, self.supabase)
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await i.edit_original_response(embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file])

    @discord.ui.button(label="パンを買う", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def buy_bread(self, i, b):
        await self._buy(i, 30, {"bread": 1}, "レアパン")

    @discord.ui.button(label="革鎧を買う", style=discord.ButtonStyle.blurple)
    @d_lock_callback
    async def buy_armor(self, i, b):
        await self._buy(i, 250, {"equipment": "leather_armor"}, "革鎧")

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey, row=1)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.supabase, "")


class DungeonCombatView(DungeonViewBase):
    """戦闘View"""

    def __init__(self, uid, floor, x, y, enemy, supabase):
        super().__init__(uid, timeout=180)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.enemy = enemy
        self.log = []
        self.defending = False
        self.supabase = supabase

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        e = self.enemy
        p_stats = d_effective_stats(p)

        etype = e.get("type", "normal")
        type_text = {"normal": "通常", "elite": "精鋭", "boss": "ボス"}.get(etype, "通常")

        em = discord.Embed(title=f"{e['name']}（{type_text}）が現れた！", color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)

        em.add_field(name="あなた",
                     value=f"`{d_hpbar(p['hp'],p_stats['max_hp'])}`{p['hp']}/{p_stats['max_hp']}\nATK:{p_stats['atk']} DEF:{p_stats['def_']}",
                     inline=True)

        em.add_field(name=e["name"],
                     value=f"`{d_hpbar(e['hp'],e['max_hp'])}`{e['hp']}/{e['max_hp']}\nATK:{e['atk']} DEF:{e['def_']}",
                     inline=True)

        player_first = p_stats.get("spd", 10) >= e.get("spd", 10)
        raw_name = e["name"].split()[0].replace("👾", "").strip()
        enemy_ai = ENEMY_STATS_MASTER.get(raw_name, ENEMY_STATS_MASTER["default"]).get("ai", ["attack"])
        preview = {"attack": "通常攻撃", "strong_attack": "強攻撃", "heal": "回復", "wait": "様子見"}
        next_action = preview.get(enemy_ai[0], "通常攻撃")
        em.add_field(
            name="行動順 / 敵の予告",
            value=f"{'あなた → ' + e['name'] if player_first else e['name'] + ' → あなた'}\n次: **{next_action}**",
            inline=False,
        )

        if self.log:
            em.add_field(name="ログ", value="\n".join(self.log[-5:]), inline=False)
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    def _calculate_damage(self, attacker, defender, is_defending=False):
        attacker_stats = d_effective_stats(attacker) if "job" in attacker else attacker
        defender_stats = d_effective_stats(defender) if "job" in defender else defender
        is_crit = random.random() < attacker_stats.get("crit", 0.05)
        target_def = defender_stats.get("def_", 0)
        if is_defending:
            target_def *= 2
        dmg = max(1, attacker_stats["atk"] - target_def + random.randint(-2, 3))
        # プレイヤーの属性は装備中の武器から解決する。
        attacker_element = attacker.get("element", "none") if isinstance(attacker, dict) else "none"
        if "job" in attacker:
            weapon_key = attacker.get("equipment", {}).get("weapon")
            attacker_element = EQUIPMENT_MASTER.get(weapon_key, {}).get("element", "none")
        defender_element = defender.get("element", "none") if isinstance(defender, dict) else "none"
        if attacker_element in ELEMENTS and defender_element in ELEMENTS:
            if defender_element in ELEMENTS[attacker_element].get("weak", []):
                dmg = int(dmg * 1.35)
            elif defender_element in ELEMENTS[attacker_element].get("resist", []):
                dmg = max(1, int(dmg * 0.75))
        if is_crit:
            return int(dmg * 1.5), True
        return dmg, False

    def _enemy_turn(self):
        p = d_get_player(self.uid)
        e = self.enemy
        flags = p.setdefault("battle_flags", {})
        # 凍結・麻痺は行動そのものを失う。付与時の状態異常処理はここで消化する。
        if flags.pop("skip_next", False):
            self.defending = False
            return "凍結で行動できませんでした"
        if flags.pop("paralyzed", False) and random.random() < 0.5:
            self.defending = False
            return "麻痺で行動に失敗しました"

        effect_logs = d_tick_status(self.uid)
        raw_name = e["name"].split()[0].replace("👾", "").strip()
        master = ENEMY_STATS_MASTER.get(raw_name, ENEMY_STATS_MASTER["default"])
        action = random.choice(master.get("ai", ["attack"]))

        log_msg = ""
        if action == "strong_attack":
            dmg, crit = self._calculate_damage(e, p, self.defending)
            dmg = int(dmg * 1.4)
            p["hp"] = max(0, p["hp"] - dmg)
            log_msg = f"**{e['name']}の強攻撃！！** {dmg} ダメージ"
        elif action == "heal":
            heal_amt = int(e["max_hp"] * 0.15)
            e["hp"] = min(e["max_hp"], e["hp"] + heal_amt)
            log_msg = f"{e['name']}は傷口を舐めて {heal_amt} 回復した"
        elif action == "wait":
            log_msg = f"{e['name']}は様子を伺っている..."
        else:
            dmg, crit = self._calculate_damage(e, p, self.defending)
            p["hp"] = max(0, p["hp"] - dmg)
            c_msg = "**CRITICAL!!** " if crit else ""
            log_msg = f"{c_msg}{e['name']}の攻撃：{dmg} ダメージ"

        if p["hp"] > 0 and random.random() < 0.25 and e.get("status_effect"):
            d_apply_special_status(self.uid, e["status_effect"])
            log_msg += f" / {STATUS_EFFECTS[e['status_effect']]['name']}を受けた"

        self.defending = False
        p_cooldowns = d_get_player(self.uid).setdefault("cooldowns", {})
        for key in list(p_cooldowns):
            if p_cooldowns[key] > 0:
                p_cooldowns[key] -= 1
        result = " / ".join(effect_logs + [log_msg])
        if flags.get("cursed"):
            p["hp"] = max(0, p["hp"] - 2)
            result += " / 呪いで2ダメージ"
        return result

    async def _register_kill(self):
        """撃破の記録・実績・クエストを、報酬の受け取り方法に関わらず一度だけ処理する。"""
        p = d_get_player(self.uid)
        stats = p.setdefault("battle_stats", {})
        stats["kills"] = stats.get("kills", 0) + 1
        if self.enemy.get("type") == "boss":
            d_unlock_achievement(self.uid, "first_boss")
        d_apply_floor_goal(self.uid, "kills", 1)
        for quest_key in d_progress_quest(self.uid, "kills", 1):
            await d_apply_reward(self.uid, self.supabase, **QUEST_MASTER[quest_key]["reward"])

    async def _win(self, i):
        e = self.enemy
        p = d_get_player(self.uid)
        if isinstance(i, _NoopInteraction):
            # 自動操作中は選択UIを挟まず、その場で戦利品を反映する。
            p["pending_rewards"] = []
            await self._register_kill()
            await d_apply_reward(
                self.uid, self.supabase,
                coins=e["reward_coins"], xp=e["reward_xp"], boxes=e["reward_box"],
                season_score=500 if e.get("type") == "boss" else 25,
            )
            msg = f"勝利！ +{e['reward_coins']}コイン +{e['reward_xp']}XP"
            if e["reward_box"] > 0:
                msg += f" +宝箱{e['reward_box']}個"
            self.log.append(msg)
            await dg_save_player(self.uid, self.supabase)
            return

        choices = d_make_reward_choices(self.uid, e)
        await self._register_kill()
        p["pending_rewards"] = [c["reward"] for c in choices]
        self.log.append("勝利！報酬を3候補から1つ選択してください")
        await dg_save_player(self.uid, self.supabase)
        self.stop()
        view = DungeonRewardChoiceView(self.uid, self.floor, self.x, self.y, self.supabase, choices)
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await i.edit_original_response(embed=self._embed(image_url=map_url), view=view, attachments=[map_file])

    async def _lose(self, i):
        p = d_get_player(self.uid)
        p["hp"] = d_effective_stats(p)["max_hp"]
        p["floor"] = 1
        p["x"], p["y"] = dg_starts.get(1, (1, 1))
        self.log.append("敗北… スタート地点へ送還された")
        await dg_save_player(self.uid, self.supabase)
        self.stop()
        if isinstance(i, _NoopInteraction):
            return
        await d_return_to_dungeon(i, self.uid, self.supabase, "敗北して戻された…")

    @discord.ui.button(label="攻撃", style=discord.ButtonStyle.red, row=0)
    @d_lock_callback
    async def attack(self, i, b):
        await i.response.defer()
        p = d_get_player(self.uid)
        e = self.enemy
        p_first = d_effective_stats(p).get("spd", 10) >= e.get("spd", 10)

        if p_first:
            dmg, crit = self._calculate_damage(p, e)
            e["hp"] = max(0, e["hp"] - dmg)
            self.log.append(f"{'**CRIT!!** ' if crit else ''}{dmg} ダメージ！")
            if e["hp"] <= 0:
                await self._win(i)
                return
            self.log.append(self._enemy_turn())
        else:
            self.log.append(self._enemy_turn())
            if p["hp"] <= 0:
                await self._lose(i)
                return
            dmg, crit = self._calculate_damage(p, e)
            e["hp"] = max(0, e["hp"] - dmg)
            self.log.append(f"{'**CRIT!!** ' if crit else ''}{dmg} ダメージ！")

        if e["hp"] <= 0:
            await self._win(i)
            return
        if p["hp"] <= 0:
            await self._lose(i)
            return
        await self._render(i)

    @discord.ui.button(label="防御", style=discord.ButtonStyle.blurple, row=0)
    @d_lock_callback
    async def defend(self, i, b):
        await i.response.defer()
        self.defending = True
        self.log.append(f"防御体制！\n{self._enemy_turn()}")
        if d_get_player(self.uid)["hp"] <= 0:
            await self._lose(i)
            return
        await self._render(i)

    @discord.ui.button(label="逃走", style=discord.ButtonStyle.grey, row=0)
    @d_lock_callback
    async def run_away(self, i, b):
        await i.response.defer()
        if self.enemy.get("type") == "boss":
            self.log.append("ボスからは逃げられない！\n" + self._enemy_turn())
            if d_get_player(self.uid)["hp"] <= 0:
                await self._lose(i)
                return
            await self._render(i)
            return

        p = d_get_player(self.uid)
        escape_rate = 0.2 if self.enemy.get("type") == "elite" else 0.5
        if p.get("cooldowns", {}).get("smoke_buff", 0) > 0:
            escape_rate = min(0.95, escape_rate + 0.30)
        if random.random() < escape_rate:
            self.stop()
            await d_return_to_dungeon(i, self.uid, self.supabase, "逃走成功")
        else:
            self.log.append("逃げ失敗！\n" + self._enemy_turn())
            if d_get_player(self.uid)["hp"] <= 0:
                await self._lose(i)
                return
            await self._render(i)

    @discord.ui.button(label="スキル", style=discord.ButtonStyle.blurple, row=1)
    @d_lock_callback
    async def skill(self, i, b):
        await i.response.defer()
        p = d_get_player(self.uid)
        log, damage = d_use_job_skill(self.uid, self.enemy)
        self.enemy["hp"] = max(0, self.enemy["hp"] - damage)
        self.log.append(log)
        d_unlock_achievement(self.uid, "skill_user")
        if self.enemy["hp"] <= 0:
            await self._win(i)
            return
        self.log.append(self._enemy_turn())
        if p["hp"] <= 0:
            await self._lose(i)
            return
        await dg_save_player(self.uid, self.supabase)
        await self._render(i)


class DungeonMainView(DungeonViewBase):
    """ダンジョンメインView（統合パネルの基底）"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=600)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.supabase = supabase

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        bname, _, _, _, _ = d_get_biome(p["floor"])
        em = discord.Embed(title=f"フロア {p['floor']} ({bname})", color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="位置", value=f"{p['floor']}F / ({p['x']}, {p['y']}) / {d_floor_modifier(p['floor'])}", inline=True)
        em.add_field(name="HP", value=f"{d_hpbar(p['hp'], stats['max_hp'])} {p['hp']}/{stats['max_hp']}", inline=True)
        quests, relics = d_content_summary(self.uid)
        em.add_field(name="冒険パネル", value=f"職業: {d_job_name(self.uid)}\nターン: {p['turns']} / スコア: {p['season_score']}\n遺物: {', '.join(relics) if relics else 'なし'}", inline=False)
        em.add_field(name="進行中の目的", value="\n".join(quests) if quests else "全クエスト達成", inline=False)
        em.add_field(name="自動操作", value=f"作戦: {getattr(self, 'd1_plan', d1_plan_for(self.uid))} / 状態: {d1_status_text(self.uid)}", inline=False)
        if msg:
            em.add_field(name="ログ", value=msg, inline=False)
        return em

    async def _redraw(self, interaction, msg, p, view=None):
        """現在のプレイヤー状態から1枚の画面（Embed＋画像）を作り直す。"""
        target = view or self
        target.floor, target.x, target.y = p["floor"], p["x"], p["y"]
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=target._embed(msg, image_url=map_url), view=target, attachments=[map_file]
        )

    async def _move(self, i, dx, dy):
        lock = d_get_lock(self.uid)
        if lock.locked():
            await i.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        await lock.acquire()
        try:
            await self._move_locked(i, dx, dy)
        finally:
            lock.release()

    async def _move_locked(self, i, dx, dy):
        await i.response.defer()

        # ビュー生成時のスナップショットではなく、常に保存済みの現在状態を使う。
        p = self.sync_state()
        floor = p["floor"]
        nx, ny = p["x"] + dx, p["y"] + dy

        # 境界チェック
        if not (0 <= nx < D_MAP_W and 0 <= ny < D_MAP_H):
            await self._redraw(i, "壁！進めない", p)
            return

        ct = d_get_cell(floor, nx, ny)
        if dx != 0 and dy != 0 and (
            d_get_cell(floor, p["x"] + dx, p["y"]) == D_WALL
            or d_get_cell(floor, p["x"], p["y"] + dy) == D_WALL
        ):
            ct = D_WALL
        if ct == D_WALL:
            await self._redraw(i, "壁！進めない", p)
            return

        # 座標更新
        p["x"], p["y"] = nx, ny

        msg = ""

        p["turns"] += 1
        p["season_score"] += 1
        completed_quests = d_progress_quest(self.uid, "turns", 1)
        for quest_key in completed_quests:
            quest_reward = QUEST_MASTER[quest_key]["reward"]
            await d_apply_reward(self.uid, self.supabase, **quest_reward)
        d_unlock_achievement(self.uid, "first_step")
        if floor >= 10: d_unlock_achievement(self.uid, "floor_10")
        if floor >= 20: d_unlock_achievement(self.uid, "floor_20")
        if floor >= 40: d_unlock_achievement(self.uid, "floor_40")

        # 特殊タイル判定
        if ct == D_STAIRS:
            await dg_save_player(self.uid, self.supabase)
            sv = DungeonStairsView(self.uid, floor, p["x"], p["y"], self.supabase)
            await self._redraw(i, "階段がある。どうする？", p, view=sv)
            return

        elif ct == D_CHEST:
            msg, reward = d_open_chest(self.uid, self.supabase)
            await d_apply_reward(self.uid, self.supabase, **reward)
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)

        elif ct == D_TRAP:
            msg, penalty = d_trigger_trap(self.uid)
            await d_apply_reward(self.uid, self.supabase, **penalty)
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)

        elif ct == D_SHOP:
            await dg_save_player(self.uid, self.supabase)
            shop = DungeonShopView(self.uid, floor, p["x"], p["y"], self.supabase)
            await self._redraw(i, "商店を発見！", p, view=shop)
            return

        elif ct == D_REST:
            before = p["hp"]
            p["hp"] = min(d_effective_stats(p)["max_hp"], p["hp"] + max(20, d_effective_stats(p)["max_hp"] // 3))
            msg = f"休憩した。HPが {p['hp'] - before} 回復した。"
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)

        elif ct == D_SHRINE:
            p["atk"] += 2
            msg = "祭壇の祝福！ 基礎ATKが2上昇した。"
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)

        elif ct == D_EVENT:
            gain = random.randint(20, 80)
            await d_apply_reward(self.uid, self.supabase, coins=gain, xp=gain, season_score=25)
            msg = f"旅人の依頼を達成した。コイン+{gain}、XP+{gain}"
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)

        elif ct == D_MINE:
            mv = DungeonMineView(self.uid, floor, p["x"], p["y"], self.supabase)
            await self._redraw(i, "鉱山を発見！", p, view=mv)
            return

        else:
            rate = D_ENCOUNTER_RATES.get(d_get_biome(floor)[0], 0.10)
            if random.random() < rate:
                enemy = d_make_enemy(floor)
                cv = DungeonCombatView(self.uid, floor, p["x"], p["y"], enemy, self.supabase)
                await dg_save_player(self.uid, self.supabase)
                await self._redraw(i, "", p, view=cv)
                return

        # 死亡判定
        if p["hp"] <= 0:
            p["hp"] = d_effective_stats(p)["max_hp"]
            p["floor"] = 1
            p["x"], p["y"] = dg_starts.get(1, (1, 1))
            msg += "\n力尽きた… スタート地点へ戻された"

        # 最終的な画面更新
        await dg_save_player(self.uid, self.supabase)
        await self._redraw(i, msg, p)

    @discord.ui.button(label="北西", style=discord.ButtonStyle.grey, row=0, custom_id="dg_lu")
    async def leftup(self, i, b): await self._move(i, -1, -1)

    @discord.ui.button(label="北", style=discord.ButtonStyle.grey, row=0, custom_id="dg_u")
    async def up(self, i, b): await self._move(i, 0, -1)

    @discord.ui.button(label="北東", style=discord.ButtonStyle.grey, row=0, custom_id="dg_ru")
    async def rightup(self, i, b): await self._move(i, 1, -1)

    @discord.ui.button(label="西", style=discord.ButtonStyle.grey, row=1, custom_id="dg_l")
    async def left(self, i, b): await self._move(i, -1, 0)

    @discord.ui.button(label="ENTER", style=discord.ButtonStyle.grey, row=1, custom_id="dg_c")
    async def check(self, i, b): await self._move(i, 0, 0)

    @discord.ui.button(label="東", style=discord.ButtonStyle.grey, row=1, custom_id="dg_r")
    async def right(self, i, b): await self._move(i, 1, 0)

    @discord.ui.button(label="南西", style=discord.ButtonStyle.grey, row=2, custom_id="dg_ld")
    async def leftdown(self, i, b): await self._move(i, -1, 1)

    @discord.ui.button(label="南", style=discord.ButtonStyle.grey, row=2, custom_id="dg_d")
    async def down(self, i, b): await self._move(i, 0, 1)

    @discord.ui.button(label="南東", style=discord.ButtonStyle.grey, row=2, custom_id="dg_rd")
    async def rightdown(self, i, b): await self._move(i, 1, 1)

    @discord.ui.button(label="STATUS", style=discord.ButtonStyle.green, row=3, custom_id="dg_status")
    async def status(self, i, b):
        await i.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.supabase)
        await sv._render(i, "")
class DungeonUnifiedView(DungeonMainView):
    """ゲームハブから起動したダンジョン一つで操作を完結させる圧縮UI。

    D1の接続ボタンと作戦選択はSTATUS画面へ集約し、このパネルには移動と終了だけを残す。
    """

    def __init__(self, uid, floor, x, y, supabase, plan=None):
        super().__init__(uid, floor, x, y, supabase)
        self.d1_plan = plan or d1_plan_for(uid)
        self.clear_items()
        directions = [
            ("北西", -1, -1, 0), ("北", 0, -1, 0), ("北東", 1, -1, 0),
            ("西", -1, 0, 1), ("ENTER", 0, 0, 1), ("東", 1, 0, 1),
            ("南西", -1, 1, 2), ("南", 0, 1, 2), ("南東", 1, 1, 2),
        ]
        for label, dx, dy, row in directions:
            button = discord.ui.Button(
                label=label, style=discord.ButtonStyle.green if label == "ENTER" else discord.ButtonStyle.grey, row=row
            )
            async def move_callback(interaction, dx=dx, dy=dy):
                await self._move(interaction, dx, dy)
            button.callback = move_callback
            self.add_item(button)

        status_button = discord.ui.Button(label="STATUS", style=discord.ButtonStyle.green, row=3)
        status_button.callback = self.open_status
        self.add_item(status_button)
        stop = discord.ui.Button(label="終了", style=discord.ButtonStyle.red, row=3)
        stop.callback = self.end_session
        self.add_item(stop)

    async def open_status(self, interaction):
        """ステータス画面（D1開始・作戦選択を含む）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.supabase)
        sv.d1_plan = self.d1_plan
        await sv._render(interaction, "")

    async def end_session(self, interaction):
        """D1を止め、操作を終了する。"""
        if _D1_PLAYER is not None:
            await _D1_PLAYER.stop(self.uid)
        self.stop()
        await interaction.response.defer()
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        embed = self._embed("ダンジョンを終了しました。再開する場合は `/game` からダンジョンを選んでください。", image_url=map_url)
        await interaction.edit_original_response(embed=embed, view=None, attachments=[map_file])


class DungeonOperationView(DungeonViewBase):
    """ステータス・アイテム・拠点・現在地操作を1画面に集約する。"""

    def __init__(self, uid, floor, x, y, supabase):
        super().__init__(uid, timeout=600)
        self.floor, self.x, self.y, self.supabase = floor, x, y, supabase
        self._add("STATUS", self.status, 0, discord.ButtonStyle.green)
        self._add("パン", self.use_bread, 0, discord.ButtonStyle.blurple)
        self._add("現在地を操作", self.current_action, 1, discord.ButtonStyle.primary)
        self._add("拠点", self.camp, 1, discord.ButtonStyle.grey)
        self._add("実績", self.achievements, 2, discord.ButtonStyle.grey)
        self._add("所持品", self.show_inventory, 2, discord.ButtonStyle.grey)
        self._add("NPC/依頼", self.show_npcs, 2, discord.ButtonStyle.grey)
        self._add("フロア目標", self.show_goals, 3, discord.ButtonStyle.primary)
        self._add("鍛冶強化", self.upgrade_forge, 3, discord.ButtonStyle.grey)
        self._add("戻る", self.back, 3, discord.ButtonStyle.grey)
        job_select = discord.ui.Select(
            placeholder="職業を選択（冒険開始前のみ）",
            options=[discord.SelectOption(label=data["name"], value=key) for key, data in JOB_MASTER.items()],
            row=4,
        )
        job_select.callback = self.select_job
        self.add_item(job_select)

    def _add(self, label, callback, row=0, style=discord.ButtonStyle.grey):
        button = discord.ui.Button(label=label, style=style, row=row)
        button.callback = callback
        self.add_item(button)

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        em = discord.Embed(title="ダンジョン操作メニュー", description=msg, color=0x4EA1FF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="位置", value=f"{p['floor']}F ({p['x']},{p['y']}) / {d_floor_modifier(p['floor'])}", inline=True)
        em.add_field(name="HP", value=f"{p['hp']}/{stats['max_hp']}", inline=True)
        em.add_field(name="所持資源", value=f"パン:{p['bread']} / 宝箱:{p['boxes']} / チップ:{p['chips']}", inline=False)
        em.add_field(name="装備", value="、".join(EQUIPMENT_MASTER.get(k, {}).get('name', k) for k in p.get('equipment', {}).values()) or "なし", inline=True)
        em.add_field(name="遺物", value="、".join(RELIC_MASTER.get(k, {}).get('name', k) for k in p.get('relics', [])) or "なし", inline=True)
        facilities = p.get('camp_facilities', {})
        em.add_field(name="拠点施設", value=f"宿屋Lv.{facilities.get('inn', 0)} / 鍛冶Lv.{facilities.get('forge', 0)} / ギルドLv.{facilities.get('guild', 0)}", inline=False)
        return em

    async def _back(self, interaction, msg=""):
        await d_return_to_dungeon(interaction, self.uid, self.supabase, msg)

    async def status(self, interaction):
        """ステータス画面（D1開始・作戦選択）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        status = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.supabase)
        await status._render(interaction, "")

    async def use_bread(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        if p.get("bread", 0) <= 0:
            await self._back(interaction, "レアパンを持っていません。")
            return
        stats = d_effective_stats(p)
        before = p["hp"]
        p["bread"] -= 1
        p["hp"] = min(stats["max_hp"], p["hp"] + max(25, stats["max_hp"] // 4))
        await dg_save_player(self.uid, self.supabase)
        await self._back(interaction, f"レアパンを使用し、HPが {p['hp'] - before} 回復しました。")

    async def camp(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        if p["floor"] != 1 and p["floor"] % 5 != 0:
            await self._back(interaction, "拠点は1階または5階ごとのフロアで設置できます。")
            return
        d_ensure_map(p["floor"])
        dg_maps[p["floor"]][p["y"]][p["x"]] = D_BASE
        await dg_save_base(self.uid, p["floor"], p["x"], p["y"], self.supabase)
        await dg_save_map(p["floor"], self.supabase)
        d_unlock_achievement(self.uid, "camp_builder")
        await dg_save_player(self.uid, self.supabase)
        await self._back(interaction, "現在地に拠点を設置しました。")

    async def achievements(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        unlocked = [f"解除済み: {ACHIEVEMENTS[k]}" for k in p["achievements"] if k in ACHIEVEMENTS]
        locked = [f"未解除: {name}" for k, name in ACHIEVEMENTS.items() if k not in p["achievements"]]
        await self._back(interaction, "\n".join(unlocked + locked))

    async def show_inventory(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        lines = [f"{EQUIPMENT_MASTER[k]['name']} ×{v}" for k, v in p.get("inventory", {}).items() if k in EQUIPMENT_MASTER]
        lines += [f"素材: {k} ×{v}" for k, v in p.get("materials", {}).items()]
        await self._back(interaction, "所持品\n" + ("\n".join(lines) or "なし"))

    async def show_npcs(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        lines = [
            f"{v['name']}: {'進行済み' if any(x.get('flag') in p.get('npc_flags', {}) for x in v['steps']) else '未訪問'}"
            for v in NPC_MASTER.values()
        ]
        await self._back(interaction, "NPC・依頼\n" + "\n".join(lines))

    async def show_goals(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        goal = p.setdefault("floor_goals", {}).get(str(p["floor"]), {"kind": "chests", "progress": 0, "target": 3, "completed": False})
        name = next((v["name"] for v in FLOOR_GOALS.values() if v["kind"] == goal.get("kind")), "宝箱を開ける")
        await self._back(interaction, f"フロア目標: {name} {goal.get('progress', 0)}/{goal.get('target', 3)}")

    async def upgrade_forge(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        weapon = p.get("equipment", {}).get("weapon")
        msg = "鍛冶対象の武器がありません。"
        if weapon and d_upgrade_equipment(self.uid, weapon):
            msg = f"{EQUIPMENT_MASTER[weapon]['name']}を強化しました。"
        await dg_save_player(self.uid, self.supabase)
        await self._back(interaction, msg)

    async def select_job(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        if p.get("turns", 0) > 0:
            await self._back(interaction, "冒険開始後は職業を変更できません。")
            return
        selected = interaction.data.get("values", [""])[0]
        if selected not in JOB_MASTER:
            await self._back(interaction, "無効な職業です。")
            return
        p["job"] = selected
        await dg_save_player(self.uid, self.supabase)
        await self._back(interaction, f"職業を **{JOB_MASTER[selected]['name']}** に設定しました。")

    async def current_action(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        floor = p["floor"]
        cell = d_get_cell(floor, p["x"], p["y"])
        msg = "この場所では操作できません。"
        if cell == D_STAIRS and floor < D_FLOORS:
            p["floor"] = floor + 1
            p["hp"] = d_effective_stats(p)["max_hp"]
            d_ensure_map(p["floor"])
            p["x"], p["y"] = dg_starts[p["floor"]]
            d_progress_quest(self.uid, "floor", 1)
            msg = f"階段を上り、{p['floor']}Fへ進みました。"
        elif cell == D_MINE:
            gain = d_do_mine(self.uid)
            await d_apply_reward(self.uid, self.supabase, coins=gain)
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)
            msg = f"採掘してコインを{gain}枚獲得しました。"
        elif cell == D_REST:
            stats = d_effective_stats(p)
            before = p["hp"]
            p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
            d_consume(floor, p["x"], p["y"])
            await dg_save_map(floor, self.supabase)
            msg = f"休憩してHPが {p['hp'] - before} 回復しました。"
        elif cell == D_SHOP:
            try:
                await d_apply_reward(self.uid, self.supabase, coins=-30, bread=1)
                msg = "商店でレアパンを購入しました。"
            except Exception:
                msg = "コイン不足で購入できません。"
        await dg_save_player(self.uid, self.supabase)
        await self._back(interaction, msg)

    async def back(self, interaction):
        await interaction.response.defer()
        await self._back(interaction)


class DungeonRewardChoiceView(DungeonViewBase):
    """戦闘勝利時に3候補から1つだけ受け取るView。"""

    def __init__(self, uid, floor, x, y, supabase, choices):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.supabase, self.choices = floor, x, y, supabase, choices
        for index, item in enumerate(choices):
            button = discord.ui.Button(label=item["label"], style=discord.ButtonStyle.green, row=0)

            async def choose(interaction, index=index):
                await interaction.response.defer()
                p = d_get_player(self.uid)
                if not p.get("pending_rewards"):
                    await interaction.edit_original_response(
                        embed=discord.Embed(title="報酬は受取済みです"), view=None, attachments=[]
                    )
                    return
                reward = d_choose_reward(self.uid, index)
                if reward is None:
                    await interaction.edit_original_response(
                        embed=discord.Embed(title="報酬の選択に失敗しました"), view=self
                    )
                    return
                await d_apply_reward(self.uid, self.supabase, **reward)
                await dg_save_player(self.uid, self.supabase)
                self.stop()
                await d_return_to_dungeon(interaction, self.uid, self.supabase, f"報酬を選択: {item['label']}")

            button.callback = choose
            self.add_item(button)


class D1DungeonPlayer:
    """d1-omni によるダンジョン代理プレイ（旧 d1_dangeon.py を統合）。

    D1へ渡すのは「現在の状態」「今回の選択肢と判断基準」「直近のログ」だけに絞る。
    ゲーム状態の確定・ダメージ・報酬・保存はすべて本体側が担当し、
    モデルは次の1手を選ぶことだけに責務を限定する。
    """

    def __init__(self, bot):
        self.bot = bot
        self._tasks = {}
        self._stops = {}
        self._plans = {}
        self._run_stats = {}
        self.service_name = os.environ.get("D1_SERVICE_NAME", "llama-d1-omni")
        self.start_command = os.environ.get("D1_START_COMMAND", "")
        self._vision_ready = False
        self._service_lock = asyncio.Lock()
        self._ready_until = 0.0

    # ---------- D1サービス疎通 ----------

    async def _test_vision_capability(self):
        """/v1/modelsを確認し、現在のサービスが画像対応で起動しているか判定する。"""
        try:
            timeout = aiohttp.ClientTimeout(total=3.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(D1_ENDPOINT.rsplit("/", 1)[0] + "/models") as response:
                    if response.status != 200:
                        return False
                    data = await response.json(content_type=None)
                    text = str(data).lower()
                    return "multimodal" in text or "vision" in text or "image" in text
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
            return False

    async def _test_response(self):
        """d1_test.pyと同じ最小pingでsystemoneの稼働を確認する。"""
        payload = {"state": "ping", "questions": {"ping": {"type": "noul", "instructions": "Is this a test?"}}}
        started = time.perf_counter()
        try:
            timeout = aiohttp.ClientTimeout(total=3.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(D1_ENDPOINT, json=payload) as response:
                    self._timing("ping status=%s elapsed_ms=%.0f", response.status, (time.perf_counter() - started) * 1000)
                    return response.status == 200
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            self._timing("ping failed elapsed_ms=%.0f", (time.perf_counter() - started) * 1000)
            return False

    def _timing(self, message, *args):
        """D1の遅延調査用ログ。通常は無効で、UIには表示しない。"""
        if D1_TIMING_LOG:
            logger.info("[d1-timing] " + message, *args)

    async def _start_service(self):
        """d1_test.pyと同じsystemdサービス起動手順を実行する。"""
        try:
            if self.start_command:
                process = await asyncio.create_subprocess_shell(
                    self.start_command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
            else:
                process = await asyncio.create_subprocess_exec(
                    "sudo", "systemctl", "restart", self.service_name,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
            await asyncio.wait_for(process.communicate(), timeout=15.0)
            return process.returncode == 0
        except (asyncio.TimeoutError, OSError):
            return False

    async def _ensure_d1_ready(self, logs, require_vision=False):
        """ping→起動→モデルロード待機→再pingを一度だけ行う。"""
        if time.monotonic() < self._ready_until and (not require_vision or self._vision_ready):
            return True
        async with self._service_lock:
            if time.monotonic() < self._ready_until and (not require_vision or self._vision_ready):
                return True
            if await self._test_response():
                self._vision_ready = await self._test_vision_capability() if require_vision else False
                self._ready_until = time.monotonic() + D1_READY_CACHE_SECONDS
                if require_vision and not self._vision_ready:
                    logs.append("D1サービスは応答しますが画像機能が無効です。mmproj付き起動が必要です。")
                return True
            logs.append("D1応答なし。systemdサービスを起動します。")
            if not await self._start_service():
                logs.append(f"D1サービス起動失敗: {self.service_name}")
                return False
            logs.append("D1サービスを起動しました。モデルロードを待機中です。")
            for _ in range(12):
                await asyncio.sleep(2.5)
                if await self._test_response():
                    self._vision_ready = await self._test_vision_capability() if require_vision else False
                    self._ready_until = time.monotonic() + D1_READY_CACHE_SECONDS
                    logs.append("D1サービスの応答を確認しました。")
                    if require_vision and not self._vision_ready:
                        logs.append("D1サービスの画像機能を確認できません。D1_MMPROJまたは--mmprojを設定してください。")
                    return True
            logs.append("D1サービスは起動しましたが、応答待ちがタイムアウトしました。")
            return False

    # ---------- D1への入力生成 ----------

    def _state_text(self, uid, plan, logs):
        """D1へ渡す唯一のテキスト。ゴールと現在状態を先頭に、ログは短く末尾へ置く。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        floor, x, y = p["floor"], p["x"], p["y"]
        bname, *_ = d_get_biome(floor)
        dist = d1_bfs(floor, x, y)
        hp_pct = int(p["hp"] / max(1, stats["max_hp"]) * 100)
        header = [
            "# 現在の状態",
            f"作戦: {plan}",
            f"階層: {floor}F({bname}) / 位置: ({x},{y}) / フロア特性: {d_floor_modifier(floor)}",
            f"HP: {p['hp']}/{stats['max_hp']} ({hp_pct}%) / ATK {stats['atk']} DEF {stats['def_']} / 職業: {d_job_name(uid)}",
            f"目的: {d1_goal_text(uid)}",
            f"階段: {d1_stairs_hint(floor, x, y, dist)}",
            f"周囲: {d1_surround_text(floor, x, y)}",
        ]
        last = self._run_stats.get(uid, {}).get("last_result")
        if last:
            header.append(f"前回の結果: {last}")
        header.append("直近のログ:")
        head_text = "\n".join(header)
        lines = []
        for line in [entry for entry in logs if entry and not str(entry).startswith("候補評価:")][-D1_LOG_LINES:]:
            lines.append("- " + " ".join(str(line).split())[:160])
        log_text = "\n".join(lines)
        remaining = D1_STATE_CHARS - len(head_text) - 1
        if remaining <= 0:
            return head_text[:D1_STATE_CHARS]
        return head_text + "\n" + log_text[-remaining:]

    def _battle_criteria(self, uid, enemy):
        """戦闘の選択肢と基準。HPとクールダウンから状況を明示する。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        job = JOB_MASTER.get(p.get("job", "warrior"), JOB_MASTER["warrior"])
        skill = job.get("skill", "power_strike")
        cooldown = p.get("cooldowns", {}).get(skill, 0)
        hp_pct = int(p["hp"] / max(1, stats["max_hp"]) * 100)
        return {
            "attack": f"通常攻撃（自分のHP {hp_pct}% / 敵HP {enemy['hp']}/{enemy['max_hp']}）",
            "skill": f"{job['name']}のスキル" + ("（使用可）" if cooldown <= 0 else f"（あと{cooldown}ターン使用不可）"),
            "defend": "防御して次の被ダメージを半減する（HPが少ない時に有効）",
            "escape": "逃走する（ボスからは逃げられない・失敗すると攻撃を受ける）" if enemy.get("type") == "boss" else "逃走する（失敗すると攻撃を受ける）",
        }

    async def _decide(self, uid, logs, plan, questions):
        """テキスト盤面を基本に、設定時だけ地図画像を添えてD1へ1問だけ投げる。"""
        p = d_get_player(uid)
        image_bytes = None
        if D1_SEND_IMAGES:
            image = d_build_map_image(uid, p["floor"], p["x"], p["y"])
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            image_bytes = buf.getvalue()
        return await self._call_d1(logs, self._state_text(uid, plan, logs), image_bytes, questions)

    async def _call_d1(self, logs, state_text, image_bytes, questions):
        """公式のSystem One形式でd1-omniへテキスト、必要時のみ画像を送る。"""
        if not await self._ensure_d1_ready(logs, require_vision=bool(image_bytes)):
            return ""
        payload = {
            "state": state_text,
            "questions": questions,
        }
        if image_bytes:
            payload["images"] = ["data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")]
        timeout = aiohttp.ClientTimeout(total=D1_HTTP_TIMEOUT)
        for attempt in range(1, D1_HTTP_RETRIES + 1):
            started = time.perf_counter()
            try:
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(D1_ENDPOINT, json=payload) as response:
                        body = await response.text()
                        self._timing(
                            "request attempt=%s status=%s elapsed_ms=%.0f state_chars=%s question_chars=%s image_bytes=%s",
                            attempt, response.status, (time.perf_counter() - started) * 1000,
                            len(state_text), sum(len(str(v)) for v in questions.values()), len(image_bytes or b""),
                        )
                        if response.status != 200:
                            self._ready_until = 0.0
                            detail = " ".join(body.split())[:240]
                            if response.status == 501 and ("image input" in body.lower() or "mmproj" in body.lower()):
                                self._vision_ready = False
                                logs.append("D1画像入力が拒否されました。クライアント形式は正しいため、D1サービスをmmproj付きで再起動してください。")
                            logs.append(f"D1 APIエラー: HTTP {response.status}" + (f" / {detail}" if detail else ""))
                            # 5xx/429はモデルロードや一時的な過負荷の可能性があるため再試行する。
                            if attempt < D1_HTTP_RETRIES and response.status in (408, 429, 500, 502, 503, 504):
                                await asyncio.sleep(D1_HTTP_RETRY_DELAY * attempt)
                                continue
                            return ""
                        try:
                            data = await response.json(content_type=None)
                        except Exception:
                            detail = " ".join(body.split())[:240]
                            logs.append("D1 APIエラー: JSON応答を解釈できません" + (f" / {detail}" if detail else ""))
                            if attempt < D1_HTTP_RETRIES:
                                await asyncio.sleep(D1_HTTP_RETRY_DELAY * attempt)
                                continue
                            return ""
                        answers = data.get("answers", {}) if isinstance(data, dict) else {}
                        key = next(iter(questions), "")
                        answer = answers.get(key, {}) if isinstance(answers, dict) else {}
                        if isinstance(answer, str):
                            return answer
                        if isinstance(answer, dict):
                            choice = answer.get("choice") or answer.get("answer") or answer.get("value")
                            if choice is not None:
                                return str(choice)
                        if isinstance(data, dict) and data.get("choice") is not None:
                            return str(data["choice"])
                        logs.append("D1 APIエラー: choice結果がありません")
                        if attempt < D1_HTTP_RETRIES:
                            await asyncio.sleep(D1_HTTP_RETRY_DELAY * attempt)
                            continue
                        return ""
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                # pingは成功しても、画像エンコード＋推論はモデルロード直後に時間がかかる。
                # これはサービス停止ではないため、再試行後にのみ1回の判断失敗として記録する。
                if attempt < D1_HTTP_RETRIES:
                    logs.append(f"D1推論が{D1_HTTP_TIMEOUT:.0f}秒で未完了。{attempt + 1}回目を再試行します。")
                    await asyncio.sleep(D1_HTTP_RETRY_DELAY * attempt)
                    continue
                logs.append(f"D1推論タイムアウト（{D1_HTTP_RETRIES}回試行）。作戦フォールバックを使用します。")
            except (aiohttp.ClientError, OSError) as exc:
                if attempt < D1_HTTP_RETRIES:
                    logs.append(f"D1接続一時失敗（{type(exc).__name__}）。再試行します。")
                    await asyncio.sleep(D1_HTTP_RETRY_DELAY * attempt)
                    continue
                logs.append(f"D1接続エラー: {type(exc).__name__}")
            except Exception as exc:
                logs.append(f"D1接続エラー: {type(exc).__name__}")
                return ""
        return ""

    # ---------- 実行制御 ----------

    def is_running(self, uid):
        task = self._tasks.get(str(uid))
        return bool(task and not task.done())

    def plan_for(self, uid):
        return self._plans.get(str(uid), D1_PLANS["safe"])

    def set_plan(self, uid, plan):
        self._plans[str(uid)] = plan

    def status_text(self, uid):
        uid = str(uid)
        if self.is_running(uid):
            run = self._run_stats.get(uid, {})
            return f"実行中（{run.get('turns', 0)}ターン / 作戦: {self.plan_for(uid)}）"
        return "停止中"

    async def start(self, interaction, plan=None):
        """現在のダンジョン状態をそのまま引き継いで自動操作を開始する。"""
        uid = str(interaction.user.id)
        plan = plan or self.plan_for(uid)
        if self.is_running(uid):
            await interaction.response.send_message("自動操作はすでに実行中です。", ephemeral=True)
            return False
        await interaction.response.defer()
        self._plans[uid] = plan
        # 押した時点の保存済み状態から、表示もD1の判断も同一のフレームで始める。
        p = d_get_player(uid)
        view = DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], self.bot.supabase, plan=plan)
        message = interaction.message or await interaction.original_response()
        stop_event = asyncio.Event()
        self._stops[uid] = stop_event
        # 連続実行はバックグラウンドで進め、ボタン操作を待たせない。
        self._tasks[uid] = asyncio.create_task(self._run_loop(uid, message, view, stop_event, plan))
        return True

    async def stop(self, uid):
        event = self._stops.get(str(uid))
        if event:
            event.set()

    def shutdown(self):
        for event in self._stops.values():
            event.set()
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
        self._stops.clear()

    async def _edit_screen(self, message, view, logs, *, final=False):
        """1フレームを描画する。添付名は毎回変え、キャッシュされた古い画像を表示させない。"""
        uid = view.uid
        p = view.sync_state()
        stats = d_effective_stats(p)
        embed = discord.Embed(
            title=f"自動操作 {'終了' if final else '実行中'}",
            description="\n".join(str(x) for x in logs[-8:])[-1500:] or "ログはまだありません。",
            color=0x666666 if final else 0x8B5CF6,
        )
        embed.add_field(name="作戦", value=f"{view.d1_plan} / 停止: 終了ボタン", inline=False)
        embed.add_field(
            name="停止条件",
            value=f"HP30%未満 / ボス / 遺物 / {D1_MAX_TURNS}ターン / APIエラー3回 / 同一地点3回",
            inline=False,
        )
        embed.add_field(
            name="状態",
            value=f"{p['floor']}F ({p['x']},{p['y']}) / HP {p['hp']}/{stats['max_hp']} / {d_job_name(uid)}",
            inline=False,
        )
        map_file, map_url = d_map_attachment(uid, p["floor"], p["x"], p["y"])
        embed.set_image(url=map_url)
        await message.edit(embed=embed, view=None if final else view, attachments=[map_file])

    def _note_result(self, uid, text):
        self._run_stats.setdefault(uid, {"turns": 0, "positions": []})["last_result"] = text

    def _stop_reason(self, uid, logs):
        """D1の安全停止条件をゲーム側で一元判定する。1ターンにつき1回だけ呼ぶ。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        run = self._run_stats.setdefault(uid, {"turns": 0, "positions": []})
        positions = run.setdefault("positions", [])
        positions.append((p["floor"], p["x"], p["y"]))
        del positions[:-12]
        if p["hp"] <= 0:
            return "HPが0"
        if p["hp"] < stats["max_hp"] * 0.30:
            return "HPが30%未満"
        if p.get("active_effects"):
            return "状態異常を検知"
        if any("ボス" in line for line in logs[-8:]):
            return "ボス遭遇"
        if any("遺物" in line for line in logs[-8:]):
            return "希少アイテム発見"
        if run.get("turns", 0) >= D1_MAX_TURNS:
            return f"1回のD1実行が{D1_MAX_TURNS}ターンに到達"
        if len(positions) >= 3 and positions[-1] == positions[-2] == positions[-3]:
            return "同じ場所で3回連続停止"
        if sum("D1 APIエラー" in line or "D1接続エラー" in line for line in logs[-6:]) >= 3:
            return "D1 APIエラーが連続3回"
        if sum("と遭遇しました" in line for line in logs[-8:]) >= 3:
            return "連続戦闘が多いため"
        return ""

    async def _run_loop(self, uid, message, view, stop_event, plan):
        logs = [f"自動操作を開始しました。作戦: {plan} / 終了ボタンで停止できます。"]
        d_begin_run(uid, "d1")
        self._run_stats[uid] = {"turns": 0, "positions": [], "last_result": ""}
        # 初回判断の前に、ゲームハブのダンジョンと同じ現在状態のフレームを表示する。
        await self._edit_screen(message, view, logs)
        try:
            while not stop_event.is_set():
                reason = self._stop_reason(uid, logs)
                if reason:
                    logs.append(f"停止しました: {reason}")
                    break
                turn_started = time.perf_counter()
                await self._play_turn(uid, logs, plan)
                self._timing("turn uid=%s elapsed_ms=%.0f", uid, (time.perf_counter() - turn_started) * 1000)
                self._run_stats[uid]["turns"] += 1
                await self._edit_screen(message, view, logs)
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            logs.append("自動操作をキャンセルしました。")
            raise
        except Exception as exc:
            logs.append(f"自動操作エラー: {type(exc).__name__}: {exc}")
        finally:
            self._tasks.pop(uid, None)
            self._stops.pop(uid, None)
            self._run_stats.pop(uid, None)
            d_end_run(uid, "d1_stop")
            logs.append("自動操作を終了しました。")
            try:
                await self._edit_screen(message, view, logs, final=True)
            except Exception:
                pass

    # ---------- 1ターンの判断 ----------

    async def _play_turn(self, uid, logs, plan):
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        floor, x, y = p["floor"], p["x"], p["y"]
        cell = d_get_cell(floor, x, y)
        logs.append(d1_candidate_log(uid, plan))
        d_record_action(uid, "decision", source="d1", result=plan)

        if cell == D_STAIRS:
            raw = await self._decide(uid, logs, plan, {
                "stairs": {
                    "type": "choice",
                    "instructions": (
                        "階段の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {d1_goal_text(uid)}\n"
                        f"作戦: {plan}（{d1_plan_guidance(plan)}）\n"
                        "基準: 上の階へ進むとHPが全回復し、より深い階へ移動します。"
                        "この階の探索や回収を優先したい場合は残ってください。\n"
                        "回答は up か stay のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "up": f"上の階へ進む（HPが全回復して{min(floor + 1, D_FLOORS)}Fへ移動する）",
                        "stay": f"この階に残って探索を続ける（現在HP {p['hp']}/{stats['max_hp']}）",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"up", "stay"}, "stay")
            if choice == "up" and floor < D_FLOORS:
                p["floor"] = floor + 1
                p["hp"] = d_effective_stats(p)["max_hp"]
                d_ensure_map(p["floor"])
                p["x"], p["y"] = dg_starts[p["floor"]]
                d_progress_quest(uid, "floor", 1)
                logs.append(f"階段を上り、{p['floor']}Fへ進みました。")
            else:
                logs.append("階段では探索を続けました。")
            await dg_save_player(uid, self.bot.supabase)
            return

        if cell == D_MINE:
            raw = await self._decide(uid, logs, plan, {
                "mine": {
                    "type": "choice",
                    "instructions": (
                        "鉱山の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {d1_goal_text(uid)}\n"
                        f"作戦: {plan}（{d1_plan_guidance(plan)}）\n"
                        "基準: 採掘するとコインを獲得でき、この鉱山は消滅します。\n"
                        "回答は dig か leave のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "dig": "その場で採掘してコインを獲得する",
                        "leave": "採掘せずにそのまま探索を続ける",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"dig", "leave"}, "leave")
            if choice == "dig":
                gain = d_do_mine(uid)
                await d_apply_reward(uid, self.bot.supabase, coins=gain, season_score=10)
                d_consume(floor, x, y)
                logs.append(f"鉱山を採掘し、コインを{gain}枚獲得しました。")
                await dg_save_map(floor, self.bot.supabase)
            else:
                logs.append("鉱山を見送りました。")
            await dg_save_player(uid, self.bot.supabase)
            return

        if cell == D_REST:
            before = p["hp"]
            p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
            d_consume(floor, x, y)
            logs.append(f"休憩所でHPを{p['hp'] - before}回復しました。")
            await dg_save_map(floor, self.bot.supabase)
            await dg_save_player(uid, self.bot.supabase)
            return

        if cell == D_SHOP:
            raw = await self._decide(uid, logs, plan, {
                "shop": {
                    "type": "choice",
                    "instructions": (
                        "商店の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {d1_goal_text(uid)}\n"
                        f"作戦: {plan}（{d1_plan_guidance(plan)}）\n"
                        f"基準: レアパンは30コインでHP回復に使えます（所持パン {p['bread']} 個）。\n"
                        "回答は buy か leave のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "buy": "レアパンを1個購入する（30コイン）",
                        "leave": "購入せずに探索を続ける",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"buy", "leave"}, "leave")
            if choice == "buy":
                try:
                    await d_apply_reward(uid, self.bot.supabase, coins=-30, bread=1)
                    logs.append("商店でレアパンを購入しました。")
                except Exception:
                    logs.append("コイン不足で購入できませんでした。")
            else:
                logs.append("商店で購入せずに進みました。")
            await dg_save_player(uid, self.bot.supabase)
            return

        # 通常移動。待機手は用意せず、必ず1方向を選ばせる。
        dist = d1_bfs(floor, x, y)
        move_criteria = d1_move_criteria(floor, x, y, dist)
        criteria_text = "\n".join(f"{key}: {value}" for key, value in move_criteria.items())
        instructions = (
            "あなたはダンジョン探索の意思決定者です。画像ではなく、以下のテキスト盤面を正として次の1手を選んでください。\n"
            f"目的: {d1_goal_text(uid)}\n"
            f"作戦: {plan}（{d1_plan_guidance(plan)}）\n"
            f"現在地: {floor}F ({x},{y}) / 階段: {d1_stairs_hint(floor, x, y, dist)}\n"
            f"局所盤面: {d1_local_grid(floor, x, y)}\n"
            f"方向ごとの判定基準:\n{criteria_text}\n"
            "制約: 壁へは進めません。階段へ近づく方向を優先します。HPが30%未満なら回復タイルや階段へ向かってください。\n"
            "回答は次のいずれか1語のみ: " + ", ".join(D1_MOVE_KEYS)
        )
        raw = await self._decide(uid, logs, plan, {
            "move": {
                "type": "choice",
                "instructions": instructions,
                "criteria": move_criteria,
            }
        })
        choice = d_normalize_choice(raw, set(D1_MOVE_KEYS), None)
        if choice is None:
            choice = d1_best_direction(uid, plan, dist)
            logs.append(f"D1の応答を解釈できなかったため、作戦に沿って{_DIRECTION_LABELS[choice]}へ進みます。")
        dx, dy = _DIRECTIONS[choice]
        nx, ny = x + dx, y + dy
        corner_cut = dx != 0 and dy != 0 and (
            d_get_cell(floor, x + dx, y) == D_WALL or d_get_cell(floor, x, y + dy) == D_WALL
        )
        if (not (0 <= nx < D_MAP_W and 0 <= ny < D_MAP_H)
                or d_get_cell(floor, nx, ny) == D_WALL or corner_cut):
            blocked_choice = choice
            choice = d1_best_direction(uid, plan, dist)
            dx, dy = _DIRECTIONS[choice]
            nx, ny = x + dx, y + dy
            logs.append(f"{_DIRECTION_LABELS[blocked_choice]}({blocked_choice})は壁でした。サーバー判定で{_DIRECTION_LABELS[choice]}({choice})へ補正します。")
            self._note_result(uid, f"{blocked_choice}は壁のため{choice}へ補正")
            fallback_corner_cut = dx != 0 and dy != 0 and (
                d_get_cell(floor, x + dx, y) == D_WALL or d_get_cell(floor, x, y + dy) == D_WALL
            )
            if (not (0 <= nx < D_MAP_W and 0 <= ny < D_MAP_H)
                    or d_get_cell(floor, nx, ny) == D_WALL or fallback_corner_cut):
                logs.append("周囲に合法な移動先がないため、このターンは移動しません。")
                return
        p["x"], p["y"] = nx, ny
        p["turns"] += 1
        p["season_score"] += 1
        d_progress_quest(uid, "turns", 1)
        logs.append(f"{choice}へ移動しました。現在地: {floor}F ({nx},{ny}) / {d_floor_modifier(floor)}")
        self._note_result(uid, f"{choice}へ移動して ({nx},{ny}) に到着")
        await self._resolve_tile(uid, logs)
        await dg_save_player(uid, self.bot.supabase)

    async def _resolve_tile(self, uid, logs):
        p = d_get_player(uid)
        floor, x, y = p["floor"], p["x"], p["y"]
        cell = d_get_cell(floor, x, y)
        if cell == D_CHEST:
            text, reward = d_open_chest(uid, self.bot.supabase)
            await d_apply_reward(uid, self.bot.supabase, **reward)
            d_consume(floor, x, y)
            logs.append(text)
            await dg_save_map(floor, self.bot.supabase)
            return
        if cell == D_TRAP:
            text, penalty = d_trigger_trap(uid)
            await d_apply_reward(uid, self.bot.supabase, **penalty)
            d_consume(floor, x, y)
            logs.append(text)
            await dg_save_map(floor, self.bot.supabase)
            return
        if cell == D_SHRINE:
            p["atk"] += 2
            d_consume(floor, x, y)
            logs.append("祭壇の祝福: 基礎ATKが2上昇しました。")
            await dg_save_map(floor, self.bot.supabase)
            return
        if cell == D_EVENT:
            gain = random.randint(40, 120)
            await d_apply_reward(uid, self.bot.supabase, coins=gain, xp=gain, season_score=25, material="ancient_shard")
            d_consume(floor, x, y)
            logs.append(f"旅人の依頼: コイン+{gain} / XP+{gain} / 古代欠片+1")
            await dg_save_map(floor, self.bot.supabase)
            return
        if cell in (D_STAIRS, D_MINE, D_REST, D_SHOP):
            # 特殊タイルは次のターンの判断（階段・採掘・休憩・購入）で扱う。
            # ここでエンカウントを引くと、到着した特殊タイルを無視して戦闘に入ってしまう。
            return
        biome, *_ = d_get_biome(floor)
        if random.random() < D_ENCOUNTER_RATES.get(biome, 0.1):
            enemy = d_make_enemy(floor)
            logs.append(f"{enemy['name']}と遭遇しました。")
            await self._auto_combat(uid, enemy, logs)

    async def _auto_combat(self, uid, enemy, logs):
        """戦闘もD1に選ばせる。ダメージ計算と結果確定は本体側で行う。"""
        p = d_get_player(uid)
        combat = DungeonCombatView(uid, p["floor"], p["x"], p["y"], enemy, self.bot.supabase)
        while enemy["hp"] > 0 and d_get_player(uid)["hp"] > 0:
            raw = await self._decide(uid, logs, "戦闘", {
                "battle": {
                    "type": "choice",
                    "instructions": (
                        "戦闘中です。次の行動を1つだけ選んでください。\n"
                        f"目的: {d1_goal_text(uid)}\n"
                        f"敵: {enemy['name']}（HP {enemy['hp']}/{enemy['max_hp']}）\n"
                        "基準: HPが少ない時は防御や逃走も有効です。ボスからは逃げられません。\n"
                        "回答は attack, skill, defend, escape のいずれか1語のみ。"
                    ),
                    "criteria": self._battle_criteria(uid, enemy),
                }
            })
            choice = d_normalize_choice(raw, {"attack", "skill", "defend", "escape"}, "defend")
            p = d_get_player(uid)
            if choice == "skill":
                text, damage = d_use_job_skill(uid, enemy)
                enemy["hp"] = max(0, enemy["hp"] - damage)
                logs.append(text)
            elif choice == "defend":
                combat.defending = True
                logs.append("防御しました。")
            elif choice == "escape" and enemy.get("type") != "boss":
                if random.random() < 0.5:
                    logs.append("逃走に成功しました。")
                    return
                logs.append("逃走に失敗しました。")
            else:
                damage, critical = combat._calculate_damage(p, enemy)
                enemy["hp"] = max(0, enemy["hp"] - damage)
                logs.append(f"攻撃で{damage}ダメージを与えました。")
            if enemy["hp"] <= 0:
                await combat._win(_NoopInteraction())
                logs.append("戦闘に勝利しました。")
                return
            logs.append(combat._enemy_turn())
        if d_get_player(uid)["hp"] <= 0:
            await combat._lose(_NoopInteraction())
            logs.append("敗北し、1Fへ戻されました。")


# ============================================================
#  Cog クラス
# ============================================================

class DungeonCog(Cog):
    """ダンジョンシステムCog"""

    def __init__(self, bot):
        self.bot = bot
        self.supabase = None
        # 自動操作は同一ファイル内で管理する（旧 d1_dangeon.py を統合）。
        self.d1 = D1DungeonPlayer(bot)

    async def cog_load(self):
        """Cog読み込み時"""
        global _D1_PLAYER
        _D1_PLAYER = self.d1
        # 親botのsupabaseを取得
        if hasattr(self.bot, 'supabase'):
            self.supabase = self.bot.supabase
            await dg_load_all(self.supabase)

        # アセットを読み込み
        load_all_assets()

        # タスク開始
        if not self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.start()

    def cog_unload(self):
        """Cog アンロード時"""
        self.d1.shutdown()
        if self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.cancel()

    async def start_recruit(self, interaction: Interaction):
        """ゲームハブからダンジョンを開始する。"""
        await interaction.response.defer()
        uid = str(interaction.user.id)

        # プレイヤーデータ取得
        p = d_get_player(uid)
        floor, x, y = p["floor"], p["x"], p["y"]

        # マップ確認
        d_ensure_map(floor)

        # 初期位置設定
        sx, sy = dg_starts.get(floor, (1, 1))
        if x == 1 and y == 1:
            x, y = sx, sy
            p["x"] = x
            p["y"] = y
            if self.supabase:
                await dg_save_player(uid, self.supabase)

        # すべての通常操作・ステータス・D1開始/停止を1つの画面へ集約する。
        mv = DungeonUnifiedView(uid, floor, x, y, self.supabase)

        # 初期画像は専用チャンネルへ投げず、コマンド応答へ直接添付する。
        map_file, map_url = d_map_attachment(uid, floor, x, y)
        em = mv._embed("ダンジョンへようこそ！ D1の接続と作戦はSTATUS画面から選べます。", image_url=map_url)
        await interaction.followup.send(embed=em, view=mv, file=map_file)

    @commands.command(name="dungeon_reset")
    async def dungeon_reset(self, ctx: commands.Context):
        """ダンジョンマップを全サーバー分リセット（Bot の持ち主専用）"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        global dg_maps, dg_players, dg_starts, dg_used, dg_bases
        dg_maps.clear()
        dg_players.clear()
        dg_starts.clear()
        dg_used.clear()
        dg_bases.clear()

        # DBも全消去
        if self.supabase:
            try:
                self.supabase.table("dungeon_maps").delete().neq("floor", 0).execute()
                self.supabase.table("dungeon_players").delete().neq("user_id", "").execute()
                self.supabase.table("dungeon_bases").delete().neq("user_id", "").execute()
            except Exception as e:
                print(f"dungeon_reset DB削除失敗: {e}")

        for fl in range(1, D_FLOORS+1):
            d_ensure_map(fl)
            if self.supabase:
                await dg_save_map(fl, self.supabase)

        em = discord.Embed(title="リセット完了", description="マップを再生成しました！", color=0xFFFFFF)
        await ctx.send(embed=em)

    @tasks.loop(hours=1)
    async def dungeon_monthly_task(self):
        """月初にマップとラン中状態だけを更新し、永続進行は保持する。"""
        now = datetime.datetime.now(JST)
        if now.day == 1 and now.hour == 0:
            global dg_maps, dg_players, dg_starts, dg_used, dg_bases
            dg_maps.clear()
            dg_starts.clear()
            dg_used.clear()
            dg_bases.clear()

            for player in dg_players.values():
                player["season_id"] = SEASON_ID
                player["season_score"] = 0
                player["floor"] = 1
                player["x"] = 1
                player["y"] = 1
                player["hp"] = d_effective_stats(player)["max_hp"]
                player["turns"] = 0
                player["cooldowns"] = {}

            if self.supabase:
                try:
                    self.supabase.table("dungeon_maps").delete().neq("floor", 0).execute()
                    self.supabase.table("dungeon_bases").delete().neq("user_id", "").execute()
                    self.supabase.table("dungeon_players").update({
                        "season_id": SEASON_ID,
                        "season_score": 0,
                        "floor": 1,
                        "x": 1,
                        "y": 1,
                        "turns": 0,
                        "cooldowns": {},
                    }).neq("user_id", "").execute()
                except Exception as e:
                    print(f"dungeon月次リセットDB削除失敗: {e}")

                for fl in range(1, D_FLOORS+1):
                    d_ensure_map(fl)
                    await dg_save_map(fl, self.supabase)

            print("✓ ダンジョン月次リセット完了")

    @dungeon_monthly_task.before_loop
    async def before_dungeon_task(self):
        await self.bot.wait_until_ready()


# セットアップ関数
async def setup(bot):
    """Cogをロード"""
    await bot.add_cog(DungeonCog(bot))
    print("✓ DungeonCog loaded")
