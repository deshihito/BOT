# -*- coding: utf-8 -*-
"""
ダンジョンシステム Cog（スタンドアロン版）
dungeon.py - Discord.py Cog形式

【必須設定】
  .env:
    DUNGEON_IMG_CHANNEL_ID=画像投稿チャンネルID
  
  自前DB API テーブル:
    - dungeon_players (user_id, floor, x, y, hp, max_hp, atk, def_, spd, crit)
      ※マップは Phase 1-B からプレイヤー個人インスタンス（シード再生成＋
        差分は inventory._dungeon_meta の instances に保存）。
        旧 dungeon_maps / dungeon_bases テーブルは読み書きしない。
  
  main.py:
    await bot.load_extension('cogs.dungeon')
"""

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
# マップ描画の窓半径（17x17タイル）。現在視界 D_SIGHT_R より広く取り、
# 視界外の探索済みセルを「記憶」として暗く描く（Phase 1-D / 設計 §6-1）。
D_VIEW_R = 8
# 現在視界の半径。これより遠い探索済みセルは明度を落として描画する。
D_SIGHT_R = 6
TILE = 32

# Phase 1 の新マップ定義（並行導入。現行マップとは独立に使う）
D2_MAP_W = 29
D2_MAP_H = 29
D2_SECTOR_N = 3          # 3x3 セクター配置
D2_MAIN_ROLES = ("start", "combat", "event", "combat_or_chest", "stairs")
D2_SUB_ROLES = ("chest", "shop", "mine", "rest")

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

# 歩行時のバイオーム率エンカウントは Phase 1-D で廃止した。戦闘は部屋の
# 固定配置と、通路の初回通過時のアンブッシュ（D_AMBUSH_RATE）で発生する。

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
    "d1_tactics": {"name": "作戦教本", "description": "Clefの安全重視作戦を強化", "effect": "d1"},
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
CLEF_PLANS = {
    "safe": "安全探索", "speed": "最短攻略", "treasure": "財宝優先",
    "battle": "戦闘優先", "explore": "探索優先", "boss": "ボス準備優先",
    "xp": "経験値優先",
}
# Clefへ送る文脈は、渡す文脈は常に短く保つ（コンテキスト長対策）。
CLEF_STATE_CHARS = int(os.environ.get("CLEF_DUNGEON_STATE_CHARS", 2400))
CLEF_LOG_LINES = int(os.environ.get("CLEF_DUNGEON_LOG_LINES", 6))
CLEF_MAX_TURNS = int(os.environ.get("CLEF_DUNGEON_MAX_TURNS", 10))
# Phase 1-E: Phase 1-C 以降、Clef の1ターンは 1 journey（行き先までの
# 自動歩行）なので、CLEF_MAX_TURNS は「最大 journey 数」を意味する。
# 値は従来どおり10（1回の自動操作でフロア1枚分にほぼ相当する）。
CLEF_TIMEOUT = float(os.environ.get("CLEF_DUNGEON_TIMEOUT", 30))
CLEF_RETRIES = max(1, int(os.environ.get("CLEF_DUNGEON_RETRIES", 2)))
CLEF_RETRY_DELAY = float(os.environ.get("CLEF_DUNGEON_RETRY_DELAY", 1.5))
# 移動の定義（Phase 1-C: 斜め移動は廃止し4方向のみ）。
# 移動・経路探索・選択肢の基準提示で共通利用する。
_DIRECTIONS = {
    "up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0),
}
# fast-forward ウォーカー（Phase 1-C / 設計 §4-2）の定数。
D_WALK_MAX_STEPS = 18
# 通路アンブッシュ率（Phase 1-D / 設計 §4-2 停止条件5、確定事項 D4）。
# そのインスタンスで初めて踏む通路マスでのみ抽選する。
D_AMBUSH_RATE = 0.12
# 部屋の役割 → 表示名（Phase 1-D: 進捗表示・方向ボタン・ログで使う）。
D_ROOM_ROLE_NAMES = {
    "start": "スタートの間", "combat": "戦闘の間", "event": "イベントの間",
    "chest": "宝箱の間", "stairs": "階段の間", "shop": "商店",
    "mine": "採掘場", "rest": "休憩所", "shrine": "祠",
}
# 乗ったら journey を止めて処理する特殊タイル。
D_WALK_SPECIAL_CELLS = frozenset({
    D_STAIRS, D_CHEST, D_TRAP, D_SHOP, D_MINE, D_REST, D_SHRINE, D_EVENT,
})
# journey の停止理由 → ログ文言（先頭に「○へN歩進んだ。」が付く）。
D_WALK_STOP_TEXTS = {
    "room": "部屋に入った。",
    "junction": "分岐に着いた。",
    "dead_end": "行き止まりに着いた。",
    "room_edge": "部屋の壁際で止まった。",
    "door": "部屋の出口に着いた。",
    "center_line": "部屋の中心へ向かえる位置で止まった。",
    "max_steps": "一旦立ち止まった。",
    "low_hp": "HPが低下したため立ち止まった。",
    "ambush": "不意打ちを受けた！",
    "guard": "階段の番人が立ちはだかった！",
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
# NPCとフロア目標。Clefへ渡すゴール提示にも利用する。
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
dg_bases   = {}  # {uid: (floor, x, y)} ※Phase 1-Bで無効化（データは保持）
dg_instances = {}  # {(uid, floor): {seed, grid, rooms, start, consumed}} Phase 1-B: 個人インスタンス
_ASSET_CACHE = {}
_PLAYER_LOCKS = {}
# 正常保存済みペイロードのハッシュ。同一状態の再保存を省略して、
# 巨大なマップ／プレイヤーJSONの不要なPostgREST・WAL書き込みを防ぐ。
_MAP_SAVE_DIGESTS = {}
_PLAYER_SAVE_DIGESTS = {}

# 環境変数
DUNGEON_IMG_CHANNEL_ID = int(os.environ.get("DUNGEON_IMG_CHANNEL_ID", 0))
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

def d_get_instance(uid, floor):
    """プレイヤー個人のフロアインスタンスを取得する（Phase 1-B）。

    グリッドは d_floor_seed / d_gen_floor_v2 で決定的に再生成し、メモリに
    キャッシュする。保存済みの差分（消費済みセル）があれば再適用して復元する。
    """
    uid = str(uid)
    floor = int(floor)
    key = (uid, floor)
    inst = dg_instances.get(key)
    if inst is None:
        seed = d_floor_seed(SEASON_ID, uid, floor)
        grid, rooms = d_gen_floor_v2(seed, floor)
        start = next((tuple(r["center"]) for r in rooms if r["role"] == "start"), (1, 1))
        inst = {"seed": seed, "grid": grid, "rooms": rooms, "start": start,
                "consumed": set(), "visited": set(), "cleared": set(), "traversed": set()}
        saved = {}
        p = dg_players.get(uid)
        if p is not None:
            saved = (p.get("instances") or {}).get(str(floor)) or {}
        for cell in saved.get("consumed", []) or []:
            try:
                cx, cy = int(cell[0]), int(cell[1])
            except (TypeError, ValueError, IndexError):
                continue
            if 0 <= cx < D2_MAP_W and 0 <= cy < D2_MAP_H:
                inst["consumed"].add((cx, cy))
                grid[cy][cx] = D_FLOOR
        # Phase 1-D: フォグ（visited）と部屋の制圧状態（cleared）を復元する。
        inst["visited"] = d_decode_visited(saved.get("visited"))
        # アンブッシュ抽選済みの判定用に、実際に踏んだセルも復元する
        # （visited は表示用に周囲も含むため、踏んだセルとは一致しない）。
        inst["traversed"] = d_decode_visited(saved.get("traversed"))
        for rid in saved.get("cleared", []) or []:
            try:
                inst["cleared"].add(int(rid))
            except (TypeError, ValueError):
                continue
        # 開始時はスタート部屋を公開済みにする（冪等。復元済みなら無変化）。
        start_room = next((r for r in rooms if r["role"] == "start"), None)
        if start_room is not None:
            d_reveal_room(inst, start_room)
        dg_instances[key] = inst
    return inst


def d_instance_start(uid, floor):
    """そのプレイヤーの対象フロアのスタート座標を返す。"""
    return d_get_instance(uid, floor)["start"]


def d_instances_snapshot(uid):
    """保存用に、プレイヤーの全フロア分のインスタンス差分を辞書化する。"""
    uid = str(uid)
    snapshot = {}
    p = dg_players.get(uid) or {}
    for fkey, data in (p.get("instances") or {}).items():
        data = data or {}
        snapshot[str(fkey)] = {
            "seed": data.get("seed"),
            "consumed": [list(c) for c in data.get("consumed", []) or []],
            "visited": data.get("visited"),
            "cleared": [int(r) for r in data.get("cleared", []) or []],
            "traversed": data.get("traversed"),
        }
    for (u, f), inst in dg_instances.items():
        if u == uid:
            snapshot[str(f)] = {
                "seed": inst["seed"],
                "consumed": sorted(list(c) for c in inst["consumed"]),
                "visited": d_encode_visited(inst.get("visited") or set()),
                "cleared": sorted(int(r) for r in inst.get("cleared") or set()),
                "traversed": d_encode_visited(inst.get("traversed") or set()),
            }
    return snapshot


def d_migrate_player_v2(uid):
    """Phase 1-B の一回限り移行（設計 §7-2）。

    フラグの無い既存プレイヤーは、フロア/位置/HP/turns/season_score だけを
    リセットして個人インスタンスのスタートへ移す。レベル・装備・所持品・
    遺物・実績・クエスト・ウォレットには触らない。
    """
    uid = str(uid)
    p = dg_players.get(uid)
    if p is None or p.get("phase1b_v2"):
        return False
    p["phase1b_v2"] = True
    p["floor"] = 1
    p["x"], p["y"] = d_instance_start(uid, 1)
    p["hp"] = d_effective_stats(p)["max_hp"]
    p["turns"] = 0
    p["season_score"] = 0
    d_reset_floor_counters(p)
    return True


def d_ensure_map(uid, floor):
    """そのプレイヤーのフロアインスタンスが存在しなければ生成する。"""
    return d_get_instance(uid, floor)

def d_get_cell(uid, floor, x, y):
    """指定座標のセルタイプを取得（個人インスタンス基準）"""
    if 0 <= y < D2_MAP_H and 0 <= x < D2_MAP_W:
        return d_get_instance(uid, floor)["grid"][y][x]
    return D_WALL

def d_consume(uid, floor, x, y):
    """座標を消費（そのプレイヤーのインスタンス内でのみ床に変更）"""
    inst = d_get_instance(uid, floor)
    inst["consumed"].add((x, y))
    if 0 <= y < D2_MAP_H and 0 <= x < D2_MAP_W:
        inst["grid"][y][x] = D_FLOOR


def d_room_at(instance, x, y):
    """座標を含む部屋 dict を返す（通路など部屋の外は None）。"""
    for room in instance.get("rooms", []) or []:
        rx, ry, rw, rh = room["rect"]
        if rx <= x < rx + rw and ry <= y < ry + rh:
            return room
    return None


# ============================================================
#  Phase 1-D: フォグ（visited）と部屋の制圧状態（cleared）
#  設計書 dungeon-phase1-design.md §5 / §6-1。
# ============================================================

def d_encode_visited(visited):
    """踏破済みセルの集合を 29x29=841bit のビットセット Base64 にする（純粋関数）。"""
    bits = bytearray((D2_MAP_W * D2_MAP_H + 7) // 8)
    for x, y in visited or ():
        if 0 <= x < D2_MAP_W and 0 <= y < D2_MAP_H:
            idx = y * D2_MAP_W + x
            bits[idx // 8] |= 1 << (idx % 8)
    return base64.b64encode(bytes(bits)).decode("ascii")


def d_decode_visited(text):
    """d_encode_visited の逆変換。壊れた入力では空集合を返す（純粋関数）。"""
    visited = set()
    if not text:
        return visited
    try:
        raw = base64.b64decode(text, validate=True)
    except Exception:
        return visited
    for idx in range(D2_MAP_W * D2_MAP_H):
        byte = raw[idx // 8] if idx // 8 < len(raw) else 0
        if (byte >> (idx % 8)) & 1:
            visited.add((idx % D2_MAP_W, idx // D2_MAP_W))
    return visited


def d_reveal_room(inst, room):
    """部屋の公開（設計 §6-1）: 部屋全体＋接続通路の次マスまでを visited にする。"""
    visited = inst.setdefault("visited", set())
    grid = inst["grid"]
    rx, ry, rw, rh = room["rect"]
    for gy in range(ry, ry + rh):
        for gx in range(rx, rx + rw):
            visited.add((gx, gy))
    # 部屋の境界に隣接する通路マス（部屋の外で壁でないマス）を1マスだけ公開する。
    for gy in range(ry, ry + rh):
        for gx in range(rx, rx + rw):
            for vx, vy in _DIRECTIONS.values():
                nx, ny = gx + vx, gy + vy
                if (0 <= nx < D2_MAP_W and 0 <= ny < D2_MAP_H
                        and not (rx <= nx < rx + rw and ry <= ny < ry + rh)
                        and grid[ny][nx] != D_WALL):
                    visited.add((nx, ny))
    return visited


def d_mark_corridor_visited(inst, x, y):
    """通路の公開（設計 §6-1）: 通過マスとその周囲1マスを visited にする。"""
    visited = inst.setdefault("visited", set())
    for dy in range(-1, 2):
        for dx in range(-1, 2):
            nx, ny = x + dx, y + dy
            if 0 <= nx < D2_MAP_W and 0 <= ny < D2_MAP_H:
                visited.add((nx, ny))
    return visited


def d_room_cleared(inst, room_id):
    """部屋が制圧/消化済みかどうか。"""
    return room_id in (inst.get("cleared") or set())


def d_mark_room_cleared(inst, room_id):
    """部屋を制圧/消化済みにする。"""
    inst.setdefault("cleared", set()).add(room_id)


def d_room_discovered(inst, room):
    """部屋が発見済みか（rect 内のいずれかのセルが visited）。"""
    visited = inst.get("visited") or set()
    rx, ry, rw, rh = room["rect"]
    return any((gx, gy) in visited
               for gy in range(ry, ry + rh) for gx in range(rx, rx + rw))


def d_stairs_room_blocked(uid, floor, x, y):
    """座標の階段部屋が未制圧で、階段が番人に守られているかどうか。"""
    inst = d_get_instance(uid, floor)
    room = d_room_at(inst, x, y)
    return bool(room is not None and room.get("role") == "stairs"
                and not d_room_cleared(inst, room["id"]))


def d_floor_progress_text(uid):
    """フロア進捗の表示文（発見部屋数・階段の発見/番人制圧・現在の目的）。"""
    p = d_get_player(uid)
    inst = d_get_instance(uid, p["floor"])
    rooms = inst.get("rooms", []) or []
    discovered = [r for r in rooms if d_room_discovered(inst, r)]
    stairs_room = next((r for r in rooms if r["role"] == "stairs"), None)
    stairs_found = stairs_room is not None and d_room_discovered(inst, stairs_room)
    guard_done = stairs_room is not None and d_room_cleared(inst, stairs_room["id"])
    if stairs_room is None:
        objective = "階段を探す"
    elif not stairs_found:
        objective = "階段の間を探す（番人が守っている）"
    elif not guard_done:
        objective = "階段の間の番人を倒す"
    else:
        objective = "階段から上の階へ進む"
    return (
        f"発見: 部屋 {len(discovered)}/{len(rooms)}\n"
        f"階段: {'発見済み' if stairs_found else '未発見'} / 番人: {'制圧済み' if guard_done else '未制圧'}\n"
        f"目的: {objective}"
    )


# ============================================================
#  Phase 1-E: 部屋グラフ・Clef の行き先判断・「階段へ」ナビ・踏破計測
#  設計書 dungeon-phase1-design.md §8 / §9（PR 1-E）。
# ============================================================

def _d_corridor_component(instance, x, y):
    """(x, y) を含む通路（部屋の外の通行可能マス）の連結成分と、接する部屋id集合。

    部屋の中や壁を指定した場合は (空集合, 空集合) を返す（純粋関数）。
    """
    grid = instance["grid"]
    if not (0 <= x < D2_MAP_W and 0 <= y < D2_MAP_H) or grid[y][x] == D_WALL:
        return set(), set()
    if d_room_at(instance, x, y) is not None:
        return set(), set()
    cells = {(x, y)}
    touching = set()
    stack = [(x, y)]
    while stack:
        cx, cy = stack.pop()
        for vx, vy in _DIRECTIONS.values():
            nx, ny = cx + vx, cy + vy
            if not (0 <= nx < D2_MAP_W and 0 <= ny < D2_MAP_H) or grid[ny][nx] == D_WALL:
                continue
            room = d_room_at(instance, nx, ny)
            if room is not None:
                touching.add(room["id"])
            elif (nx, ny) not in cells:
                cells.add((nx, ny))
                stack.append((nx, ny))
    return cells, touching


def d_room_graph(instance):
    """部屋同士の隣接関係（部屋グラフ）をグリッドから導出する（純粋関数）。

    通路は交差しない設計（§3-1）のため、通路の連結成分ごとに「接する
    部屋同士」を結べば隣接関係が得られる。部屋同士が直接接している
    場合も隣接として扱う。戻り値: {room_id: set(room_id)}（双方向）。
    """
    rooms = instance.get("rooms", []) or []
    grid = instance["grid"]
    graph = {room["id"]: set() for room in rooms}
    room_of = {}
    for room in rooms:
        rx, ry, rw, rh = room["rect"]
        for gy in range(ry, ry + rh):
            for gx in range(rx, rx + rw):
                room_of[(gx, gy)] = room["id"]
    # 部屋同士の直接隣接。
    for (gx, gy), rid in room_of.items():
        for vx, vy in _DIRECTIONS.values():
            other = room_of.get((gx + vx, gy + vy))
            if other is not None and other != rid:
                graph[rid].add(other)
    # 通路の連結成分ごとに、接する部屋同士を結ぶ。
    seen = set()
    for y in range(D2_MAP_H):
        for x in range(D2_MAP_W):
            if grid[y][x] == D_WALL or (x, y) in room_of or (x, y) in seen:
                continue
            cells, touching = _d_corridor_component(instance, x, y)
            seen |= cells
            for a in touching:
                for b in touching:
                    if a != b:
                        graph[a].add(b)
    return graph


def d_room_distances(instance, start_room_id):
    """部屋グラフ上の BFS 距離（単位は部屋）。到達不能な部屋は含まない（純粋関数）。"""
    graph = d_room_graph(instance)
    dist = {start_room_id: 0}
    queue = [start_room_id]
    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        for nxt in sorted(graph.get(cur, ())):
            if nxt not in dist:
                dist[nxt] = dist[cur] + 1
                queue.append(nxt)
    return dist


def d_rooms_to_stairs(uid, floor, x, y):
    """現在位置から階段の間まで、あと何部屋通るか（純粋ロジック）。

    階段の間の中なら 0、隣の部屋なら 1。通路では「次に入る部屋」を
    1つ数える（接する部屋のうち最も近い経路で数える）。
    階段の間が無い/到達不能な場合は None。
    """
    inst = d_get_instance(uid, floor)
    stairs = next((r for r in inst.get("rooms", []) or [] if r["role"] == "stairs"), None)
    if stairs is None:
        return None
    room = d_room_at(inst, x, y)
    if room is not None:
        return d_room_distances(inst, room["id"]).get(stairs["id"])
    _, touching = _d_corridor_component(inst, x, y)
    best = None
    for rid in touching:
        rest = d_room_distances(inst, rid).get(stairs["id"])
        if rest is not None and (best is None or rest + 1 < best):
            best = rest + 1
    return best


def d_room_summary_text(uid, floor, x, y):
    """Clef向けの部屋グラフ要約（Phase 1-E / 設計 §8）。

    現在の部屋（役割・制圧状況）、各方向の行き先（発見済みなら役割名、
    未発見なら「未探索」）、階段の間までの部屋数、階段番の制圧状況を
    返す。旧「周囲3×3」情報の置き換え。
    """
    inst = d_get_instance(uid, floor)
    rooms = inst.get("rooms", []) or []
    room = d_room_at(inst, x, y)
    if room is None:
        here = "通路（部屋の外）"
    elif room["role"] == "start":
        here = D_ROOM_ROLE_NAMES.get(room["role"], "部屋")
    else:
        state = "制圧済み" if d_room_cleared(inst, room["id"]) else "未制圧"
        here = f"{D_ROOM_ROLE_NAMES.get(room['role'], '部屋')}（{state}）"
    exits = []
    for key in ("up", "down", "left", "right"):
        label = _DIRECTION_LABELS[key]
        if d_direction_blocked(uid, floor, x, y, key):
            exits.append(f"{label}: 壁（進めない）")
        else:
            dest = d_destination_label(uid, floor, x, y, key)
            exits.append(f"{label}: {dest or '通路'}")
    remain = d_rooms_to_stairs(uid, floor, x, y)
    stairs_room = next((r for r in rooms if r["role"] == "stairs"), None)
    if stairs_room is None:
        guard = "このフロアに階段の間はない"
    elif d_room_cleared(inst, stairs_room["id"]):
        guard = "階段の番人は制圧済み（階段が使える）"
    else:
        guard = "階段の番人は未制圧（倒すまで階段は使えない）"
    return "\n".join([
        f"現在地の部屋: {here}",
        "各方向の行き先: " + " / ".join(exits),
        f"階段の間まで: {'あと' + str(remain) + '部屋' if remain is not None else '不明'}",
        guard,
    ])


def d_next_direction_toward(uid, floor, x, y, target):
    """target へのグリッドBFS最短路の「最初の一歩」の方向を返す（純粋ロジック）。

    目標からの距離が1つ減る隣接マスへの方向を返す。到達済み
    （現在地 == target）または到達不能なら None。Clef フォールバック
    （dungeon_best_direction）が使う。「階段へ」ナビゲーションは
    journey 整合を優先する d_plan_navigation_direction を主に使い、
    本関数へは最終フォールバックとして落ちる。
    """
    if target is None or (x, y) == tuple(target):
        return None
    dist = dungeon_bfs(uid, floor, target[0], target[1])
    here = dist.get((x, y))
    if here is None:
        return None
    for key in ("up", "left", "right", "down"):
        vx, vy = _DIRECTIONS[key]
        if dist.get((x + vx, y + vy)) == here - 1:
            return key
    return None


def d_plan_navigation_direction(uid, floor, x, y, target):
    """target へ向かう次の journey の方向を決める（「階段へ」ナビの計画部分）。

    単純な「BFS最短路の最初の一歩」だけでは、特殊タイルのない部屋を
    journey が横断して行き過ぎ、同じ部屋同士を行き来する振動が起きる。
    そこで方向ごとに d_plan_walk を試し、journey の停止セルが目標への
    BFS距離を縮める方向を優先する（journey 実行と矛盾しない計画）。
    どの方向でも停止セルが近づかない場合のみ、最初の一歩へ落ちる。
    到達済み/到達不能なら None。
    """
    if target is None or (x, y) == tuple(target):
        return None
    dist = dungeon_bfs(uid, floor, target[0], target[1])
    here = dist.get((x, y))
    if here is None:
        return None
    best = None
    for order, key in enumerate(("up", "left", "right", "down")):
        if d_direction_blocked(uid, floor, x, y, key):
            continue
        plan = d_plan_walk(uid, floor, x, y, key)
        if not plan["path"]:
            continue
        stop_dist = dist.get(plan["stop_cell"])
        if stop_dist is None or stop_dist >= here:
            continue
        cand = (stop_dist, len(plan["path"]), order, key)
        if best is None or cand < best:
            best = cand
    if best is not None:
        return best[3]
    return d_next_direction_toward(uid, floor, x, y, target)


def _d_route_anchor_index(inst, x, y, main_rooms):
    """プレイヤーがメインルート上で到達した最も先の部屋の順序（無ければ -1）。

    部屋の中ではその部屋、サブルームでは接続先のメイン部屋、通路では
    接するメイン部屋のうち最も先のものを「現在地の前進度」とみなす。
    main_rooms はルート順（生成順）に並んでいる前提。
    """
    index_of = {room["id"]: i for i, room in enumerate(main_rooms)}
    room = d_room_at(inst, x, y)
    if room is not None:
        if room["id"] in index_of:
            return index_of[room["id"]]
        return index_of.get(room.get("host_id"), -1)
    _, touching = _d_corridor_component(inst, x, y)
    idxs = [index_of[rid] for rid in touching if rid in index_of]
    return max(idxs) if idxs else -1


def d_target_room(uid, plan="安全探索"):
    """作戦に応じた目標部屋を返す（Phase 1-E）。目標が決まらなければ None。

    - safe/speed/boss/xp: メインルート上で現在地より先にある未制圧の部屋
      → 無ければ階段の間（設計 §8 の決定的フォールバック方針）
    - treasure: 未消化の宝箱の間（と休憩所のサブルーム）
    - battle: 未制圧の combat 部屋（最も近いもの）
    - explore: 未発見の部屋（最も近いもの）
    作戦固有の候補が無い場合は safe と同じ方針へ落ちる。
    """
    p = d_get_player(uid)
    floor, x, y = p["floor"], p["x"], p["y"]
    inst = d_get_instance(uid, floor)
    rooms = inst.get("rooms", []) or []
    if not rooms:
        return None
    cleared = inst.get("cleared") or set()
    key = dungeon_plan_key(plan)
    dist_p = dungeon_bfs(uid, floor, x, y)

    def nearest(candidates):
        ranked = sorted(candidates,
                        key=lambda r: (dist_p.get(r["center"], 1 << 30), r["id"]))
        return ranked[0] if ranked else None

    if key == "treasure":
        target = nearest([r for r in rooms if r["id"] not in cleared
                          and (r["role"] == "chest"
                               or (r.get("route") == "sub" and r["role"] == "rest"))])
        if target is not None:
            return target
    elif key == "battle":
        target = nearest([r for r in rooms
                          if r["role"] == "combat" and r["id"] not in cleared])
        if target is not None:
            return target
    elif key == "explore":
        target = nearest([r for r in rooms if not d_room_discovered(inst, r)])
        if target is not None:
            return target

    # safe/speed/boss/xp、および作戦固有の候補が無い場合の共通方針:
    # メインルートを先へ進み、未制圧の部屋を順に片付けて階段を目指す。
    main_rooms = [r for r in rooms if r.get("route") == "main"]
    anchor = _d_route_anchor_index(inst, x, y, main_rooms)
    for idx, room in enumerate(main_rooms):
        if idx <= anchor or room["role"] == "start" or room["id"] in cleared:
            continue
        return room
    return next((r for r in rooms if r["role"] == "stairs"), None)


def d_stairs_discovered(uid, floor):
    """階段の間が発見済みか（「階段へ」ボタンの有効条件。進捗表示と同一基準）。"""
    inst = d_get_instance(uid, floor)
    room = next((r for r in inst.get("rooms", []) or [] if r["role"] == "stairs"), None)
    return room is not None and d_room_discovered(inst, room)


def d_reset_floor_counters(p):
    """フロアへ入った時点を踏破計測の起点にする（Phase 1-E）。

    階段での移動・死亡送還・移行・月次リセットの各遷移で呼ぶ。
    """
    p["floor_start_turns"] = p.get("turns", 0)
    p["floor_journeys"] = 0


def d_record_floor_clear(uid):
    """踏破したフロアの実績を floor_history へ1件記録する（Phase 1-E）。

    階段で次のフロアへ進む直前に呼ぶ。戻り値は記録したエントリ
    {floor, turns_used, journeys_used, cleared_at}。
    floor_history は直近50件だけを保持する。
    """
    p = d_get_player(uid)
    start_turns = p.get("floor_start_turns")
    turns_used = p.get("turns", 0) - start_turns if start_turns is not None else 0
    entry = {
        "floor": p["floor"],
        "turns_used": max(0, turns_used),
        "journeys_used": p.get("floor_journeys", 0),
        "cleared_at": datetime.datetime.now(JST).isoformat(),
    }
    history = p.setdefault("floor_history", [])
    history.append(entry)
    del history[:-50]
    return entry


def d_destination_label(uid, floor, x, y, direction):
    """方向ボタンの行き先ラベル（Phase 1-D / 設計 §6-2）。

    その方向へ進んだ先（d_plan_walk の到達点）にある部屋が発見済みなら
    役割名、未発見なら「未探索」、部屋でなければ「通路」を返す。
    1歩も進めない場合は None（ボタンは disabled 前提）。
    """
    plan = d_plan_walk(uid, floor, x, y, direction)
    if not plan["path"]:
        return None
    inst = d_get_instance(uid, floor)
    room = d_room_at(inst, *plan["stop_cell"])
    if room is None:
        return "通路"
    if d_room_discovered(inst, room):
        return D_ROOM_ROLE_NAMES.get(room["role"], "部屋")
    return "未探索"


def d_direction_blocked(uid, floor, x, y, direction):
    """その方向の1歩目が進めない（範囲外または壁）かどうか。"""
    vec = _DIRECTIONS.get(direction)
    if vec is None:
        return True
    nx, ny = x + vec[0], y + vec[1]
    if not (0 <= nx < D2_MAP_W and 0 <= ny < D2_MAP_H):
        return True
    return d_get_cell(uid, floor, nx, ny) == D_WALL


def d_plan_walk(uid, floor, x, y, direction):
    """fast-forward ウォーカーの経路計画（Phase 1-C / 設計 §4-2）。

    現在位置から direction（"up"/"down"/"left"/"right" のキー、または
    (dx, dy) タプル）へ、停止条件のいずれかに当たるまで進む経路を返す。
    エンカウント抽選と状態異常による HP 判定は実行側（d_execute_journey）
    の責務で、ここでは構造的な停止条件だけを判定する純粋ロジックとする。

    戻り値: {
      direction: キー文字列,
      path: [進む座標...]（開始マスは含まない）,
      stop_reason: "room"|"special"|"junction"|"dead_end"|"room_edge"|"door"|"center_line"|"max_steps"|"blocked",
      stop_cell: 最後に到達する座標（1歩も進めない場合は開始座標）,
      entered_room_id: stop_reason == "room" のとき入った部屋の id、それ以外は None,
    }
    """
    if isinstance(direction, (tuple, list)):
        direction = next((k for k, v in _DIRECTIONS.items() if tuple(direction) == v), None)
    result = {
        "direction": direction,
        "path": [],
        "stop_reason": "blocked",
        "stop_cell": (x, y),
        "entered_room_id": None,
    }
    if direction not in _DIRECTIONS:
        return result
    inst = d_get_instance(uid, floor)
    grid = inst["grid"]

    def passable(cx, cy):
        return 0 <= cx < D2_MAP_W and 0 <= cy < D2_MAP_H and grid[cy][cx] != D_WALL

    start_room = d_room_at(inst, x, y)
    cx, cy = x, y
    dx, dy = _DIRECTIONS[direction]
    came_from = None  # 直前にいた座標（逆方向を出口数えから除外する）
    while len(result["path"]) < D_WALK_MAX_STEPS:
        nx, ny = cx + dx, cy + dy
        if not passable(nx, ny):
            # 進めない。1歩目なら blocked、部屋の壁際なら room_edge、
            # それ以外（通路で進路だけが塞がれる形）は行き止まり扱い。
            if not result["path"]:
                result["stop_reason"] = "blocked"
            elif start_room is not None and d_room_at(inst, cx, cy) is start_room:
                result["stop_reason"] = "room_edge"
            else:
                result["stop_reason"] = "dead_end"
            break
        came_from = (cx, cy)
        cx, cy = nx, ny
        result["path"].append((cx, cy))
        result["stop_cell"] = (cx, cy)
        cell = grid[cy][cx]
        # 停止条件2: 特殊タイルに乗った。
        if cell in D_WALK_SPECIAL_CELLS:
            result["stop_reason"] = "special"
            break
        room = d_room_at(inst, cx, cy)
        # 停止条件1: 開始部屋とは別の部屋に入った。
        if room is not None and room is not start_room:
            result["stop_reason"] = "room"
            result["entered_room_id"] = room["id"]
            break
        # 停止条件6: 歩数上限。
        if len(result["path"]) >= D_WALK_MAX_STEPS:
            result["stop_reason"] = "max_steps"
            break
        if room is not None:
            # 停止条件（ドア）: 到達したセルに、来たマスと直進先以外へ部屋の
            # 外へ出る隣接マスがある場合はそこで止まる。通路は部屋の中心同士
            # を結ぶためドアが中心線からずれることが多く、直進を優先すると
            # 横方向のドアを素通りして部屋から出られなくなる（実機報告で
            # 検証済みの欠陥）。直進先の出口はそのまま通過できるため対象外
            # とし、部屋から部屋への1押下移動（Phase 1-C の契約）を保つ。
            # 特殊タイル/別部屋入室の判定より後、直進継続の判定より前に置く。
            if any(
                (cx + vx, cy + vy) != came_from
                and (cx + vx, cy + vy) != (cx + dx, cy + dy)
                and passable(cx + vx, cy + vy)
                and d_room_at(inst, cx + vx, cy + vy) is not room
                for vx, vy in _DIRECTIONS.values()
            ):
                result["stop_reason"] = "door"
                break
            # 停止条件（中心タイルへの折り返し）: 部屋の中心タイル（階段・
            # 宝箱等の特殊タイル）と列/行が揃うマスでは止まり、そこから
            # 中心へ曲がれるようにする。通路は中心同士を L字で結ぶため、
            # 折れ点が部屋の中にあると出入口が中心の行・列からずれ、
            # 壁際まで直進するだけでは中心タイルに永遠に届かないケースが
            # ある（生成インスタンスの約2割で階段タイル到達不能だった。
            # Phase 1-E の「階段へ」ナビ前提として同じ系統の欠陥を塞ぐ）。
            # 中心タイルへ直進中のマスは特殊タイル停止に任せ、対象外。
            center = room.get("center")
            if (center is not None and (cx, cy) != tuple(center)
                    and grid[center[1]][center[0]] in D_WALK_SPECIAL_CELLS
                    and ((dx != 0 and cx == center[0]) or (dy != 0 and cy == center[1]))):
                result["stop_reason"] = "center_line"
                break
            # 開始部屋の中では真っ直ぐ進み続ける。直進できなければ次ループ
            # 先頭の判定で room_edge になる。ただし隣に部屋の外への出口が
            # 1つだけある場合は、そこへ滑り込む（扉の位置ずれ吸収）。
            if passable(cx + dx, cy + dy):
                continue
            outside = [
                (cx + vx, cy + vy) for vx, vy in _DIRECTIONS.values()
                if (cx + vx, cy + vy) != came_from
                and passable(cx + vx, cy + vy)
                and d_room_at(inst, cx + vx, cy + vy) is not room
            ]
            if len(outside) == 1:
                dx, dy = outside[0][0] - cx, outside[0][1] - cy
                continue
            result["stop_reason"] = "room_edge"
            break
        # 通路: 来た方向以外の出口の数で分岐/行き止まりを判定する。
        exits = [
            (cx + vx, cy + vy) for vx, vy in _DIRECTIONS.values()
            if (cx + vx, cy + vy) != came_from and passable(cx + vx, cy + vy)
        ]
        if not exits:
            result["stop_reason"] = "dead_end"
            break
        if len(exits) >= 2:
            result["stop_reason"] = "junction"
            break
        dx, dy = exits[0][0] - cx, exits[0][1] - cy
    else:
        result["stop_reason"] = "max_steps"
    return result

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
        "equipment_upgrades": {},
        "instances": {}, "phase1b_v2": False,
        # Phase 1-E のフロア踏破計測（設計 §9 1-E）。floor_history は直近50件、
        # floor_start_turns / floor_journeys は現在フロアの計測カウンタ。
        "floor_history": [], "floor_start_turns": 0, "floor_journeys": 0,
    }

def d_get_player(uid):
    """プレイヤーのダンジョンデータを取得する。未保存の新規ユーザーも安全な初期値を持つ。"""
    uid = str(uid)
    p = dg_players.get(uid)
    if p is None:
        p = dg_players[uid] = d_default_player()
        # 新規プレイヤーは移行対象ではない。初期位置は個人インスタンスのスタート。
        p["phase1b_v2"] = True
        p["x"], p["y"] = d_instance_start(uid, p["floor"])
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
        # 強化レベルはプレイヤー個別の equipment_upgrades から読む
        # （旧実装は共有の EQUIPMENT_MASTER を書き換えていたため全員に影響した）。
        upgrade = int(p.get("equipment_upgrades", {}).get(key, 0))
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


def d_progress_quest(uid, kind, amount=1, db_api=None):
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
    """素材を消費して装備を1段階強化する。

    強化レベルはプレイヤー個別の equipment_upgrades に保存する。
    共有マスタ EQUIPMENT_MASTER は絶対に書き換えない（他プレイヤーへの波及防止）。
    """
    p = d_get_player(uid)
    if key not in EQUIPMENT_MASTER or p.get("materials", {}).get(material, 0) <= 0:
        return False
    p["materials"][material] -= 1
    upgrades = p.setdefault("equipment_upgrades", {})
    upgrades[key] = int(upgrades.get(key, 0)) + 1
    return True

def d_floor_modifier(floor):
    """フロアごとの軽量な変異。固定化してClefにもログで伝えられる。"""
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

def d_clear_status(uid):
    """状態異常を全解除する（休憩・次フロア到達時のライフサイクル規則）。

    戦闘用フラグ（凍結による行動不能など）も状態異常と一体なので一緒に消す。
    """
    p = d_get_player(uid)
    p["active_effects"] = []
    p.setdefault("battle_flags", {}).clear()


def d_tick_status(uid):
    """状態異常を1ターン進め、表示用ログとダメージを返す。

    ライフサイクル規則（Phase 0 で定義）:
      - 進行: 戦闘中は敵ターン（DungeonCombatView._enemy_turn）、探索中は移動ターン
        （DungeonMainView._move_locked）でそれぞれ1回だけ進める。二重に進めないこと。
      - 解除: 休憩タイル（D_REST）と階段で次フロアへ進む際に全解除する（d_clear_status）。
    """
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


async def d_apply_economy(uid, db_api, coins=0):
    """ウォレットを更新する。SQL RPCがあれば原子処理を優先し、旧環境には安全なフォールバックを使う。"""
    if not db_api or not coins:
        return True

    def _apply():
        try:
            result = run_with_retry(lambda: db_api.rpc("dungeon_apply_coins", {
                "p_user_id": str(uid), "p_delta": int(coins)
            }).execute())
            return result.data is not False
        except APIError as exc:
            if exc.code not in {"RPC_NOT_ALLOWED", "42883"}:
                raise
            logger.warning("dungeon_apply_coins RPC is unavailable; using legacy fallback", exc_info=True)
        except Exception:
            logger.exception("dungeon_apply_coins RPC failed unexpectedly; refusing legacy fallback")
            raise

        row = db_api.table("users").select("balance").eq("user_id", str(uid)).execute()
        current = int(row.data[0].get("balance") or 0) if row.data else 10
        # 罠などの減算は残高0を下限とし、ゲーム操作自体は失敗させない。
        new_balance = max(0, current + int(coins))
        if row.data:
            updated = (db_api.table("users").update({"balance": new_balance})
                       .eq("user_id", str(uid)).eq("balance", current).execute())
            return bool(updated.data)
        inserted = db_api.table("users").insert({
            "user_id": str(uid), "balance": new_balance, "debt": 0
        }).execute()
        return bool(inserted.data)

    return await asyncio.to_thread(_apply)


async def d_apply_reward(uid, db_api, *, coins=0, xp=0, boxes=0, bread=0, chips=0, items=None, equipment=None, relic=None, material=None, achievement=None, season_score=0):
    """戦利品をプレイヤーとウォレットへ一度のアクションで反映する。"""
    if not await d_apply_economy(uid, db_api, coins):
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

def d_open_chest(uid, db_api):
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

# ============================================================
#  Phase 1: 新フロアジェネレータ（部屋＋通路方式・シード決定的）
#  設計書 dungeon-phase1-design.md §3 に準拠。現行の d_gen_floor とは
#  並行導入であり、ゲーム動作にはまだ切り替えていない（Phase 1-B 以降）。
# ============================================================

# v2 の役割タイル対応。combat 部屋はタイルを置かず入室で発動する（Phase 1-D）。
_D2_ROLE_TILES = {
    "start": D_START,
    "stairs": D_STAIRS,
    "chest": D_CHEST,
    "shop": D_SHOP,
    "mine": D_MINE,
    "rest": D_REST,
    "event": D_EVENT,
}


def d_floor_seed(season_id, user_id, floor):
    """(season, user, floor) から v2 フロア生成用の決定的シードを導出する。"""
    digest = hashlib.sha256(f"{season_id}:{user_id}:{floor}:v2".encode("utf-8")).hexdigest()
    return int(digest[:16], 16)


def _d2_sector_origin(sector_index):
    """セクター番号 (0..2) の左上座標。外周1マスは壁として残す。"""
    return 1 + sector_index * ((D2_MAP_W - 2) // D2_SECTOR_N)


def _d2_main_route(rng):
    """3x3 セクターグリッド上で重複なし・隣接のみの5セクタールートを作る。"""
    neighbors = [(0, -1), (0, 1), (-1, 0), (1, 0)]
    for _ in range(1000):
        route = [(rng.randrange(D2_SECTOR_N), rng.randrange(D2_SECTOR_N))]
        while len(route) < len(D2_MAIN_ROLES):
            cx, cy = route[-1]
            options = [
                (cx + dx, cy + dy) for dx, dy in neighbors
                if 0 <= cx + dx < D2_SECTOR_N and 0 <= cy + dy < D2_SECTOR_N
                and (cx + dx, cy + dy) not in route
            ]
            if not options:
                break
            route.append(rng.choice(options))
        if len(route) == len(D2_MAIN_ROLES):
            return route
    raise RuntimeError("d_gen_floor_v2: メインルートを生成できませんでした")


def d_gen_floor_v2(seed, floor):
    """シード決定的な部屋＋通路フロアを生成し、(grid, rooms) を返す。

    grid は D2_MAP_H x D2_MAP_W のタイル文字列の2次元リスト（grid[y][x]）。
    rooms は各部屋の dict のリストで、少なくとも
    {id, role, rect:(x, y, w, h), center:(x, y), sector:(sx, sy), route}
    を含む。階段部屋には guarded=True、5フロア毎は boss=True も付く。
    乱数は引数 seed から作る random.Random のみを使い、再現性を保証する。
    """
    rng = random.Random(seed)
    grid = [[D_WALL] * D2_MAP_W for _ in range(D2_MAP_H)]

    # --- セクター決定: メインルート5 + サブ1〜2 ---
    main_sectors = _d2_main_route(rng)
    main_set = set(main_sectors)
    sub_candidates = []
    for sy in range(D2_SECTOR_N):
        for sx in range(D2_SECTOR_N):
            if (sx, sy) in main_set:
                continue
            if any((sx + dx, sy + dy) in main_set for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0))):
                sub_candidates.append((sx, sy))
    rng.shuffle(sub_candidates)
    sub_count = min(len(sub_candidates), rng.randint(1, 2)) if sub_candidates else 0
    sub_sectors = sub_candidates[:sub_count]

    # --- 役割割り当て ---
    # メイン4番目 (combat_or_chest) は抽選で実役割に解決する。
    fourth = "chest" if rng.random() < 0.5 else "combat"
    main_roles = ["start", "combat", "event", fourth, "stairs"]
    sub_roles = rng.sample(list(D2_SUB_ROLES), len(sub_sectors))

    # --- 部屋配置（セクター内に 5x5〜7x7、ランダムオフセット） ---
    rooms = []

    def place_room(sector, role, route):
        sx, sy = sector
        ox, oy = _d2_sector_origin(sx), _d2_sector_origin(sy)
        sector_size = (D2_MAP_W - 2) // D2_SECTOR_N
        w = rng.randint(5, 7)
        h = rng.randint(5, 7)
        x = ox + rng.randint(0, sector_size - w)
        y = oy + rng.randint(0, sector_size - h)
        room = {
            "id": len(rooms),
            "role": role,
            "rect": (x, y, w, h),
            "center": (x + w // 2, y + h // 2),
            "sector": (sx, sy),
            "route": route,
        }
        if role == "stairs":
            room["guarded"] = True
            room["boss"] = (int(floor) % 5 == 0)
        rooms.append(room)
        for gy in range(y, y + h):
            for gx in range(x, x + w):
                grid[gy][gx] = D_FLOOR
        return room

    main_rooms = [place_room(sector, role, "main") for sector, role in zip(main_sectors, main_roles)]
    sub_rooms = []
    for sector, role in zip(sub_sectors, sub_roles):
        room = place_room(sector, role, "sub")
        # 接続先は隣接するメイン部屋から1つ選ぶ（行き止まりの寄り道にする）。
        sx, sy = sector
        hosts = [r for r in main_rooms
                 if abs(r["sector"][0] - sx) + abs(r["sector"][1] - sy) == 1]
        room["host_id"] = rng.choice(hosts)["id"]
        sub_rooms.append(room)

    # --- 通路: 隣接部屋の中心同士を L字（幅1）で接続 ---
    corridor_cells = []

    def carve_corridor(a, b):
        x1, y1 = a
        x2, y2 = b
        cells = []
        if rng.random() < 0.5:
            points = [(x, y1) for x in range(min(x1, x2), max(x1, x2) + 1)]
            points += [(x2, y) for y in range(min(y1, y2), max(y1, y2) + 1)]
        else:
            points = [(x1, y) for y in range(min(y1, y2), max(y1, y2) + 1)]
            points += [(x, y2) for x in range(min(x1, x2), max(x1, x2) + 1)]
        for gx, gy in points:
            if grid[gy][gx] == D_WALL:
                grid[gy][gx] = D_FLOOR
                cells.append((gx, gy))
        return cells

    for prev, nxt in zip(main_rooms, main_rooms[1:]):
        corridor_cells += carve_corridor(prev["center"], nxt["center"])
    for room in sub_rooms:
        host = main_rooms[room["host_id"]]
        corridor_cells += carve_corridor(room["center"], host["center"])

    # --- 役割タイルを部屋中央へ（通路で上書きされないよう最後に置く） ---
    for room in rooms:
        tile = _D2_ROLE_TILES.get(room["role"])
        if tile is not None:
            cx, cy = room["center"]
            grid[cy][cx] = tile

    # --- 罠: 通路マス（部屋の外）から 0〜2 個 ---
    if corridor_cells:
        trap_count = min(len(corridor_cells), rng.randint(0, 2))
        for gx, gy in rng.sample(corridor_cells, trap_count):
            grid[gy][gx] = D_TRAP

    return grid, rooms

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
    """マップをPillow Imageとして生成（そのプレイヤーのインスタンスを描く）。

    Phase 1-D のフォグ・オブ・ウォー（設計 §6-1）:
      - 未探索セル: 黒（霧）
      - 探索済みだが現在視界（D_SIGHT_R）の外: 明度45%で描画（記憶表示）
      - 視界内の探索済みセル: 通常描画
    """
    inst = d_get_instance(uid, floor)
    grid = inst["grid"]
    visited = inst.get("visited") or set()
    bname, *_ = d_get_biome(floor)
    size = radius * 2 + 1
    img = Image.new("RGB", (size * TILE, size * TILE), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    for vy_i, vy in enumerate(range(py - radius, py + radius + 1)):
        for vx_i, vx in enumerate(range(px - radius, px + radius + 1)):
            is_player = (vx == px and vy == py)
            if not (0 <= vx < D2_MAP_W and 0 <= vy < D2_MAP_H):
                _draw_tile(draw, img, vx_i, vy_i, D_WALL, bname, is_fog=True)
                continue
            if not is_player and (vx, vy) not in visited:
                _draw_tile(draw, img, vx_i, vy_i, D_WALL, bname, is_fog=True)
                continue
            cell = grid[vy][vx]
            _draw_tile(draw, img, vx_i, vy_i, cell, bname, is_player=is_player)
            if not is_player and max(abs(vx - px), abs(vy - py)) > D_SIGHT_R:
                # 探索済みの記憶表示: そのセルの描画だけ明度を落とす。
                box = (vx_i * TILE, vy_i * TILE, (vx_i + 1) * TILE, (vy_i + 1) * TILE)
                img.paste(ImageEnhance.Brightness(img.crop(box)).enhance(0.45), box[:2])

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

async def dg_load_all(db_api):
    """自前DB APIから全ダンジョンデータを読み込む。

    Phase 1-B: マップはプレイヤー個人インスタンス（シード再生成＋差分復元）
    になったため、dungeon_maps / dungeon_bases テーブルは読み込まない。
    インスタンスは初回アクセス時に d_get_instance が生成し、プレイヤーに
    保存された consumed 差分を再適用して復元する。
    """
    global dg_players

    try:
        res = db_api.table("dungeon_players").select("*").execute()
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
                "equipment_upgrades": meta.get("equipment_upgrades", {}) or {},
                "instances": meta.get("instances", {}) or {},
                "phase1b_v2": bool(meta.get("phase1b_v2", False)),
                # Phase 1-E の踏破計測。旧データに無い場合は「読み込み時点」を起点にする。
                "floor_history": meta.get("floor_history", []) or [],
                "floor_start_turns": meta.get("floor_start_turns", row.get("turns", 0)),
                "floor_journeys": meta.get("floor_journeys", 0),
            }
            # Phase 1-B 移行（設計 §7-2）: フラグの無い既存プレイヤーは一度だけ新基盤へ移す。
            d_migrate_player_v2(row["user_id"])
        print(f"✓ ダンジョンプレイヤー読み込み完了: {len(dg_players)}人")
    except Exception as e:
        print(f"<:failed:1490986584676368535> ダンジョンプレイヤー読み込み失敗: {e}")

async def dg_save_map(uid, floor, db_api):
    """互換ラッパー（Phase 1-B）。

    マップは個人インスタンス化され、差分はプレイヤー保存（_dungeon_meta）に
    含まれるため、実体はプレイヤー保存へ委譲する。dungeon_maps テーブルへは
    もう書かない。
    """
    await dg_save_player(uid, db_api)

async def dg_save_player(uid, db_api):
    """プレイヤーのダンジョンデータを自前DB APIに保存"""
    if uid not in dg_players:
        return
    try:
        p = dg_players[uid]
        # ライブなインスタンス差分をプレイヤー状態へ同期してから保存する。
        p["instances"] = d_instances_snapshot(uid)
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
            "equipment_upgrades": p.get("equipment_upgrades", {}),
            "instances": p.get("instances", {}),
            "phase1b_v2": bool(p.get("phase1b_v2", False)),
            "floor_history": p.get("floor_history", [])[-50:],
            "floor_start_turns": p.get("floor_start_turns", 0),
            "floor_journeys": p.get("floor_journeys", 0),
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
        db_api.table("dungeon_players").upsert(payload, on_conflict="user_id").execute()
        _PLAYER_SAVE_DIGESTS[uid] = digest
    except Exception as e:
        print(f"dg_save_player失敗 uid={uid}: {e}")

async def dg_save_base(uid, floor, x, y, db_api):
    """プレイヤーの拠点を自前DB APIに保存"""
    dg_bases[uid] = (floor, x, y)
    try:
        db_api.table("dungeon_bases").upsert({
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
#  Clef作戦ヘルパー（旧 dungeon_dangeon.py から統廃合）
# ============================================================
# Clefへ渡す合法手。待機（enter/check）は選択肢に含めない。
# Phase 1-C で移動が4方向化したため、合法手も4方向のみ（journey 単位で実行する）。
CLEF_MOVE_KEYS = tuple(_DIRECTIONS)

CLEF_PLAN_GUIDANCE = {
    "safe": "HPと被弾を最優先で避け、敵の少ない経路で階段を目指す",
    "speed": "最短手数で階段へ向かう",
    "treasure": "宝箱・鉱山・祭壇などの報酬タイルを優先して回収する",
    "battle": "敵との戦闘を積極的に選び、経験値とドロップを稼ぐ",
    "explore": "未探索の床を広く踏んでマップを開拓する",
    "boss": "回復と装備を整え、ボスに備えてHPを高く保つ",
    "xp": "経験値効率の良い行動を選ぶ",
}


def dungeon_plan_key(plan):
    """表示名・キーのどちらからでも作戦キーを解決する。"""
    if plan in CLEF_PLANS:
        return plan
    for key, name in CLEF_PLANS.items():
        if name == plan:
            return key
    return "safe"


def dungeon_plan_guidance(plan):
    """作戦ごとの優先基準。Clefへの指示文に含める。"""
    return CLEF_PLAN_GUIDANCE.get(dungeon_plan_key(plan), CLEF_PLAN_GUIDANCE["safe"])


def d_floor_routes(uid):
    """フロア内の代表的な進み方。作戦スコアの比較対象。"""
    return [
        {"id": "safe", "label": "安全", "risk": 1, "reward": 1, "score": 4},
        {"id": "treasure", "label": "財宝", "risk": 3, "reward": 4, "score": 3},
        {"id": "battle", "label": "戦闘", "risk": 4, "reward": 5, "score": 2},
    ]


def dungeon_action_candidates(uid, plan="安全探索"):
    """作戦の重みを掛けた候補評価。危険度と報酬のどちらを取るかを明示する。"""
    routes = d_floor_routes(uid)
    weights = {"safe": (3, -2), "speed": (1, 5), "treasure": (4, 0), "battle": (-1, 2),
               "explore": (2, 1), "boss": (1, 3), "xp": (0, 4)}
    risk_w, reward_w = weights.get(dungeon_plan_key(plan), weights["safe"])
    for route in routes:
        route["plan_score"] = route["reward"] * reward_w - route["risk"] * risk_w
    return routes


def dungeon_candidate_log(uid, plan):
    """画面表示用の候補評価ログ。Clefへの入力には含めない（コンテキスト長対策）。"""
    candidates = dungeon_action_candidates(uid, plan)
    return "候補評価: " + " / ".join(
        f"{c['id']}:{c['label']} 危険度{c['risk']} 報酬{c['reward']} 作戦点{c['plan_score']}" for c in candidates
    )


def d_normalize_choice(value, legal, fallback=None):
    """Clefの応答を合法手へ寄せる。表記ゆれだけを吸収し、それ以外はfallbackを返す。"""
    value = str(value or "").strip().lower().replace(" ", "")
    aliases = {"north": "up", "south": "down", "west": "left", "east": "right",
               "upward": "up", "downward": "down", "leftward": "left", "rightward": "right"}
    value = aliases.get(value, value)
    return value if value in legal else (fallback if fallback in legal else None)


def dungeon_relative_label(dx, dy):
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


def dungeon_bfs(uid, floor, x, y):
    """現在地からの歩数マップ（4方向・壁は通行不可）。"""
    dist = {(x, y): 0}
    queue = [(x, y)]
    head = 0
    while head < len(queue):
        cx, cy = queue[head]
        head += 1
        step = dist[(cx, cy)] + 1
        for dx, dy in _DIRECTIONS.values():
            nx, ny = cx + dx, cy + dy
            if (nx, ny) in dist or not (0 <= nx < D2_MAP_W and 0 <= ny < D2_MAP_H):
                continue
            if d_get_cell(uid, floor, nx, ny) == D_WALL:
                continue
            dist[(nx, ny)] = step
            queue.append((nx, ny))
    return dist


def dungeon_stairs_cell(uid, floor):
    """そのプレイヤーのフロア内の階段座標を返す。"""
    for gy, row in enumerate(d_get_instance(uid, floor)["grid"]):
        for gx, cell in enumerate(row):
            if cell == D_STAIRS:
                return (gx, gy)
    return None


def dungeon_stairs_hint(uid, floor, x, y, dist=None):
    """階段までの方角と歩数。Clefへ示す目標情報。"""
    stairs = dungeon_stairs_cell(uid, floor)
    if not stairs:
        return "このフロアに階段なし"
    if dist is None:
        dist = dungeon_bfs(uid, floor, x, y)
    steps = dist.get(stairs)
    if steps is None:
        return "階段は壁で区切られ到達不可"
    return f"{dungeon_relative_label(stairs[0] - x, stairs[1] - y)} {steps}マス"


def dungeon_move_criteria(uid, floor, x, y, dist=None):
    """Clefへ渡す「各方向へ進むとどうなるか」の基準（Phase 1-E で部屋前提に改修）。

    1方向 = 1 journey として、到達点がどの部屋か（発見済みなら役割名と
    制圧状況、未発見なら「未探索」）、通路なら分岐/行き止まり等を明示する。
    dist 引数は互換のため残すが、判定は d_plan_walk と部屋グラフで行う。
    """
    inst = d_get_instance(uid, floor)
    criteria = {}
    for key in _DIRECTIONS:
        label = _DIRECTION_LABELS[key]
        if d_direction_blocked(uid, floor, x, y, key):
            criteria[key] = f"{label}は壁（進めない）"
            continue
        plan = d_plan_walk(uid, floor, x, y, key)
        if not plan["path"]:
            criteria[key] = f"{label}は壁（進めない）"
            continue
        sx, sy = plan["stop_cell"]
        room = d_room_at(inst, sx, sy)
        remain = d_rooms_to_stairs(uid, floor, sx, sy)
        tail = f"（階段の間まであと{remain}部屋）" if remain is not None else ""
        if room is None:
            kind = {"junction": "通路の分岐", "dead_end": "通路の行き止まり"}.get(
                plan["stop_reason"], "通路")
            criteria[key] = f"{label}は{kind}まで進む（移動可）{tail}"
        elif d_room_discovered(inst, room):
            name = D_ROOM_ROLE_NAMES.get(room["role"], "部屋")
            if room["role"] == "start":
                criteria[key] = f"{label}は{name}まで進む（移動可）{tail}"
            else:
                state = "制圧済み" if d_room_cleared(inst, room["id"]) else "未制圧"
                criteria[key] = f"{label}は{name}（{state}）まで進む（移動可）{tail}"
        else:
            criteria[key] = f"{label}は未探索の部屋まで進む（移動可）{tail}"
    return criteria


def dungeon_goal_text(uid):
    """Clefへ渡すゴール。階層目標・フロア目標・クエストを短くまとめる。"""
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


def dungeon_best_direction(uid, plan="安全探索", dist=None):
    """Clefの応答が使えない時のフォールバック（Phase 1-E で目標部屋方式に改修）。

    作戦に応じた目標部屋（d_target_room）を決め、その中心へのグリッドBFS
    最短路の最初の一歩を返す。journey は分岐・部屋で止まるため、ターン
    毎に再計算すれば目標部屋へ辿り着ける。目標が決まらない場合は
    階段へ近づく合法手、合法手自体が無い場合は従来どおり "up" を返す。
    """
    p = d_get_player(uid)
    floor, x, y = p["floor"], p["x"], p["y"]
    target = d_target_room(uid, plan)
    if target is not None:
        direction = d_next_direction_toward(uid, floor, x, y, target["center"])
        if direction is not None:
            return direction
    # 保険: 進める方向のうち階段タイルへ最も近いものを選ぶ。
    legal = [key for key in _DIRECTIONS
             if not d_direction_blocked(uid, floor, x, y, key)]
    if not legal:
        return "up"
    stairs = dungeon_stairs_cell(uid, floor)
    if stairs:
        dist_from_stairs = dungeon_bfs(uid, floor, stairs[0], stairs[1])
        legal.sort(key=lambda k: dist_from_stairs.get(
            (x + _DIRECTIONS[k][0], y + _DIRECTIONS[k][1]), 9999))
    return legal[0]


def d_make_reward_choices(uid, enemy):
    """戦闘勝利時の3候補。作戦教本を持つとコイン報酬が少し強化される。"""
    p = d_get_player(uid)
    box_count = max(1, enemy.get("reward_box", 0))
    base = [
        {"label": f"コイン +{enemy.get('reward_coins', 0)}", "reward": {"coins": enemy.get("reward_coins", 0)}},
        {"label": f"経験値 +{enemy.get('reward_xp', 0)}", "reward": {"xp": enemy.get("reward_xp", 0)}},
        {"label": f"宝箱 ×{box_count}", "reward": {"boxes": box_count}},
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
    """行動ログを記録する。Clefの判断材料とUI表示の双方で使う。"""
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


async def d_current_cell_action(uid, db_api):
    """現在マスのタイルを再発動し、表示用メッセージを返す。

    操作メニューの「現在地を操作」と、メインパネル中央ボタン「部屋で行動」
    で共用する（Phase 1-C）。階段・採掘・休憩・商店のみが対象。
    """
    uid = str(uid)
    p = d_get_player(uid)
    floor = p["floor"]
    cell = d_get_cell(uid, floor, p["x"], p["y"])
    msg = "この場所では操作できません。"
    if cell == D_STAIRS and d_stairs_room_blocked(uid, floor, p["x"], p["y"]):
        # Phase 1-D: 未制圧の階段部屋では番人を倒すまで階段を使えない。
        msg = "階段は番人に守られている。番人を倒さないと使えない。"
    elif cell == D_STAIRS and floor < D_FLOORS:
        d_record_floor_clear(uid)
        p["floor"] = floor + 1
        p["hp"] = d_effective_stats(p)["max_hp"]
        d_clear_status(uid)
        p["x"], p["y"] = d_instance_start(uid, p["floor"])
        d_reset_floor_counters(p)
        d_progress_quest(uid, "floor", 1)
        msg = f"階段を上り、{p['floor']}Fへ進みました。"
    elif cell == D_MINE:
        gain = d_do_mine(uid)
        await d_apply_reward(uid, db_api, coins=gain)
        d_consume(uid, floor, p["x"], p["y"])
        msg = f"採掘してコインを{gain}枚獲得しました。"
    elif cell == D_REST:
        stats = d_effective_stats(p)
        before = p["hp"]
        p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
        d_clear_status(uid)
        d_consume(uid, floor, p["x"], p["y"])
        msg = f"休憩してHPが {p['hp'] - before} 回復しました。"
    elif cell == D_SHOP:
        try:
            await d_apply_reward(uid, db_api, coins=-30, bread=1)
            msg = "商店でレアパンを購入しました。"
        except Exception:
            msg = "コイン不足で購入できません。"
    await dg_save_player(uid, db_api)
    return msg


async def d_activate_room_entry(uid, db_api, room, result):
    """部屋への初入室時に役割を発動する（Phase 1-D / 設計 §5）。

    戦闘を開始する場合は敵 dict を返し、呼び出し側（journey）が結果へ
    繋ぐ。それ以外は None を返す。商店/採掘の部屋は result["view"] を
    設定する（消化扱いにはしない）。一度きりの部屋（宝箱/イベント/祠/
    休憩）は発動と同時に制圧済みにし、部屋中央の役割タイルを消費する。
    戦闘系（combat/stairs）は勝利時に DungeonCombatView._win から
    制圧済みにされるため、ここでは倒すまで未制圧のままにしておく。
    """
    uid = str(uid)
    p = d_get_player(uid)
    floor = p["floor"]
    inst = d_get_instance(uid, floor)
    role = room.get("role")
    if role == "combat":
        if d_room_cleared(inst, room["id"]):
            return None
        result["messages"].append("戦闘の間だ。敵が現れた！")
        return d_make_enemy(floor, forced_rank="normal")
    if role == "stairs":
        if d_room_cleared(inst, room["id"]):
            return None
        result["messages"].append("階段の間だ。番人が立ちはだかっている！")
        return d_make_enemy(floor, forced_rank="boss" if room.get("boss") else "elite")
    if role in ("shop", "mine"):
        result["view"] = role
        return None
    if role not in ("chest", "event", "shrine", "rest"):
        return None
    if d_room_cleared(inst, room["id"]):
        return None
    if role == "chest":
        text, reward = d_open_chest(uid, db_api)
        await d_apply_reward(uid, db_api, **reward)
    elif role == "event":
        gain = random.randint(20, 80)
        await d_apply_reward(uid, db_api, coins=gain, xp=gain, season_score=25)
        text = f"旅人の依頼を達成した。コイン+{gain}、XP+{gain}"
    elif role == "shrine":
        p["atk"] += 2
        text = "祭壇の祝福！ 基礎ATKが2上昇した。"
    else:  # rest
        before = p["hp"]
        stats = d_effective_stats(p)
        p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
        d_clear_status(uid)
        text = f"休憩した。HPが {p['hp'] - before} 回復し、状態異常が治った。"
    cx, cy = room["center"]
    d_consume(uid, floor, cx, cy)
    d_mark_room_cleared(inst, room["id"])
    result["messages"].append(text)
    return None


async def d_execute_journey(uid, db_api, direction, *, source="manual"):
    """1回の移動判断（journey）を実行する（Phase 1-C / 設計 §4）。

    d_plan_walk で計画した経路を1歩ずつ適用し、各歩で従来の1マス処理
    （turns/スコア加算、状態異常 tick、クエスト進行、特殊タイル処理）を
    行う。Phase 1-D 以降は、部屋への初入室で役割が発動し（戦闘・宝箱・
    イベント等）、通路では初回通過マスだけアンブッシュ抽選を行う。
    保存は journey の最後に1回だけ。描画と View 遷移は呼び出し側の
    責務とし、本関数は結果だけを返す。action_log には journey を
    1件として記録する。

    戻り値: {
      direction, steps, stop_reason, start, end, path,
      messages: [ログ断片...]（先頭は「○へN歩進んだ。…」）,
      view: None | "stairs" | "shop" | "mine" | "combat",
      enemy: view == "combat" のときの敵 dict、それ以外は None,
      room_id: 戦闘が部屋発動の場合その部屋 id、それ以外は None,
      died: journey 中に力尽きたか,
    }
    """
    uid = str(uid)
    p = d_get_player(uid)
    floor = p["floor"]
    start = (p["x"], p["y"])
    hp_before = p["hp"]
    plan = d_plan_walk(uid, floor, start[0], start[1], direction)
    result = {
        "direction": plan["direction"],
        "steps": 0,
        "stop_reason": plan["stop_reason"],
        "start": start,
        "end": start,
        "path": [],
        "messages": [],
        "view": None,
        "enemy": None,
        "room_id": None,
        "died": False,
    }
    if not plan["path"]:
        return result
    # Phase 1-E の計測: 実際に歩いた journey を現在フロアのカウンタへ加算する
    # （手動・Clef・「階段へ」ナビの合算。フロア踏破時に floor_history へ移る）。
    p["floor_journeys"] = p.get("floor_journeys", 0) + 1
    inst = d_get_instance(uid, floor)
    prev_room = d_room_at(inst, start[0], start[1])
    # 立っている開始マスは「踏んだ」ものとして扱う（アンブッシュ抽選の対象外）。
    inst.setdefault("traversed", set()).add(start)

    def _apply_death():
        result["stop_reason"] = "death"
        result["died"] = True
        p["hp"] = d_effective_stats(p)["max_hp"]
        p["floor"] = 1
        p["x"], p["y"] = d_instance_start(uid, 1)
        d_reset_floor_counters(p)
        result["messages"].append("力尽きた… スタート地点へ戻された")

    for nx, ny in plan["path"]:
        p["x"], p["y"] = nx, ny
        result["steps"] += 1
        result["path"].append((nx, ny))
        p["turns"] += 1
        p["season_score"] += 1
        # 状態異常は移動ターンでも1回進める（Phase 0 のライフサイクル）。
        status_logs = d_tick_status(uid)
        if status_logs:
            result["messages"].extend(status_logs)
        if p["hp"] <= 0:
            _apply_death()
            break
        for quest_key in d_progress_quest(uid, "turns", 1):
            await d_apply_reward(uid, db_api, **QUEST_MASTER[quest_key]["reward"])
        d_unlock_achievement(uid, "first_step")
        if floor >= 10: d_unlock_achievement(uid, "floor_10")
        if floor >= 20: d_unlock_achievement(uid, "floor_20")
        if floor >= 40: d_unlock_achievement(uid, "floor_40")

        # Phase 1-D: フォグの公開と部屋の初入室発動（設計 §5 / §6-1）。
        room = d_room_at(inst, nx, ny)
        traversed = inst.setdefault("traversed", set())
        first_step_on_cell = (nx, ny) not in traversed
        traversed.add((nx, ny))
        first_corridor_step = False
        if room is None:
            first_corridor_step = first_step_on_cell
            d_mark_corridor_visited(inst, nx, ny)
        elif room is not prev_room:
            d_reveal_room(inst, room)
            enemy = await d_activate_room_entry(uid, db_api, room, result)
            if enemy is not None:
                result["enemy"] = enemy
                result["view"] = "combat"
                result["room_id"] = room["id"]
                prev_room = room
                break
            if result["view"] in ("shop", "mine"):
                prev_room = room
                break
        prev_room = room

        ct = d_get_cell(uid, floor, nx, ny)
        if ct == D_STAIRS:
            if d_stairs_room_blocked(uid, floor, nx, ny):
                # 未制圧の階段部屋では階段を使えず、番人戦になる（設計 §5）。
                guard_room = d_room_at(inst, nx, ny)
                result["enemy"] = d_make_enemy(
                    floor, forced_rank="boss" if guard_room and guard_room.get("boss") else "elite")
                result["stop_reason"] = "guard"
                result["view"] = "combat"
                result["room_id"] = guard_room["id"] if guard_room else None
                break
            result["stop_reason"] = "special"
            result["view"] = "stairs"
            break
        if ct == D_SHOP:
            result["stop_reason"] = "special"
            result["view"] = "shop"
            break
        if ct == D_MINE:
            result["stop_reason"] = "special"
            result["view"] = "mine"
            break
        if ct in (D_CHEST, D_TRAP, D_REST, D_SHRINE, D_EVENT):
            if ct == D_CHEST:
                text, reward = d_open_chest(uid, db_api)
                await d_apply_reward(uid, db_api, **reward)
            elif ct == D_TRAP:
                text, penalty = d_trigger_trap(uid)
                await d_apply_reward(uid, db_api, **penalty)
            elif ct == D_REST:
                before = p["hp"]
                stats = d_effective_stats(p)
                p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
                d_clear_status(uid)
                text = f"休憩した。HPが {p['hp'] - before} 回復し、状態異常が治った。"
            elif ct == D_SHRINE:
                p["atk"] += 2
                text = "祭壇の祝福！ 基礎ATKが2上昇した。"
            else:  # D_EVENT
                gain = random.randint(20, 80)
                await d_apply_reward(uid, db_api, coins=gain, xp=gain, season_score=25)
                text = f"旅人の依頼を達成した。コイン+{gain}、XP+{gain}"
            d_consume(uid, floor, nx, ny)
            result["messages"].append(text)
            result["stop_reason"] = "special"
            if p["hp"] <= 0:
                _apply_death()
            break

        # 通路アンブッシュ（Phase 1-D / 確定事項 D4）: 部屋の外のマスを
        # そのインスタンスで初めて踏んだときだけ 12% で通常戦闘が起きる。
        # 歩行時のバイオーム率エンカウントは廃止した。
        if room is None and first_corridor_step and random.random() < D_AMBUSH_RATE:
            result["enemy"] = d_make_enemy(floor, forced_rank="normal")
            result["stop_reason"] = "ambush"
            result["view"] = "combat"
            break
        # 停止条件7: HPが30%未満まで低下したら、それ以上は進まない。
        stats = d_effective_stats(p)
        if p["hp"] < hp_before and p["hp"] < stats["max_hp"] * 0.30:
            result["stop_reason"] = "low_hp"
            break

    result["end"] = (p["x"], p["y"])
    label = _DIRECTION_LABELS.get(result["direction"], "")
    head = f"{label}へ{result['steps']}歩進んだ。"
    head += D_WALK_STOP_TEXTS.get(result["stop_reason"], "")
    result["messages"].insert(0, head)
    d_record_action(
        uid, "journey", source=source,
        result=f"{start}->{result['end']} {result['steps']}歩 {result['stop_reason']}",
        hp_before=hp_before,
    )
    await dg_save_player(uid, db_api)
    return result


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
_CLEF_PLAYER = None


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


def d_dungeon_view(uid, db_api=None, plan=None):
    """保存済み状態から統合パネルを作り直す。全画面の「戻る」はここへ揃える。"""
    p = d_get_player(uid)
    return DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], db_api, plan=plan)


async def d_return_to_dungeon(interaction, uid, db_api, msg=""):
    """現在状態の統合パネルへ戻る。全画面共通の復帰処理。"""
    p = d_get_player(uid)
    view = d_dungeon_view(uid, db_api)
    map_file, map_url = d_map_attachment(uid, p["floor"], p["x"], p["y"])
    await interaction.edit_original_response(
        embed=view._embed(msg, image_url=map_url), view=view, attachments=[map_file]
    )


def clef_plan_for(uid):
    """現在のClef作戦。実行中は実行中のもの、停止中は最後に選んだものを返す。"""
    if _CLEF_PLAYER is None:
        return CLEF_PLANS["safe"]
    return _CLEF_PLAYER.plan_for(uid)


def clef_status_text(uid):
    """ステータス画面に表示するClefの実行状況。"""
    if _CLEF_PLAYER is None:
        return "未初期化"
    return _CLEF_PLAYER.status_text(uid)


class DungeonStatusView(DungeonViewBase):
    """ステータス表示。自動操作の接続と作戦選択はこの画面へ集約する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=300)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api
        self.clef_plan = clef_plan_for(uid)

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
        em.add_field(name="自動操作", value=f"作戦: **{self.clef_plan}**\n状態: {clef_status_text(self.uid)}", inline=False)
        # Phase 1-E の踏破計測: 直近に踏破したフロアの実績を小さく添える。
        history = p.get("floor_history") or []
        if history:
            last = history[-1]
            em.add_field(
                name="前フロアの実績",
                value=f"{last.get('floor', '?')}F: {last.get('turns_used', 0)}ターン / {last.get('journeys_used', 0)}回移動",
                inline=False,
            )
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    @discord.ui.button(label="自動操作開始", style=discord.ButtonStyle.blurple, row=0)
    async def start_autoplay(self, interaction, button):
        if _CLEF_PLAYER is None:
            await interaction.response.send_message("自動操作機能が初期化されていません。", ephemeral=True)
            return
        # 押した時点の現在状態と作戦で自動操作を開始する（状態はダンジョンと共有）。
        await _CLEF_PLAYER.start(interaction, self.clef_plan)

    @discord.ui.button(label="操作メニュー", style=discord.ButtonStyle.green, row=0)
    async def operations(self, interaction, button):
        await interaction.response.defer()
        p = self.sync_state()
        op = DungeonOperationView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=op._embed("操作メニュー", image_url=map_url), view=op, attachments=[map_file]
        )

    @discord.ui.button(label="ダンジョンへ戻る", style=discord.ButtonStyle.grey, row=0)
    async def back(self, interaction, button):
        await interaction.response.defer()
        await d_return_to_dungeon(interaction, self.uid, self.db_api, "")

    @discord.ui.select(
        placeholder="Clef作戦を選択",
        options=[discord.SelectOption(label=name, value=key) for key, name in CLEF_PLANS.items()],
        row=1,
    )
    async def select_plan(self, interaction, select):
        await interaction.response.defer()
        self.clef_plan = CLEF_PLANS.get(select.values[0], CLEF_PLANS["safe"])
        if _CLEF_PLAYER is not None:
            # 実行中の場合は走行中の作戦も即時更新する。
            _CLEF_PLAYER.set_plan(self.uid, self.clef_plan)
        await self._render(interaction, f"Clef作戦を **{self.clef_plan}** に設定しました。")


class DungeonStairsView(DungeonViewBase):
    """階段View"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=180)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api

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
        if d_stairs_room_blocked(self.uid, floor, p["x"], p["y"]):
            # Phase 1-D: 番人を倒すまでは階段を使えない（防御的な再確認）。
            await self._render(i, "階段は番人に守られている。番人を倒さないと使えない。")
            return
        if floor < D_FLOORS:
            d_record_floor_clear(self.uid)
            p["floor"] = floor + 1
            p["hp"] = d_effective_stats(p)["max_hp"]
            d_clear_status(self.uid)
            p["x"], p["y"] = d_instance_start(self.uid, p["floor"])
            d_reset_floor_counters(p)
            d_progress_quest(self.uid, "floor", 1)
            await dg_save_player(self.uid, self.db_api)
            await d_return_to_dungeon(i, self.uid, self.db_api, f"フロア {p['floor']}へ到達！")
        else:
            await i.edit_original_response(embed=discord.Embed(title="ゴール！", description="ダンジョンをクリアしました！", color=0xFFFFFF))

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonMineView(DungeonViewBase):
    """採掘View"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=60)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api

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
        await d_apply_reward(self.uid, self.db_api, coins=gain)
        d_consume(self.uid, self.floor, self.x, self.y)
        await dg_save_player(self.uid, self.db_api)
        await dg_save_player(self.uid, self.db_api)
        await d_return_to_dungeon(i, self.uid, self.db_api, f"採掘！ **+{gain}** コイン")

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonShopView(DungeonViewBase):
    """軽量な商店View。購入はサーバー側で価格を検証する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.db_api = floor, x, y, db_api

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
            await d_apply_reward(self.uid, self.db_api, coins=-price, **reward)
            msg = f"{label}を購入しました。"
        except Exception:
            msg = "コインが足りないか、購入に失敗しました。"
        await dg_save_player(self.uid, self.db_api)
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
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonCombatView(DungeonViewBase):
    """戦闘View"""

    def __init__(self, uid, floor, x, y, enemy, db_api, room_id=None):
        super().__init__(uid, timeout=180)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.enemy = enemy
        self.log = []
        self.defending = False
        self.db_api = db_api
        # Phase 1-D: 部屋発動の戦闘の場合、勝利時にその部屋を制圧済みに
        # する（combat 部屋の再発動防止、階段部屋のガード解除）。
        self.room_id = room_id

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
            await d_apply_reward(self.uid, self.db_api, **QUEST_MASTER[quest_key]["reward"])

    async def _win(self, i):
        e = self.enemy
        p = d_get_player(self.uid)
        if self.room_id is not None:
            # 部屋発動の戦闘に勝利したので部屋を制圧済みにする（Phase 1-D）。
            # 逃走・敗北では呼ばれないため、未制圧のまま再挑戦できる。
            d_mark_room_cleared(d_get_instance(self.uid, self.floor), self.room_id)
        if isinstance(i, _NoopInteraction):
            # 自動操作中は選択UIを挟まず、その場で戦利品を反映する。
            p["pending_rewards"] = []
            await self._register_kill()
            await d_apply_reward(
                self.uid, self.db_api,
                coins=e["reward_coins"], xp=e["reward_xp"], boxes=e["reward_box"],
                season_score=500 if e.get("type") == "boss" else 25,
            )
            msg = f"勝利！ +{e['reward_coins']}コイン +{e['reward_xp']}XP"
            if e["reward_box"] > 0:
                msg += f" +宝箱{e['reward_box']}個"
            self.log.append(msg)
            await dg_save_player(self.uid, self.db_api)
            return

        choices = d_make_reward_choices(self.uid, e)
        await self._register_kill()
        p["pending_rewards"] = [c["reward"] for c in choices]
        self.log.append("勝利！報酬を3候補から1つ選択してください")
        await dg_save_player(self.uid, self.db_api)
        self.stop()
        view = DungeonRewardChoiceView(self.uid, self.floor, self.x, self.y, self.db_api, choices)
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await i.edit_original_response(embed=self._embed(image_url=map_url), view=view, attachments=[map_file])

    async def _lose(self, i):
        p = d_get_player(self.uid)
        p["hp"] = d_effective_stats(p)["max_hp"]
        p["floor"] = 1
        p["x"], p["y"] = d_instance_start(self.uid, 1)
        d_reset_floor_counters(p)
        self.log.append("敗北… スタート地点へ送還された")
        await dg_save_player(self.uid, self.db_api)
        self.stop()
        if isinstance(i, _NoopInteraction):
            return
        await d_return_to_dungeon(i, self.uid, self.db_api, "敗北して戻された…")

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
            await d_return_to_dungeon(i, self.uid, self.db_api, "逃走成功")
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
        await dg_save_player(self.uid, self.db_api)
        await self._render(i)


class DungeonMainView(DungeonViewBase):
    """ダンジョンメインView（統合パネルの基底）"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=600)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api
        # 進めない方向のボタンは最初から無効化する（「壁！」の空振り防止）。
        for child in self.children:
            key = {"dg_u": "up", "dg_d": "down", "dg_l": "left", "dg_r": "right"}.get(
                getattr(child, "custom_id", None))
            if key is not None:
                child.disabled = d_direction_blocked(uid, floor, x, y, key)

    def _fresh_main_view(self, p):
        """移動後の再描画用に作り直したメインView（ボタン無効状態を最新化する）。"""
        return self

    async def act_here_action(self, interaction):
        """中央ボタン「部屋で行動」: 現在マスのタイルを再発動する。"""
        await interaction.response.defer()
        msg = await d_current_cell_action(self.uid, self.db_api)
        p = self.sync_state()
        await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))

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
        em.add_field(name="フロア進捗", value=d_floor_progress_text(self.uid), inline=False)
        em.add_field(name="凡例", value="🟩自分 🟨宝箱 🟥階段 🟪店 ⛏採掘 ✦祠・イベント R休憩 ⬛未探索（暗い場所は探索済み）", inline=False)
        em.add_field(name="進行中の目的", value="\n".join(quests) if quests else "全クエスト達成", inline=False)
        em.add_field(name="自動操作", value=f"作戦: {getattr(self, 'clef_plan', clef_plan_for(self.uid))} / 状態: {clef_status_text(self.uid)}", inline=False)
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

    async def _move(self, i, direction):
        lock = d_get_lock(self.uid)
        if lock.locked():
            await i.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        await lock.acquire()
        try:
            await self._move_locked(i, direction)
        finally:
            lock.release()

    async def _move_locked(self, i, direction):
        await i.response.defer()

        # ビュー生成時のスナップショットではなく、常に保存済みの現在状態を使う。
        p = self.sync_state()
        floor = p["floor"]

        # 進めない方向は通常ボタン側で無効化しているが、古いパネル等からの
        # 押下に備えてサーバー側でも弾く（描画は従来どおり1回だけ行う）。
        if direction not in _DIRECTIONS or d_direction_blocked(
                self.uid, floor, p["x"], p["y"], direction):
            await self._redraw(i, "壁！進めない", p)
            return

        # 1押下 = 1 journey。歩行・タイル処理・保存は d_execute_journey 側で
        # 行い、ここでは結果に応じた View 遷移と最終描画だけを行う。
        result = await d_execute_journey(self.uid, self.db_api, direction, source="manual")
        p = self.sync_state()
        msg = "\n".join(result["messages"])
        await self._render_journey_result(i, result, msg, p)

    async def _render_journey_result(self, interaction, result, msg, p):
        """journey 結果に応じた View 遷移と最終描画（手動移動と「階段へ」で共用）。"""
        if result["view"] == "stairs":
            sv = DungeonStairsView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "階段がある。どうする？", p, view=sv)
            return
        if result["view"] == "shop":
            shop = DungeonShopView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "商店を発見！", p, view=shop)
            return
        if result["view"] == "mine":
            mv = DungeonMineView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "鉱山を発見！", p, view=mv)
            return
        if result["view"] == "combat":
            cv = DungeonCombatView(self.uid, p["floor"], p["x"], p["y"], result["enemy"], self.db_api,
                                   room_id=result.get("room_id"))
            await self._redraw(interaction, msg, p, view=cv)
            return
        await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))

    @discord.ui.button(label="北", style=discord.ButtonStyle.grey, row=0, custom_id="dg_u")
    async def up(self, i, b): await self._move(i, "up")

    @discord.ui.button(label="西", style=discord.ButtonStyle.grey, row=1, custom_id="dg_l")
    async def left(self, i, b): await self._move(i, "left")

    @discord.ui.button(label="部屋で行動", style=discord.ButtonStyle.green, row=1, custom_id="dg_c")
    async def act_here(self, i, b): await self.act_here_action(i)

    @discord.ui.button(label="東", style=discord.ButtonStyle.grey, row=1, custom_id="dg_r")
    async def right(self, i, b): await self._move(i, "right")

    @discord.ui.button(label="南", style=discord.ButtonStyle.grey, row=2, custom_id="dg_d")
    async def down(self, i, b): await self._move(i, "down")

    @discord.ui.button(label="STATUS", style=discord.ButtonStyle.green, row=3, custom_id="dg_status")
    async def status(self, i, b):
        await i.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        await sv._render(i, "")
class DungeonUnifiedView(DungeonMainView):
    """ゲームハブから起動したダンジョン一つで操作を完結させる圧縮UI。

    Clef自動操作の開始ボタンと作戦選択はSTATUS画面へ集約し、このパネルには移動と終了だけを残す。
    """

    def __init__(self, uid, floor, x, y, db_api, plan=None):
        super().__init__(uid, floor, x, y, db_api)
        self.clef_plan = plan or clef_plan_for(uid)
        self.clear_items()
        # Phase 1-C: 4方向＋中央「部屋で行動」。進めない方向は disabled。
        # Phase 1-D: ラベルに行き先情報（発見済み=役割名 / 未発見=未探索 / 通路）。
        directions = [
            ("北", "up", 0), ("西", "left", 1), ("東", "right", 1), ("南", "down", 2),
        ]
        for label, key, row in directions:
            blocked = d_direction_blocked(uid, floor, x, y, key)
            dest = None if blocked else d_destination_label(uid, floor, x, y, key)
            button = discord.ui.Button(
                label=f"{label}: {dest}" if dest else label,
                style=discord.ButtonStyle.grey, row=row,
                disabled=blocked,
            )
            async def move_callback(interaction, key=key):
                await self._move(interaction, key)
            button.callback = move_callback
            self.add_item(button)

        center = discord.ui.Button(label="部屋で行動", style=discord.ButtonStyle.green, row=1)
        center.callback = self.act_here_action
        self.add_item(center)

        status_button = discord.ui.Button(label="STATUS", style=discord.ButtonStyle.green, row=3)
        status_button.callback = self.open_status
        self.add_item(status_button)
        # Phase 1-E「階段へ」: 階段の間が発見済みのときだけ有効（設計 §4-1）。
        stairs_button = discord.ui.Button(
            label="階段へ", style=discord.ButtonStyle.primary, row=3,
            disabled=not d_stairs_discovered(uid, floor),
        )
        stairs_button.callback = self.go_stairs
        self.add_item(stairs_button)
        stop = discord.ui.Button(label="終了", style=discord.ButtonStyle.red, row=3)
        stop.callback = self.end_session
        self.add_item(stop)

    async def go_stairs(self, interaction):
        """「階段へ」: 発見済みの階段の間まで最短路を journey で辿る（Phase 1-E）。

        計画（次に進む方向）は d_plan_navigation_direction で停止のたびに
        再計算し、実行は通常移動と同じ d_execute_journey を上限10回
        繰り返す。戦闘開始・View遷移（商店/鉱山/階段）・HP低下停止・
        死亡などの割り込みがあれば即座に止め、最後の journey の結果を
        通常移動と同様に描画する。
        """
        lock = d_get_lock(self.uid)
        if lock.locked():
            await interaction.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        await lock.acquire()
        try:
            await interaction.response.defer()
            p = self.sync_state()
            floor = p["floor"]
            inst = d_get_instance(self.uid, floor)
            stairs_room = next((r for r in inst.get("rooms", []) if r["role"] == "stairs"), None)
            if stairs_room is None or not d_room_discovered(inst, stairs_room):
                await self._redraw(interaction, "階段の間はまだ見つかっていない。", p,
                                    view=self._fresh_main_view(p))
                return
            target = stairs_room["center"]
            messages = []
            result = None
            for _ in range(10):
                p = self.sync_state()
                if (p["x"], p["y"]) == tuple(target):
                    break
                direction = d_plan_navigation_direction(self.uid, floor, p["x"], p["y"], target)
                if direction is None:
                    break
                result = await d_execute_journey(self.uid, self.db_api, direction, source="manual")
                messages.extend(result["messages"])
                if (result["view"] is not None or result["enemy"] is not None
                        or result["died"] or result["steps"] == 0
                        or result["stop_reason"] == "low_hp"):
                    break
            p = self.sync_state()
            msg = "\n".join(messages) or "階段へ移動した。"
            if result is None:
                await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))
                return
            await self._render_journey_result(interaction, result, msg, p)
        finally:
            lock.release()

    def _fresh_main_view(self, p):
        return DungeonUnifiedView(self.uid, p["floor"], p["x"], p["y"], self.db_api, plan=self.clef_plan)

    async def open_status(self, interaction):
        """ステータス画面（自動操作開始・作戦選択を含む）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        sv.clef_plan = self.clef_plan
        await sv._render(interaction, "")

    async def end_session(self, interaction):
        """自動操作を止め、操作を終了する。"""
        if _CLEF_PLAYER is not None:
            await _CLEF_PLAYER.stop(self.uid)
        self.stop()
        await interaction.response.defer()
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        embed = self._embed("ダンジョンを終了しました。再開する場合は `/game` からダンジョンを選んでください。", image_url=map_url)
        await interaction.edit_original_response(embed=embed, view=None, attachments=[map_file])


class DungeonOperationView(DungeonViewBase):
    """ステータス・アイテム・拠点・現在地操作を1画面に集約する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=600)
        self.floor, self.x, self.y, self.db_api = floor, x, y, db_api
        self._add("STATUS", self.status, 0, discord.ButtonStyle.green)
        self._add("パン", self.use_bread, 0, discord.ButtonStyle.blurple)
        self._add("現在地を操作", self.current_action, 1, discord.ButtonStyle.primary)
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
        await d_return_to_dungeon(interaction, self.uid, self.db_api, msg)

    async def status(self, interaction):
        """ステータス画面（自動操作開始・作戦選択）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        status = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
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
        await dg_save_player(self.uid, self.db_api)
        await self._back(interaction, f"レアパンを使用し、HPが {p['hp'] - before} 回復しました。")

    async def camp(self, interaction):
        """拠点は共有マップ前提の機能だったため Phase 1-B で無効化（既存データは保持する）。"""
        await interaction.response.defer()
        await self._back(interaction, "拠点機能は現在利用できません。")

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
        await dg_save_player(self.uid, self.db_api)
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
        await dg_save_player(self.uid, self.db_api)
        await self._back(interaction, f"職業を **{JOB_MASTER[selected]['name']}** に設定しました。")

    async def current_action(self, interaction):
        await interaction.response.defer()
        # 実処理は d_current_cell_action に集約（メインパネルの中央ボタンと共用）。
        msg = await d_current_cell_action(self.uid, self.db_api)
        await self._back(interaction, msg)

    async def back(self, interaction):
        await interaction.response.defer()
        await self._back(interaction)


class DungeonRewardChoiceView(DungeonViewBase):
    """戦闘勝利時に3候補から1つだけ受け取るView。"""

    def __init__(self, uid, floor, x, y, db_api, choices):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.db_api, self.choices = floor, x, y, db_api, choices
        for index, item in enumerate(choices):
            button = discord.ui.Button(label=item["label"], style=discord.ButtonStyle.green, row=0)

            async def choose(interaction, index=index, label=item["label"]):
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
                await d_apply_reward(self.uid, self.db_api, **reward)
                await dg_save_player(self.uid, self.db_api)
                self.stop()
                await d_return_to_dungeon(interaction, self.uid, self.db_api, f"報酬を選択: {label}")

            button.callback = choose
            self.add_item(button)


class ClefDungeonPlayer:
    """Logfare Clef によるダンジョン代理プレイ。

    Clefへ渡すのは「現在の状態」「今回の選択肢と判断基準」「直近のログ」だけに絞る。
    ゲーム状態の確定・ダメージ・報酬・保存はすべて本体側が担当し、
    モデルは次の1手を選ぶことだけに責務を限定する。
    """

    def __init__(self, bot):
        self.bot = bot
        self._tasks = {}
        self._stops = {}
        self._plans = {}
        self._run_stats = {}
    # ---------- Clefへの入力生成 ----------

    def _state_text(self, uid, plan, logs):
        """Clefへ渡す唯一のテキスト。ゴールと現在状態を先頭に、ログは短く末尾へ置く。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        floor, x, y = p["floor"], p["x"], p["y"]
        bname, *_ = d_get_biome(floor)
        dist = dungeon_bfs(uid, floor, x, y)
        hp_pct = int(p["hp"] / max(1, stats["max_hp"]) * 100)
        header = [
            "# 現在の状態",
            f"作戦: {plan}",
            f"階層: {floor}F({bname}) / 位置: ({x},{y}) / フロア特性: {d_floor_modifier(floor)}",
            f"HP: {p['hp']}/{stats['max_hp']} ({hp_pct}%) / ATK {stats['atk']} DEF {stats['def_']} / 職業: {d_job_name(uid)}",
            f"目的: {dungeon_goal_text(uid)}",
            f"階段: {dungeon_stairs_hint(uid, floor, x, y, dist)}",
            # Phase 1-E: 旧「周囲3×3」は部屋グラフ要約へ置き換えた（設計 §8）。
            d_room_summary_text(uid, floor, x, y),
        ]
        last = self._run_stats.get(uid, {}).get("last_result")
        if last:
            header.append(f"前回の結果: {last}")
        header.append("直近のログ:")
        head_text = "\n".join(header)
        lines = []
        for line in [entry for entry in logs if entry and not str(entry).startswith("候補評価:")][-CLEF_LOG_LINES:]:
            lines.append("- " + " ".join(str(line).split())[:160])
        log_text = "\n".join(lines)
        remaining = CLEF_STATE_CHARS - len(head_text) - 1
        if remaining <= 0:
            return head_text[:CLEF_STATE_CHARS]
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
        """Clefに状態と選択肢を送り、選択肢キーだけを返す。"""
        state_text = self._state_text(uid, plan, logs)
        timeout = aiohttp.ClientTimeout(total=CLEF_TIMEOUT)
        last_error = None
        for attempt in range(1, CLEF_RETRIES + 1):
            try:
                data = await asyncio.wait_for(
                    logfare.decision("clef", state_text, questions, timeout=timeout),
                    timeout=CLEF_TIMEOUT,
                )
                if isinstance(data.get("result"), dict):
                    data = data["result"]
                answers = data.get("answers", {})
                key = next(iter(questions), "")
                answer = answers.get(key, {}) if isinstance(answers, dict) else {}
                if isinstance(answer, str):
                    return answer
                if isinstance(answer, dict):
                    choice = answer.get("choice") or answer.get("answer") or answer.get("value")
                    if choice is not None:
                        return str(choice)
                choice = data.get("choice") if isinstance(data, dict) else None
                if choice is not None:
                    return str(choice)
                raise ValueError("Clef response did not contain an answer choice")
            except asyncio.CancelledError:
                raise
            except (logfare.LogfareHTTPError, aiohttp.ClientError, asyncio.TimeoutError, OSError, RuntimeError, ValueError) as exc:
                last_error = exc
                status = getattr(exc, "status", None)
                logs.append(f"Clef APIエラー{f' (HTTP {status})' if status else ''}。")
                retryable = status is None or status in (408, 429, 500, 502, 503, 504)
                if not retryable or attempt >= CLEF_RETRIES:
                    break
                await asyncio.sleep(CLEF_RETRY_DELAY * attempt)
            except Exception as exc:
                last_error = exc
                logs.append(f"Clef判断エラー: {type(exc).__name__}")
                break
        if last_error:
            logger.warning("Dungeon Clef decision failed: %s", type(last_error).__name__)
        return ""
    # ---------- 実行制御 ----------

    def is_running(self, uid):
        task = self._tasks.get(str(uid))
        return bool(task and not task.done())

    def plan_for(self, uid):
        return self._plans.get(str(uid), CLEF_PLANS["safe"])

    def set_plan(self, uid, plan):
        self._plans[str(uid)] = plan

    def status_text(self, uid):
        uid = str(uid)
        if self.is_running(uid):
            run = self._run_stats.get(uid, {})
            return f"実行中（{run.get('turns', 0)}journey / 作戦: {self.plan_for(uid)}）"
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
        # 押した時点の保存済み状態から、表示もClefの判断も同一のフレームで始める。
        p = d_get_player(uid)
        view = DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], self.bot.db_api, plan=plan)
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
        embed.add_field(name="作戦", value=f"{view.clef_plan} / 停止: 終了ボタン", inline=False)
        embed.add_field(
            name="停止条件",
            value=f"HP30%未満 / ボス / 遺物 / {CLEF_MAX_TURNS}journey / APIエラー3回 / 同一地点3回",
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
        """Clefの安全停止条件をゲーム側で一元判定する。1ターンにつき1回だけ呼ぶ。"""
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
        # 状態異常（毒・出血など）があるだけでは停止しない。軽微/一時的な
        # 異常で自動操作全体が終わってしまうため、停止条件から外した。
        # 異常ダメージで HP が 30% 未満まで落ちれば上の HP 条件で止まる。
        if any("ボス" in line for line in logs[-8:]):
            return "ボス遭遇"
        if any("遺物" in line for line in logs[-8:]):
            return "希少アイテム発見"
        if run.get("turns", 0) >= CLEF_MAX_TURNS:
            # Phase 1-E: 上限の単位はターン数ではなく journey 数。
            return f"1回の自動操作が{CLEF_MAX_TURNS}journeyに到達"
        if len(positions) >= 3 and positions[-1] == positions[-2] == positions[-3]:
            return "同じ場所で3回連続停止"
        if sum("Clef APIエラー" in line or "Clef接続エラー" in line for line in logs[-6:]) >= 3:
            return "Clef APIエラーが連続3回"
        if sum("と遭遇しました" in line for line in logs[-8:]) >= 3:
            return "連続戦闘が多いため"
        return ""

    async def _run_loop(self, uid, message, view, stop_event, plan):
        logs = [f"自動操作を開始しました。作戦: {plan} / 終了ボタンで停止できます。"]
        d_begin_run(uid, "clef")
        self._run_stats[uid] = {"turns": 0, "positions": [], "last_result": ""}
        # 初回判断の前に、ゲームハブのダンジョンと同じ現在状態のフレームを表示する。
        await self._edit_screen(message, view, logs)
        try:
            while not stop_event.is_set():
                reason = self._stop_reason(uid, logs)
                if reason:
                    logs.append(f"停止しました: {reason}")
                    break
                await self._play_turn(uid, logs, plan)
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
            d_end_run(uid, "clef_stop")
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
        cell = d_get_cell(uid, floor, x, y)
        logs.append(dungeon_candidate_log(uid, plan))
        d_record_action(uid, "decision", source="clef", result=plan)

        if cell == D_STAIRS and not d_stairs_room_blocked(uid, floor, x, y):
            raw = await self._decide(uid, logs, plan, {
                "stairs": {
                    "type": "choice",
                    "instructions": (
                        "階段の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
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
                d_record_floor_clear(uid)
                p["floor"] = floor + 1
                p["hp"] = d_effective_stats(p)["max_hp"]
                d_clear_status(uid)
                p["x"], p["y"] = d_instance_start(uid, p["floor"])
                d_reset_floor_counters(p)
                d_progress_quest(uid, "floor", 1)
                logs.append(f"階段を上り、{p['floor']}Fへ進みました。")
            else:
                logs.append("階段では探索を続けました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_MINE:
            raw = await self._decide(uid, logs, plan, {
                "mine": {
                    "type": "choice",
                    "instructions": (
                        "鉱山の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
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
                await d_apply_reward(uid, self.bot.db_api, coins=gain, season_score=10)
                d_consume(uid, floor, x, y)
                logs.append(f"鉱山を採掘し、コインを{gain}枚獲得しました。")
                await dg_save_player(uid, self.bot.db_api)
            else:
                logs.append("鉱山を見送りました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_REST:
            before = p["hp"]
            p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
            d_clear_status(uid)
            d_consume(uid, floor, x, y)
            logs.append(f"休憩所でHPを{p['hp'] - before}回復しました。")
            await dg_save_player(uid, self.bot.db_api)
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_SHOP:
            raw = await self._decide(uid, logs, plan, {
                "shop": {
                    "type": "choice",
                    "instructions": (
                        "商店の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
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
                    await d_apply_reward(uid, self.bot.db_api, coins=-30, bread=1)
                    logs.append("商店でレアパンを購入しました。")
                except Exception:
                    logs.append("コイン不足で購入できませんでした。")
            else:
                logs.append("商店で購入せずに進みました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        # 通常移動。待機手は用意せず、必ず1方向を選ばせる。
        # Phase 1-C 以降、1回の判断は1マスではなく1 journey（分岐・部屋・
        # 特殊タイル等で止まるまで自動で進む）を実行する。
        dist = dungeon_bfs(uid, floor, x, y)
        move_criteria = dungeon_move_criteria(uid, floor, x, y, dist)
        criteria_text = "\n".join(f"{key}: {value}" for key, value in move_criteria.items())
        instructions = (
            "あなたはダンジョン探索の意思決定者です。画像ではなく、以下のテキスト盤面を正として次に進む方向を1つ選んでください。\n"
            "選んだ方向へは、分岐・部屋・特殊タイル・エンカウントのいずれかに当たるまで自動で進みます。\n"
            f"目的: {dungeon_goal_text(uid)}\n"
            f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
            f"現在地: {floor}F ({x},{y}) / 階段: {dungeon_stairs_hint(uid, floor, x, y, dist)}\n"
            f"{d_room_summary_text(uid, floor, x, y)}\n"
            f"方向ごとの判定基準:\n{criteria_text}\n"
            "制約: 壁へは進めません。階段へ近づく方向を優先します。HPが30%未満なら回復タイルや階段へ向かってください。\n"
            "回答は次のいずれか1語のみ: " + ", ".join(CLEF_MOVE_KEYS)
        )
        raw = await self._decide(uid, logs, plan, {
            "move": {
                "type": "choice",
                "instructions": instructions,
                "criteria": move_criteria,
            }
        })
        choice = d_normalize_choice(raw, set(CLEF_MOVE_KEYS), None)
        if choice is None:
            choice = dungeon_best_direction(uid, plan, dist)
            logs.append(f"Clefの応答を解釈できなかったため、作戦に沿って{_DIRECTION_LABELS[choice]}へ進みます。")
        if d_direction_blocked(uid, floor, x, y, choice):
            blocked_choice = choice
            choice = dungeon_best_direction(uid, plan, dist)
            if d_direction_blocked(uid, floor, x, y, choice):
                logs.append("周囲に合法な移動先がないため、このターンは移動しません。")
                return
            logs.append(f"{_DIRECTION_LABELS[blocked_choice]}({blocked_choice})は壁でした。サーバー判定で{_DIRECTION_LABELS[choice]}({choice})へ補正します。")
            self._note_result(uid, f"{blocked_choice}は壁のため{choice}へ補正")
        result = await d_execute_journey(uid, self.bot.db_api, choice, source="clef")
        logs.extend(result["messages"])
        p = d_get_player(uid)
        logs.append(f"現在地: {p['floor']}F ({p['x']},{p['y']}) / {d_floor_modifier(p['floor'])}")
        self._note_result(uid, f"{choice}へ{result['steps']}歩進んで ({p['x']},{p['y']}) に到着")
        if result["enemy"] is not None:
            # journey 途中でエンカウントした場合はその場で自動戦闘に入る。
            # （階段・商店・鉱山に着いた場合は次ターンの判断で扱う。）
            logs.append(f"{result['enemy']['name']}と遭遇しました。")
            await self._auto_combat(uid, result["enemy"], logs, room_id=result.get("room_id"))
            await dg_save_player(uid, self.bot.db_api)

    async def _auto_combat(self, uid, enemy, logs, room_id=None):
        """戦闘もClefに選ばせる。ダメージ計算と結果確定は本体側で行う。"""
        p = d_get_player(uid)
        combat = DungeonCombatView(uid, p["floor"], p["x"], p["y"], enemy, self.bot.db_api,
                                    room_id=room_id)
        while enemy["hp"] > 0 and d_get_player(uid)["hp"] > 0:
            raw = await self._decide(uid, logs, "戦闘", {
                "battle": {
                    "type": "choice",
                    "instructions": (
                        "戦闘中です。次の行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
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
        self.db_api = None
        # 自動操作は同一ファイル内で管理する（Clefによる自動操作）。
        self.clef = ClefDungeonPlayer(bot)

    async def cog_load(self):
        """Cog読み込み時"""
        global _CLEF_PLAYER
        _CLEF_PLAYER = self.clef
        # 親botから自前DB APIクライアントを取得
        if hasattr(self.bot, 'db_api'):
            self.db_api = self.bot.db_api
            await dg_load_all(self.db_api)

        # アセットを読み込み
        load_all_assets()

        # タスク開始
        if not self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.start()

    def cog_unload(self):
        """Cog アンロード時"""
        self.clef.shutdown()
        if self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.cancel()

    async def start_recruit(self, interaction: Interaction):
        """ゲームハブからダンジョンを開始する。"""
        await interaction.response.defer()
        uid = str(interaction.user.id)

        # プレイヤーデータ取得
        p = d_get_player(uid)
        floor, x, y = p["floor"], p["x"], p["y"]

        # そのプレイヤーのインスタンスを用意し、位置が不正（範囲外・壁）ならスタートへ戻す
        sx, sy = d_instance_start(uid, floor)
        if not (0 <= x < D2_MAP_W and 0 <= y < D2_MAP_H) or d_get_cell(uid, floor, x, y) == D_WALL:
            x, y = sx, sy
            p["x"] = x
            p["y"] = y
            if self.db_api:
                await dg_save_player(uid, self.db_api)

        # すべての通常操作・ステータス・自動操作開始/停止を1つの画面へ集約する。
        mv = DungeonUnifiedView(uid, floor, x, y, self.db_api)

        # 初期画像は専用チャンネルへ投げず、コマンド応答へ直接添付する。
        map_file, map_url = d_map_attachment(uid, floor, x, y)
        em = mv._embed("ダンジョンへようこそ！ Clef自動操作と作戦はSTATUS画面から設定できます。", image_url=map_url)
        await interaction.followup.send(embed=em, view=mv, file=map_file)

    @commands.command(name="dungeon_reset")
    async def dungeon_reset(self, ctx: commands.Context):
        """ダンジョンをリセット（Bot の持ち主専用）。Phase 1-B: 個人インスタンス基盤。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        dg_instances.clear()
        dg_players.clear()
        # 互換のため旧共有マップのキャッシュも掃除する（実データはもう使わない）。
        dg_maps.clear()
        dg_starts.clear()
        dg_used.clear()
        dg_bases.clear()

        # DBのプレイヤーデータも全消去する（マップはプレイヤー毎に生成されるため消去不要）。
        if self.db_api:
            try:
                self.db_api.table("dungeon_players").delete().neq("user_id", "").execute()
            except Exception as e:
                print(f"dungeon_reset DB削除失敗: {e}")

        em = discord.Embed(title="リセット完了", description="プレイヤーデータを消去しました。マップはプレイヤー毎に再生成されます。", color=0xFFFFFF)
        await ctx.send(embed=em)

    @tasks.loop(hours=1)
    async def dungeon_monthly_task(self):
        """月初にインスタンスとラン中状態だけを更新し、永続進行は保持する。"""
        now = datetime.datetime.now(JST)
        if now.day == 1 and now.hour == 0:
            dg_instances.clear()

            for uid, player in dg_players.items():
                player["season_id"] = SEASON_ID
                player["season_score"] = 0
                player["floor"] = 1
                player["instances"] = {}
                player["x"], player["y"] = d_instance_start(uid, 1)
                player["hp"] = d_effective_stats(player)["max_hp"]
                player["turns"] = 0
                d_reset_floor_counters(player)
                player["cooldowns"] = {}

            if self.db_api:
                for uid in list(dg_players):
                    await dg_save_player(uid, self.db_api)

            print("✓ ダンジョン月次リセット完了")

    @dungeon_monthly_task.before_loop
    async def before_dungeon_task(self):
        await self.bot.wait_until_ready()


# セットアップ関数
async def setup(bot):
    """Cogをロード"""
    await bot.add_cog(DungeonCog(bot))
    print("✓ DungeonCog loaded")
