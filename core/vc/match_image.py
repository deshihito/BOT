# -*- coding: utf-8 -*-
"""ランダム通話の開始カード画像。

通話が始まったときに、両サーバーのアイコンと名前を並べたカードを描く。
アイコンが無いサーバーは名前の頭文字のプレースホルダで描く。
"""
from __future__ import annotations

import asyncio
import io
import logging

from PIL import Image, ImageDraw, ImageFont

from core.game.game.board_image import FONT_PATH
from core.leaderboard_image import board_safe_name

logger = logging.getLogger("cogs.sio_saito")

_FONTS_DIR = FONT_PATH.parent / "assets" / "fonts"
CARD_W, CARD_H = 920, 400
_BG = (248, 249, 252)
_INK = (32, 34, 42)
_SUB = (105, 112, 125)
_ACCENT = (37, 99, 235)
_ACCENT2 = (16, 163, 127)


def _font(filename: str, size: int):
    for path in (_FONTS_DIR / filename, FONT_PATH):
        try:
            return ImageFont.truetype(str(path), size)
        except Exception:
            continue
    return ImageFont.load_default()


def _fit_font(draw: ImageDraw.ImageDraw, text: str, filename: str,
              start: int, min_size: int, max_width: int):
    size = start
    while size > min_size:
        font = _font(filename, size)
        bbox = draw.textbbox((0, 0), text, font=font)
        if bbox[2] - bbox[0] <= max_width:
            return font
        size -= 2
    return _font(filename, min_size)


def _circle_icon(icon_bytes: bytes | None, initial: str, size: int,
                 color) -> Image.Image:
    """サーバーアイコンを円形に切り抜く。無ければ頭文字のプレースホルダ。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    if icon_bytes:
        try:
            src = Image.open(io.BytesIO(icon_bytes)).convert("RGBA")
            src = src.resize((size, size), Image.LANCZOS)
            mask = Image.new("L", (size, size), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
            canvas.paste(src, (0, 0), mask)
            draw.ellipse((0, 0, size - 1, size - 1), outline=(210, 214, 222), width=3)
            return canvas
        except Exception:
            logger.debug("ランダム通話: サーバーアイコンの読み込みに失敗しました", exc_info=True)
    draw.ellipse((0, 0, size - 1, size - 1), fill=color + (255,))
    font = _font("DelaGothicOne-Regular.ttf", int(size * 0.52))
    ch = (initial or "?")[:1]
    bbox = draw.textbbox((0, 0), ch, font=font)
    draw.text(((size - (bbox[2] - bbox[0])) / 2 - bbox[0],
               (size - (bbox[3] - bbox[1])) / 2 - bbox[1]),
              ch, font=font, fill=(255, 255, 255, 255))
    return canvas


def _draw_arrows(draw: ImageDraw.ImageDraw, cx: int, cy: int) -> None:
    """中央に双方向の矢印を描く（記号フォントに頼らない）。"""
    for dy, direction in ((-16, 1), (16, -1)):
        y = cy + dy
        x0, x1 = cx - 44, cx + 44
        draw.line((x0, y, x1, y), fill=_SUB, width=7)
        tip_x = x1 if direction > 0 else x0
        back = -14 * direction
        draw.polygon(
            [(tip_x, y), (tip_x + back, y - 11), (tip_x + back, y + 11)],
            fill=_SUB,
        )


def render_match_card(name_a: str, name_b: str,
                      icon_a: bytes | None = None, icon_b: bytes | None = None,
                      members_a: int | None = None,
                      members_b: int | None = None) -> bytes:
    """通話開始カード（両サーバーのアイコン・名前・参加人数）を PNG で返す。"""
    img = Image.new("RGB", (CARD_W, CARD_H), _BG)
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, CARD_W, 10), fill=_ACCENT)

    title_font = _font("DelaGothicOne-Regular.ttf", 44)
    title = "ランダム通話"
    bbox = draw.textbbox((0, 0), title, font=title_font)
    draw.text(((CARD_W - (bbox[2] - bbox[0])) / 2 - bbox[0], 30),
              title, font=title_font, fill=_INK)
    sub_font = _font("MPLUSRounded1c-Regular.ttf", 22)
    sub = "通話を開始しました"
    bbox = draw.textbbox((0, 0), sub, font=sub_font)
    draw.text(((CARD_W - (bbox[2] - bbox[0])) / 2 - bbox[0], 88),
              sub, font=sub_font, fill=_SUB)

    icon_size = 168
    centers = [(215, 215), (705, 215)]
    names = [board_safe_name(name_a, fallback=name_a),
             board_safe_name(name_b, fallback=name_b)]
    icons = [icon_a, icon_b]
    counts = [members_a, members_b]
    colors = [_ACCENT, _ACCENT2]
    for (cx, cy), name, icon, count, color in zip(
            centers, names, icons, counts, colors):
        icon_img = _circle_icon(icon, name[:1] if name else "?", icon_size, color)
        img.paste(icon_img, (cx - icon_size // 2, cy - icon_size // 2), icon_img)
        name_font = _fit_font(draw, name or "サーバー", "MPLUSRounded1c-Regular.ttf",
                              30, 16, 360)
        bbox = draw.textbbox((0, 0), name or "サーバー", font=name_font)
        draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0], cy + icon_size // 2 + 14),
                  name or "サーバー", font=name_font, fill=_INK)
        if count is not None:
            count_text = f"{count}人が参加中"
            count_font = _font("MPLUSRounded1c-Regular.ttf", 20)
            bbox = draw.textbbox((0, 0), count_text, font=count_font)
            draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0],
                       cy + icon_size // 2 + 56),
                      count_text, font=count_font, fill=_SUB)

    _draw_arrows(draw, CARD_W // 2, 215)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def fetch_guild_icon_bytes(guild) -> bytes | None:
    """サーバーアイコンの画像バイト列を取得する（失敗時は None）。"""
    icon = getattr(guild, "icon", None)
    if icon is None:
        return None
    url = None
    try:
        sized = icon.replace(size=256)
        url = str(getattr(sized, "url", "") or "")
    except Exception:
        url = str(getattr(icon, "url", "") or "")
    if not url.startswith("http"):
        return None

    def _get() -> bytes | None:
        import requests

        try:
            response = requests.get(url, timeout=5)
            if response.status_code == 200 and response.content:
                return response.content
        except Exception:
            logger.debug("ランダム通話: アイコン取得に失敗しました", exc_info=True)
        return None

    return await asyncio.to_thread(_get)
