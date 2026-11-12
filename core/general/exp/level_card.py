# -*- coding: utf-8 -*-
"""個人レベルカード（ガラス調）の描画。/level と /level_settings 用。

背景はテーマパレットから生成する淡いグラデーション、その上に
すりガラス（ぼかし＋半透明ティント）のパネルを置く。素材ファイルは
持たない。EXP の計算・集計は exp.py / exp_board.py の既存関数を使い、
ここは描画だけを持つ。同期の CPU 処理なので、呼び出し側は
asyncio.to_thread 経由で呼ぶこと（exp_ui 側でそうしている）。
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFilter

from core.game.game.board_image import render_cached
from core.leaderboard_image import _font, _text_w, circle_avatar, fit_text

from ..common import CHAT_EXP_BASE, CHAT_EXP_RATIO, VC_EXP_BASE, VC_EXP_RATIO
from . import levelup_card
from .exp import general_level, level_from_exp

CARD_W, CARD_H = 1000, 400
_SS = 2  # supersample

# バーの塗りはテーマに依らず淡色で固定（背景が淡色グラデーションのため）。
BAR_CHAT = (121, 170, 248)
BAR_VC = (94, 205, 165)
RANK_INK = (146, 102, 6)


def _mix(a, b, t: float):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _background(pal: dict) -> Image.Image:
    """テーマパレットから 3 段の縦グラデーション＋柔らかい円の背景を作る。"""
    w, h = CARD_W * _SS, CARD_H * _SS
    top = _mix(pal["bg"], pal["ring"], 0.35)
    mid = _mix(pal["bg"], pal["accent"], 0.10)
    bottom = _mix(pal["bg"], pal["ring"], 0.55)
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        color = _mix(top, mid, t * 2) if t < 0.5 else _mix(mid, bottom, (t - 0.5) * 2)
        draw.line((0, y, w, y), fill=color)
    # 奥行き用の大きな淡い円（右上と左下）。
    blob = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    r1 = int(300 * _SS)
    bd.ellipse((w - r1 - int(40 * _SS), -int(90 * _SS), w - int(40 * _SS), r1 - int(90 * _SS)),
               fill=pal["ring"] + (70,))
    r2 = int(240 * _SS)
    bd.ellipse((-int(70 * _SS), h - r2 + int(40 * _SS), r2 - int(70 * _SS), h + int(40 * _SS)),
               fill=pal["accent"] + (45,))
    blob = blob.filter(ImageFilter.GaussianBlur(60 * _SS))
    img = Image.alpha_composite(img.convert("RGBA"), blob)
    return img


def _frosted_panel(base: Image.Image, box) -> Image.Image:
    """box 領域をぼかして半透明ティントを重ねたガラスパネルを返す。"""
    crop = base.crop(box).filter(ImageFilter.GaussianBlur(14 * _SS))
    dark = sum(base.getpixel((box[0] + 4, box[1] + 4))[:3]) < 3 * 110
    tint = (24, 28, 40, 120) if dark else (255, 255, 255, 96)
    overlay = Image.new("RGBA", crop.size, tint)
    return Image.alpha_composite(crop.convert("RGBA"), overlay)


def render_level_card_png(*, user_id: int, name: str, avatar_bytes: bytes | None,
                          chat_exp: int, vc_exp: int, server_rank: int | None,
                          global_rank: int | None, theme: str | None = None) -> bytes:
    """ガラス調の個人レベルカード（1000x400 PNG）。"""
    theme = theme if theme in levelup_card.THEMES else levelup_card.DEFAULT_THEME
    key = ("level-card", user_id, name, chat_exp, vc_exp, server_rank, global_rank, theme)
    return render_cached(key, lambda: _render(
        user_id=user_id, name=name, avatar_bytes=avatar_bytes,
        chat_exp=chat_exp, vc_exp=vc_exp, server_rank=server_rank,
        global_rank=global_rank, theme=theme))


def _render(*, user_id, name, avatar_bytes, chat_exp, vc_exp,
            server_rank, global_rank, theme) -> bytes:
    pal = levelup_card.palette(theme)
    ink, mute = pal["ink"], pal["mute"]
    img = _background(pal)
    w, h = img.size
    s = _SS

    margin = 28 * s
    box = (margin, margin, w - margin, h - margin)
    panel = _frosted_panel(img, box)
    mask = Image.new("L", panel.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, panel.size[0], panel.size[1]), radius=28 * s, fill=255)
    img.paste(panel, (box[0], box[1]), mask)
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rounded_rectangle(box, radius=28 * s, outline=(255, 255, 255, 190), width=2 * s)

    # アバター（リングつき円）。
    av_size = 200 * s
    avatar = circle_avatar(user_id, name, avatar_bytes, av_size)
    ax, ay = box[0] + 44 * s, (h - av_size) // 2
    img.paste(avatar, (ax, ay), avatar)
    draw.ellipse((ax, ay, ax + av_size, ay + av_size), outline=pal["ring"] + (255,), width=5 * s)

    x = ax + av_size + 36 * s
    name_font = _font(44 * s)
    shown = fit_text(draw, name or "ユーザー", name_font, int(620 * s))
    draw.text((x, box[1] + 30 * s), shown, font=name_font, fill=ink)

    gl = general_level(chat_exp, vc_exp)
    draw.text((x, box[1] + 84 * s), f"general Lv.{gl}", font=_font(64 * s), fill=ink)
    draw.text((x, box[1] + 166 * s), f"総EXP {chat_exp + vc_exp:,}",
              font=_font(28 * s), fill=mute)

    cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
    vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
    rows = (("チャット", cl, ccur, cneed, BAR_CHAT), ("VC", vl, vcur, vneed, BAR_VC))
    label_font, num_font = _font(28 * s), _font(24 * s)
    y = box[1] + 216 * s
    bar_x, bar_w, bar_h = x + 250 * s, 240 * s, 15 * s
    for label, level, cur, need, color in rows:
        draw.text((x, y), f"{label} Lv.{level}", font=label_font, fill=ink)
        frac = (cur / need) if need else 1.0
        draw.rounded_rectangle((bar_x, y + 8 * s, bar_x + bar_w, y + 8 * s + bar_h),
                               radius=bar_h // 2, fill=(255, 255, 255, 150))
        fw = int(bar_w * min(1.0, max(0.0, frac)))
        if fw > 0:
            draw.rounded_rectangle((bar_x, y + 8 * s, bar_x + max(fw, bar_h), y + 8 * s + bar_h),
                                   radius=bar_h // 2, fill=color + (255,))
        num = f"{cur:,}/{need:,}"
        draw.text((box[2] - 36 * s - _text_w(draw, num, num_font), y + 2 * s),
                  num, font=num_font, fill=mute)
        y += 48 * s

    server = f"サーバー内 {server_rank}位" if server_rank else "サーバー内 圏外"
    global_ = f"全体 {global_rank}位" if global_rank else "全体 圏外"
    draw.text((x, y + 4 * s), f"{server}　／　{global_}", font=_font(30 * s), fill=RANK_INK)

    img = img.convert("RGB").resize((CARD_W, CARD_H), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
