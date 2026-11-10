# -*- coding: utf-8 -*-
"""最大震度バッジ画像（PIL 自前描画）。

気象庁の震度階級色で塗った角丸の正方形に、「最大震度」の小見出しと
震度ラベル（例: 5弱）を大きな字で描く。外部素材は使わない。
フォントは盤面画像系と同じ同梱フォント（M PLUS Rounded 1c）を優先し、
無ければ font.ttf、最後は PIL 既定フォントへ落とす。
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from core.game.game.board_image import FONT_PATH
from core.support.earthquake import feed

_BOARD_FONT_PATH = (FONT_PATH.parent / "assets" / "fonts"
                    / "MPLUSRounded1c-Regular.ttf")

BADGE_SIZE = 480
BADGE_FILENAME = "earthquake_badge.png"


def _font(size: int):
    for path in (_BOARD_FONT_PATH, FONT_PATH):
        try:
            return ImageFont.truetype(str(path), size)
        except Exception:
            continue
    return ImageFont.load_default()


def _centered(draw: ImageDraw.ImageDraw, cx: int, y: int, text: str,
              font, fill) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0]
    draw.text((cx - width // 2 - bbox[0], y - bbox[1]), text, font=font,
              fill=fill)


def render_badge_png(max_scale: int) -> bytes:
    """最大震度バッジの PNG バイト列を返す。"""
    color = feed.scale_color(max_scale)
    label = feed.scale_label(max_scale)
    dark = max_scale in feed.SCALE_DARK_TEXT
    ink = (27, 31, 42) if dark else (255, 255, 255)
    sub_ink = (90, 96, 110) if dark else (235, 238, 245)

    image = Image.new("RGB", (BADGE_SIZE, BADGE_SIZE), color)
    draw = ImageDraw.Draw(image)
    # 正方形のまま出す（MediaGallery 側で角丸に表示される）。
    _centered(draw, BADGE_SIZE // 2, 84, "最大震度", _font(56), sub_ink)
    label_size = 250 if len(label) <= 1 else 190
    _centered(draw, BADGE_SIZE // 2, 168, label, _font(label_size), ink)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
