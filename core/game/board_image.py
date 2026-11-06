# -*- coding: utf-8 -*-
"""タイル盤面の PIL 画像描画（ラウンド4の画像盤面経路）。

方針（ユーザー指示 2026-11-06）: 格子/タイル状の盤面をテキストで再現すると
安っぽくなるため、bot 既存の PIL 描画（将棋/チェスと同じ font.ttf 基盤）で
画像化し、Components V2 では ui.File + MediaGallery で送る。

- ``render_tiles``: (ラベル, 背景色) のタイルを行列で描く汎用描画。
- ``render_gauge``: 価値観ゲージの目盛り帯（中心帯・予想マーカー付き）。
どちらも PNG の bytes を返す純関数で、単体テストで検証できる。
"""
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = Path(__file__).resolve().parent.parent / "font.ttf"
TILE = 64
GAP = 6
PAD = 12
BG = (24, 26, 32)
FG = (245, 245, 245)


def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except Exception:
        return ImageFont.load_default()


def render_tiles(rows: list[list[tuple[str, tuple[int, int, int]]]],
                 *, tile: int = TILE, title: str | None = None) -> bytes:
    """タイル行列を描く。rows は [[(ラベル, RGB), ...], ...]。"""
    cols = max((len(r) for r in rows), default=0)
    title_h = 34 if title else 0
    width = PAD * 2 + cols * tile + max(0, cols - 1) * GAP
    height = PAD * 2 + title_h + len(rows) * tile + max(0, len(rows) - 1) * GAP
    img = Image.new("RGB", (max(width, 120), max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=FG, font=_font(20))
        y += title_h
    font = _font(22)
    for row in rows:
        x = PAD
        for label, color in row:
            draw.rounded_rectangle([x, y, x + tile, y + tile], radius=10, fill=color)
            if label:
                bbox = draw.textbbox((0, 0), label, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                draw.text((x + (tile - tw) / 2 - bbox[0], y + (tile - th) / 2 - bbox[1]),
                          label, fill=(20, 20, 20), font=font)
            x += tile + GAP
        y += tile + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_gauge(center: int | None, guess: int | None = None, *,
                 scale: int = 10, left: str = "", right: str = "") -> bytes:
    """0..scale の帯を描く。center があれば得点帯（±2/±1/中心）を色分けし、
    guess があればマーカーを立てる。center=None のときは帯を均一色にする。"""
    cell = 52
    width = PAD * 2 + (scale + 1) * cell
    height = 150
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    font = _font(18)
    y0, y1 = 44, 96
    for pos in range(scale + 1):
        x = PAD + pos * cell
        if center is None:
            color = (70, 76, 90)
        else:
            d = abs(pos - center)
            color = {0: (255, 193, 7), 1: (255, 152, 0), 2: (255, 213, 79)}.get(d, (70, 76, 90))
        draw.rounded_rectangle([x + 2, y0, x + cell - 2, y1], radius=8, fill=color)
        label = str(pos)
        bbox = draw.textbbox((0, 0), label, font=font)
        draw.text((x + (cell - (bbox[2] - bbox[0])) / 2 - bbox[0], y0 + 16 - bbox[1]),
                  label, fill=(20, 20, 20), font=font)
    if guess is not None:
        x = PAD + guess * cell + cell // 2
        draw.polygon([(x, y1 + 6), (x - 9, y1 + 24), (x + 9, y1 + 24)], fill=(66, 165, 245))
        draw.text((x - 12, y1 + 26), "予想", fill=(66, 165, 245), font=font)
    if center is not None:
        x = PAD + center * cell + cell // 2
        draw.polygon([(x, y0 - 6), (x - 9, y0 - 24), (x + 9, y0 - 24)], fill=(255, 193, 7))
    if left:
        draw.text((PAD, 4), f"◀ {left}", fill=FG, font=font)
    if right:
        bbox = draw.textbbox((0, 0), f"{right} ▶", font=font)
        draw.text((width - PAD - (bbox[2] - bbox[0]), 4), f"{right} ▶", fill=FG, font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
