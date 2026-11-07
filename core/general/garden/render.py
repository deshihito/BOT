# -*- coding: utf-8 -*-
"""植物栽培の庭画像（PIL 描画）。

3鉢を横に並べ、種類×成長段階で絵が変わる1枚絵を返す。段階の差が
一目で分かることを優先し、装飾は最小限のフラットな描画に留める。
フォントは盤面画像・fujo 分析と同じリポジトリ同梱 font.ttf。
個体ごとの見た目のばらつきは planted_at を種にした決定的な乱数で出す
（同じ植物は開くたびに同じ姿になる）。
"""
from __future__ import annotations

import io
import math
import random
from pathlib import Path
from typing import Any

from core.support import data_paths
from core.general.garden import garden as core

_FONT_PATH = data_paths.repo_root() / "font.ttf"

WIDTH = 1080
HEIGHT = 470
CELL = WIDTH // core.POT_COUNT
GROUND_Y = 412
SOIL_Y = 330

_BG = (247, 243, 232)
_GROUND = (222, 210, 182)
_POT_BODY = (198, 106, 66)
_POT_RIM = (168, 82, 47)
_POT_DARK = (146, 68, 38)
_SOIL = (96, 66, 44)
_TRUNK = (110, 76, 48)
_TRUNK_DARK = (88, 58, 36)
_LEAF = (84, 166, 84)
_LEAF_DARK = (58, 138, 66)
_LEAF_LIGHT = (122, 190, 110)
_GRASS = (74, 160, 80)
_FRUIT = (226, 72, 61)
_FLOWER = (245, 197, 66)
_TEXT = (62, 54, 44)
_TEXT_SUB = (122, 110, 94)


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.truetype(str(_FONT_PATH), size)
    except Exception:
        return ImageFont.load_default()


def _centered(draw, cx: float, y: float, text: str, font, fill) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2, y), text, font=font, fill=fill)


def _draw_pot(draw, cx: float, *, bonsai: bool = False) -> None:
    """鉢と土を描く。盆栽は浅く広い鉢にする。"""
    draw.ellipse((cx - 88, GROUND_Y - 8, cx + 88, GROUND_Y + 10), fill=(232, 222, 198))
    if bonsai:
        draw.rectangle((cx - 92, SOIL_Y + 6, cx + 92, SOIL_Y + 16), fill=_POT_RIM)
        draw.polygon(
            [(cx - 88, SOIL_Y + 16), (cx + 88, SOIL_Y + 16),
             (cx + 74, SOIL_Y + 52), (cx - 74, SOIL_Y + 52)],
            fill=_POT_BODY,
        )
        draw.ellipse((cx - 88, SOIL_Y - 4, cx + 88, SOIL_Y + 12), fill=_SOIL)
    else:
        draw.rectangle((cx - 78, SOIL_Y - 2, cx + 78, SOIL_Y + 12), fill=_POT_RIM)
        draw.polygon(
            [(cx - 72, SOIL_Y + 12), (cx + 72, SOIL_Y + 12),
             (cx + 54, GROUND_Y - 2), (cx - 54, GROUND_Y - 2)],
            fill=_POT_BODY,
        )
        draw.line((cx - 66, SOIL_Y + 34, cx + 66, SOIL_Y + 34), fill=_POT_DARK, width=3)
        draw.ellipse((cx - 76, SOIL_Y - 10, cx + 76, SOIL_Y + 6), fill=_SOIL)


def _draw_seed(draw, cx: float) -> None:
    draw.ellipse((cx - 26, SOIL_Y - 6, cx + 26, SOIL_Y + 4), fill=(110, 84, 56))
    draw.ellipse((cx - 7, SOIL_Y - 12, cx + 7, SOIL_Y - 2), fill=(150, 108, 62))
    draw.ellipse((cx - 2, SOIL_Y - 16, cx + 3, SOIL_Y - 8), fill=_LEAF)


def _draw_sprout(draw, cx: float, rng: random.Random) -> None:
    draw.line((cx, SOIL_Y - 4, cx, SOIL_Y - 30), fill=_LEAF_DARK, width=4)
    for side in (-1, 1):
        tip_x = cx + side * 16
        draw.ellipse((tip_x - 10, SOIL_Y - 44, tip_x + 10, SOIL_Y - 28), fill=_LEAF)
    draw.ellipse((cx - 4, SOIL_Y - 48, cx + 4, SOIL_Y - 38), fill=_LEAF_LIGHT)


def _draw_grass(draw, cx: float, rng: random.Random, *, mature: bool) -> None:
    blades = 11 if mature else 7
    for _ in range(blades):
        bx = cx + rng.uniform(-46, 46)
        height = rng.uniform(64, 108) if mature else rng.uniform(34, 62)
        lean = rng.uniform(-16, 16)
        mid_x, mid_y = bx + lean * 0.4, SOIL_Y - height * 0.55
        tip_x, tip_y = bx + lean, SOIL_Y - height
        draw.line((bx, SOIL_Y - 2, mid_x, mid_y), fill=_GRASS, width=5)
        draw.line((mid_x, mid_y, tip_x, tip_y), fill=_GRASS, width=4)
    if mature:
        for _ in range(3):
            fx = cx + rng.uniform(-40, 40)
            fy = SOIL_Y - rng.uniform(74, 104)
            draw.line((fx, SOIL_Y - 2, fx, fy), fill=_LEAF_DARK, width=2)
            draw.ellipse((fx - 5, fy - 5, fx + 5, fy + 5), fill=_FLOWER)


def _draw_tree(draw, cx: float, rng: random.Random, *, mature: bool, fruit: bool) -> None:
    trunk_h = 96 if mature else 62
    top_y = SOIL_Y - trunk_h
    half = 11 if mature else 7
    draw.polygon(
        [(cx - half, SOIL_Y), (cx + half, SOIL_Y),
         (cx + half // 2, top_y), (cx - half // 2, top_y)],
        fill=_TRUNK,
    )
    r = 52 if mature else 34
    cy = top_y - r + 14
    offsets = [(-r * 0.7, 6), (r * 0.7, 6), (0, -r * 0.55), (-r * 0.35, -r * 0.2), (r * 0.35, -r * 0.2)]
    for i, (ox, oy) in enumerate(offsets):
        color = _LEAF if i % 2 == 0 else _LEAF_DARK
        draw.ellipse((cx + ox - r * 0.62, cy + oy - r * 0.62,
                      cx + ox + r * 0.62, cy + oy + r * 0.62), fill=color)
    draw.ellipse((cx - r * 0.3, cy - r * 0.75, cx + r * 0.3, cy - r * 0.15), fill=_LEAF_LIGHT)
    if fruit:
        for _ in range(6):
            ang = rng.uniform(0, math.tau)
            rad = rng.uniform(6, r * 0.8)
            fx, fy = cx + math.cos(ang) * rad, cy + math.sin(ang) * rad * 0.8
            draw.ellipse((fx - 6, fy - 6, fx + 6, fy + 6), fill=_FRUIT)
            draw.ellipse((fx - 2, fy - 3, fx + 1, fy), fill=(255, 170, 150))


def _bonsai_trunk_points(trait: str, cx: float, base_y: float, height: float) -> list[tuple[float, float]]:
    """樹形ごとの幹の中心線（根元→梢）を返す。"""
    steps = 24
    points = []
    for i in range(steps + 1):
        t = i / steps
        y = base_y - height * t
        if trait == "斜幹":
            x = cx + 34 * t
        elif trait == "曲幹":
            x = cx + 26 * math.sin(t * math.pi * 1.6)
        elif trait == "懸崖":
            # 一度少し上がってから鉢の縁より下へ垂れる
            if t < 0.3:
                x = cx + 20 * (t / 0.3)
                y = base_y - height * 0.34 * (t / 0.3)
            else:
                s = (t - 0.3) / 0.7
                x = cx + 20 + 44 * s
                y = base_y - height * 0.34 + (height * 0.95) * s * s
        else:  # 直幹
            x = cx + 3 * math.sin(t * 5.0)
        points.append((x, y))
    return points


def _draw_bonsai(draw, cx: float, rng: random.Random, plant: dict[str, Any], now: int) -> None:
    status = core.plant_status(plant, now)
    mature = status.stage == core.STAGE_MATURE
    if not mature:
        # 成木までは若木として小さく描く（段階で幹と葉の量が増える）
        height = 30 if status.stage == core.STAGE_SPROUT else 52
        draw.polygon(
            [(cx - 5, SOIL_Y), (cx + 5, SOIL_Y), (cx + 2, SOIL_Y - height), (cx - 2, SOIL_Y - height)],
            fill=_TRUNK,
        )
        pads = 1 if status.stage == core.STAGE_SPROUT else 2
        for i in range(pads):
            ox = (i - (pads - 1) / 2) * 30
            draw.ellipse((cx + ox - 24, SOIL_Y - height - 20, cx + ox + 24, SOIL_Y - height + 2),
                         fill=_LEAF if i % 2 == 0 else _LEAF_DARK)
        return
    band_index = [label for _t, label in core.BONSAI_FORM_BANDS].index(status.form_band)
    # 帯が上がるほど幹は太く、葉（棚）は増えて大きくなる
    width = 13 - band_index  # 0=国宝級 が最も太い
    height = 92
    points = _bonsai_trunk_points(status.trait or "直幹", cx, SOIL_Y - 2, height)
    for i in range(len(points) - 1):
        w = max(3, int(width * (1 - i / len(points)) + 3))
        draw.line((points[i], points[i + 1]), fill=_TRUNK, width=w)
    pads = 2 + (4 - band_index)  # 若木2 → 国宝級5
    pad_r = 20 + (4 - band_index) * 3
    anchors = [points[min(len(points) - 1, int(len(points) * f))]
               for f in (0.45, 0.65, 0.82, 0.93, 1.0)][:pads]
    anchors += [(points[-1][0], points[-1][1])]
    seen: list[tuple[float, float]] = []
    for ax, ay in anchors:
        if any(abs(ax - sx) < 12 and abs(ay - sy) < 8 for sx, sy in seen):
            continue
        seen.append((ax, ay))
        draw.ellipse((ax - pad_r, ay - pad_r * 0.45, ax + pad_r, ay + pad_r * 0.45), fill=_LEAF_DARK)
        draw.ellipse((ax - pad_r * 0.7, ay - pad_r * 0.55, ax + pad_r * 0.7, ay + pad_r * 0.2), fill=_LEAF)


def _pot_label(plant: dict[str, Any] | None, now: int) -> str:
    if plant is None:
        return "空き"
    status = core.plant_status(plant, now)
    if plant["species"] == "bonsai" and status.stage == core.STAGE_MATURE:
        return f"盆栽（{status.trait}）・{status.form_band}"
    label = f"{status.species_name}・{status.stage_label}"
    if status.fruit_ready:
        label += "・実がなっている"
    return label


def render_garden_png(pots: list[dict[str, Any] | None], now: int) -> bytes:
    """3鉢ぶんの庭を1枚の PNG にして返す。"""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (WIDTH, HEIGHT), _BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, GROUND_Y + 8, WIDTH, HEIGHT), fill=_GROUND)
    title_font = _font(24)
    label_font = _font(25)

    for index in range(core.POT_COUNT):
        cx = CELL * index + CELL // 2
        plant = pots[index] if index < len(pots) else None
        _centered(draw, cx, 18, f"鉢{index + 1}", title_font, _TEXT_SUB)
        _draw_pot(draw, cx, bonsai=bool(plant and plant["species"] == "bonsai"))
        if plant is not None:
            rng = random.Random(int(plant["planted_at"]) * 31 + index)
            status = core.plant_status(plant, now)
            if status.stage == core.STAGE_SEED:
                _draw_seed(draw, cx)
            elif status.stage == core.STAGE_SPROUT:
                _draw_sprout(draw, cx, rng)
            elif plant["species"] == "grass":
                _draw_grass(draw, cx, rng, mature=status.stage == core.STAGE_MATURE)
            elif plant["species"] == "tree":
                _draw_tree(draw, cx, rng, mature=status.stage == core.STAGE_MATURE,
                           fruit=status.fruit_ready)
            else:
                _draw_bonsai(draw, cx, rng, plant, now)
        _centered(draw, cx, HEIGHT - 42, _pot_label(plant, now), label_font, _TEXT)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
