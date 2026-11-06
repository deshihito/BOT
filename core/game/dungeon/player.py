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

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.common import ACHIEVEMENTS, D2_MAP_H, D2_MAP_W, D_ENEMY_ARCHETYPES, D_FLOOR, D_INTENT_CYCLES, D_WALL, ENEMY_STATS_MASTER, EQUIPMENT_MASTER, JOB_MASTER, QUEST_MASTER, RELIC_MASTER, ROOM_MODIFIERS, SEASON_ID, STATUS_EFFECTS, _DIRECTIONS, _PLAYER_LOCKS, d_decode_visited, dg_instances, dg_players  # noqa: F401
from core.game.dungeon.floors import d_floor_seed, d_gen_floor_v2  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



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

def d_enemy_archetype(name, etype="normal", master=None):
    """敵のアーキタイプを決める純粋関数（Phase 2-A）。

    名前で固定のもの → ai に heal を含む回復型 → 様子見のみの静観型 →
    精鋭/ボスと強攻撃持ちは溜め型 → それ以外は通常型、の順で決める。
    """
    clean = str(name or "").split()[0].replace("👾", "").strip()
    if clean in D_ENEMY_ARCHETYPES:
        return D_ENEMY_ARCHETYPES[clean]
    if master is None:
        master = ENEMY_STATS_MASTER.get(clean, ENEMY_STATS_MASTER["default"])
    ai = master.get("ai", ["attack"])
    if ai and all(action == "wait" for action in ai):
        return "passive"
    if "heal" in ai:
        return "healer"
    if etype in ("elite", "boss") or "strong_attack" in ai:
        return "brute"
    return "normal"


def d_intent_at(archetype, turn_index):
    """アーキタイプのサイクル上で turn_index 番目の意図を返す純粋関数。"""
    cycle = D_INTENT_CYCLES.get(archetype, D_INTENT_CYCLES["normal"])
    return cycle[int(turn_index) % len(cycle)]


def d_ensure_intent(enemy):
    """敵 dict にアーキタイプと現在の意図（次に取る行動）を保証する。

    d_make_enemy 経由でない敵（旧データ・手作り）にも意図を持たせる。
    """
    if enemy.get("archetype") not in D_INTENT_CYCLES:
        enemy["archetype"] = d_enemy_archetype(
            enemy.get("name", ""), enemy.get("type", "normal"))
    if not isinstance(enemy.get("intent_turn"), int):
        enemy["intent_turn"] = 0
    enemy["intent"] = d_intent_at(enemy["archetype"], enemy["intent_turn"])
    return enemy


def d_instance_start(uid, floor):
    """そのプレイヤーの対象フロアのスタート座標を返す。"""
    return d_get_instance(uid, floor)["start"]


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
