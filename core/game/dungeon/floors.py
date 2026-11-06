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

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.common import D2_MAIN_ROLES, D2_MAP_H, D2_MAP_W, D2_SECTOR_N, D2_SUB_ROLES, D_CHEST, D_EVENT, D_FLOOR, D_MAP_H, D_MAP_W, D_MINE, D_REST, D_SHOP, D_SHRINE, D_STAIRS, D_START, D_TRAP, D_WALL, dg_starts  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



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
