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
from core.general import logfare
import datetime
import logging
from discord.ui import View
from discord import app_commands, Interaction
from discord.ext import commands, tasks
from cogs.terminal import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw, ImageEnhance
from zoneinfo import ZoneInfo
from core.support.api_client import APIError
from core.support.api_retry import run_with_retry
from core.support.emojis import B_, G_, Y_

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
    (range(1,  10),  "洞窟",     "⬜", B_, "🌫️", 0x5C4033),
    (range(10,  20),  "森",       "🟫", G_, "🌫️", 0x2D5A1B),
    (range(20,  30),  "氷雪地帯", "⬜", "🔹", "🌫️", 0x5B9BD5),
    (range(30, 41),  "砂漠地帯", "🟧", Y_, "🌫️", 0xC8600A),
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
    # Phase 2-A: 現行3属性（火/氷/雷）の弱点をプレイヤーが実際に
    # 突けるよう、雷の弱点へ氷を追加した（マスタの削除はしない）。
    "thunder": {"name": "雷", "weak": ["water", "ice"], "resist": ["thunder"]},
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
# Phase 2-A: 属性・状態異常の整理。新規に生成・付与される経路で使うのは
# 各3種だけに絞る（ELEMENTS / STATUS_EFFECTS のマスタ自体は旧セーブ互換の
# ため残す。対象外の状態異常も tick・解除・表示は従来どおり処理される）。
D_ACTIVE_ELEMENTS = ("fire", "ice", "thunder")
D_ACTIVE_STATUSES = ("poison", "burn", "freeze")
# Phase 2-A: 敵アーキタイプと意図（次手予告）。意図は決定的なサイクルで
# 遷移し、DungeonCombatView._enemy_turn は表示した意図どおりに行動する。
D_INTENT_CYCLES = {
    "brute": ("attack", "charge", "heavy"),   # 溜めてから大ダメージを放つ型
    "venom": ("attack", "status", "attack"),  # 状態異常を撒く型
    "healer": ("attack", "attack", "heal"),   # 自己回復する型
    "normal": ("attack", "attack", "strong"),  # 通常型
    "passive": ("wait",),                      # 様子見だけの特殊個体用
}
D_ARCHETYPE_NAMES = {
    "brute": "溜め型", "venom": "状態異常型", "healer": "回復型",
    "normal": "通常型", "passive": "静観型",
}
D_INTENT_LABELS = {
    "attack": "通常攻撃", "strong": "強攻撃",
    "charge": "溜め（次に大ダメージ）", "heavy": "大ダメージ攻撃",
    "status": "状態異常攻撃", "heal": "回復", "wait": "様子見",
}
# 意図ごとのダメージ倍率（防御時は _calculate_damage 側の防御2倍で軽減）。
D_INTENT_DAMAGE_MUL = {"attack": 1.0, "strong": 1.4, "heavy": 1.8, "status": 0.7}
# 名前で固定するアーキタイプ（無い敵は ai / ランクから推定する）。
D_ENEMY_ARCHETYPES = {
    "毒キノコ": "venom", "サソリ": "venom", "砂蛇": "venom",
    "トレント": "healer", "毒沼蛙": "healer", "深淵騎士": "healer",
    "雷獣": "brute", "洞窟コウモリ王": "brute",
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
logger = logging.getLogger("cogs.dangeon")


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
