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
from core.general.ai import logfare
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
from core.game.dungeon.common import D_FLOORS, D_ROOM_ROLE_NAMES, D_STAIRS, FLOOR_GOALS, JST, _DIRECTIONS, _DIRECTION_LABELS  # noqa: F401
from core.game.dungeon.player import d_content_summary, d_get_instance, d_get_player  # noqa: F401
from core.game.dungeon.world import d_direction_blocked, d_next_direction_toward, d_plan_walk, d_room_at, d_room_cleared, d_room_discovered, d_rooms_to_stairs, d_target_room, dungeon_bfs, dungeon_plan_key  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



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
