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
from core.dungeon.clef import d_record_action  # noqa: F401
from core.dungeon.combat import d_make_enemy  # noqa: F401
from core.dungeon.common import D_AMBUSH_RATE, D_CHEST, D_EVENT, D_FLOORS, D_MINE, D_REST, D_SHOP, D_SHRINE, D_STAIRS, D_TRAP, D_WALK_STOP_TEXTS, JOB_MASTER, QUEST_MASTER, _DIRECTION_LABELS  # noqa: F401
from core.dungeon.player import d_apply_reward, d_apply_special_status, d_clear_status, d_do_mine, d_effective_stats, d_get_instance, d_get_lock, d_get_player, d_instance_start, d_open_chest, d_progress_quest, d_reveal_room, d_tick_status, d_trigger_trap, d_unlock_achievement  # noqa: F401
from core.dungeon.storage import dg_save_player  # noqa: F401
from core.dungeon.world import d_consume, d_get_cell, d_mark_corridor_visited, d_mark_room_cleared, d_plan_walk, d_record_floor_clear, d_reset_floor_counters, d_room_at, d_room_cleared, d_stairs_room_blocked  # noqa: F401

logger = logging.getLogger("cogs.dangeon")




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
        # Phase 2-A: 新規付与する状態異常は現行3種（毒/火傷/凍結）に絞る。
        d_apply_special_status(uid, "poison", 3)
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
