import os
import discord
import json
import random
import asyncio
import threading
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
from cogs.support import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw, ImageEnhance
from zoneinfo import ZoneInfo
from core.support.api_client import APIError
from core.support.api_retry import run_with_retry
from core.support.emojis import FAILED

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.common import ASSET_CONFIG, D2_MAP_H, D2_MAP_W, DUNGEON_IMG_CHANNEL_ID, D_BASE, D_CHEST, D_EVENT, D_FLOOR, D_MINE, D_REST, D_SHOP, D_SHRINE, D_SIGHT_R, D_STAIRS, D_TRAP, D_VIEW_R, D_WALL, TILE, TILE_COLORS  # noqa: F401
from core.game.dungeon.player import d_get_instance  # noqa: F401
from core.game.dungeon.world import d_get_biome  # noqa: F401

logger = logging.getLogger("cogs.dangeon")



def load_all_assets():
    """Assetsフォルダから画像を読み込みキャッシュする"""
    global _ASSET_CACHE
    base_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(base_dir, "..", "..", "..", "Assets")
    
    _ASSET_CACHE = {}
    for (biome, tid), fname in ASSET_CONFIG.items():
        path = os.path.join(assets_dir, fname)
        if os.path.isfile(path):
            try:
                img = Image.open(path).convert("RGBA").resize((TILE, TILE), Image.Resampling.NEAREST)
                _ASSET_CACHE[(biome, tid)] = img
                logger.info("✓ %s を読み込みました", fname)
            except Exception as e:
                logger.error("%s %s ロード失敗: %s", FAILED, fname, e)

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
_MAP_SEQ_LOCK = threading.Lock()

def d_next_map_filename():
    """フレームごとに一意な添付ファイル名を発行する。

    描画は asyncio.to_thread でワーカースレッドからも呼ばれるため、
    連番の採番はロックで直列化する（一意性がキャッシュ回避の要）。
    """
    global _MAP_SEQ
    with _MAP_SEQ_LOCK:
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

def _map_png_bytes(uid, floor, px, py, radius=D_VIEW_R) -> bytes:
    """マップを描画して PNG バイト列にする（同期・PIL 処理のみ）。"""
    img = d_build_map_image(uid, floor, px, py, radius)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

async def d_render_image(uid, floor, px, py, bot, radius=D_VIEW_R):
    """マップを画像として生成しDiscordにアップロード、URLを返す"""
    buf = io.BytesIO(await asyncio.to_thread(
        _map_png_bytes, uid, floor, px, py, radius))
    try:
        ch = bot.get_channel(DUNGEON_IMG_CHANNEL_ID) or \
             await bot.fetch_channel(DUNGEON_IMG_CHANNEL_ID)
        msg = await ch.send(file=discord.File(buf, filename="map.png"))
        return msg.attachments[0].url
    except Exception as e:
        logger.error("画像アップロード失敗: %s", e)
        return None
