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
from core.dungeon.common import CLEF_PLANS, D2_MAP_H, D2_MAP_W, D_BIOMES, D_FLOOR, D_ROOM_ROLE_NAMES, D_WALK_MAX_STEPS, D_WALK_SPECIAL_CELLS, D_WALL, JST, _DIRECTIONS, _DIRECTION_LABELS, d_encode_visited, dg_instances, dg_players  # noqa: F401
from core.dungeon.player import d_effective_stats, d_get_instance, d_get_player, d_instance_start  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



# ============================================================
#  ヘルパー関数
# ============================================================

def d_get_biome(floor):
    """フロアからバイオーム情報を取得"""
    for r, name, wall_e, floor_e, fog_e, color in D_BIOMES:
        if floor in r:
            return name, wall_e, floor_e, fog_e, color
    return "洞窟", "⬜", "<:b_:1563559473422016512>", "🌫️", 0x5C4033





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


def dungeon_plan_key(plan):
    """表示名・キーのどちらからでも作戦キーを解決する。"""
    if plan in CLEF_PLANS:
        return plan
    for key, name in CLEF_PLANS.items():
        if name == plan:
            return key
    return "safe"
