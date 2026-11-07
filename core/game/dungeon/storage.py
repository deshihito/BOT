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
from core.support.emojis import FAILED

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.common import SEASON_ID, _PLAYER_SAVE_DIGESTS, dg_bases, dg_players  # noqa: F401
from core.game.dungeon.world import d_instances_snapshot, d_migrate_player_v2  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



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
        print(f"{FAILED} ダンジョンプレイヤー読み込み失敗: {e}")

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
