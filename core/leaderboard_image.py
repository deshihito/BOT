# -*- coding: utf-8 -*-
"""リーダーボード共通の画像レンダラ（白基調テーマで統一）。

EXPランキング盤面（PR #566）で確立した「盤面は画像、操作はボタンに分離」
のパターンを、コイン/資産/RTA/ゲーム/生存確認などの各ランキングへ
横展開するための共通基盤。描画は PIL の純関数で、再描画は
core.game.game.board_image.render_cached の LRU で抑える（Pi 負荷対策）。

テーマ（白基調）:
- 背景はごく薄いグレー、行は白カード＋薄い境界と影で浮かせる。
- 1〜3位は金・銀・銅のアクセント、進捗バーや見出し線はボードごとの
  アクセントカラーで識別する。
- 先頭セクションは（行があれば）1位中央・2位左・3位右の表彰台にする。
"""
from __future__ import annotations

import hashlib
import io
import unicodedata
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

from core.game.game.board_image import FONT_PATH, render_cached

BOARD_W = 1000
HEADER_H = 68
PODIUM_H = 304
ROW_H = 92
SECTION_H = 52

# 白基調テーマ
BG = (246, 247, 250)
CARD = (255, 255, 255)
CARD_BORDER = (221, 225, 233)
SHADOW = (230, 233, 240)
INK = (27, 31, 42)
MUTE = (107, 114, 130)
TRACK = (231, 234, 241)
MEDAL_FILLS = {1: (245, 197, 66), 2: (203, 213, 225), 3: (232, 168, 110)}
MEDAL_INK = (74, 56, 10)
RANK_INKS = {1: (184, 134, 11), 2: (119, 130, 148), 3: (176, 106, 54)}

DEFAULT_ACCENT = (88, 101, 242)


@dataclass(frozen=True)
class BoardRow:
    """ランキング1行分。rank は並び順（1始まり）で自動付与される。"""

    name: str
    value: str
    user_id: int | None = None
    sub: str = ""
    bar: float | None = None


def fmt_int(value) -> str:
    """数値の桁区切りはカンマで統一する（例: 38,000）。"""
    return f"{int(value):,}"


# ============================================================
# 描画ヘルパ
# ============================================================
# 桁区切りのカンマが小さくドットに見える従来フォント(font.ttf)を避け、
# カンマの下向きが明瞭な同梱フォントを優先する（数字の誤読防止）。
_BOARD_FONT_PATH = (FONT_PATH.parent / "assets" / "fonts"
                    / "MPLUSRounded1c-Regular.ttf")


def _font(size: int):
    for path in (_BOARD_FONT_PATH, FONT_PATH):
        try:
            return ImageFont.truetype(str(path), size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_w(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _has_ink(text: str) -> bool:
    """同梱フォントで描いて実際にインクが乗るか（字形が無い文字は空白になる）。"""
    font = _font(32)
    probe = ImageDraw.Draw(Image.new("L", (8, 8), 0))
    bbox = probe.textbbox((0, 0), text, font=font)
    canvas = Image.new("L", (max(1, bbox[2] - bbox[0]) + 4,
                             max(1, bbox[3] - bbox[1]) + 4), 0)
    ImageDraw.Draw(canvas).text((2 - bbox[0], 2 - bbox[1]), text,
                                font=font, fill=255)
    return canvas.getextrema()[1] > 0


def board_safe_name(name, fallback: str = "") -> str:
    """表示名を盤面で読める形にする。装飾文字は通常文字へ、無理なら fallback。

    Discord の表示名でよく使われる装飾英数字（𝐀𝐛𝐜・𝕥𝕒𝕕𝕒 等）は同梱フォントに
    字形が無く、描いても空白になってしまう。NFKC 正規化で通常の英数字へ
    戻し、それでも何も描けない名前は fallback（ユーザー名など）に替える。
    """
    folded = unicodedata.normalize("NFKC", str(name or "")).strip()
    if folded and _has_ink(folded):
        return folded
    return str(fallback or "")


def fit_text(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
    if _text_w(draw, text, font) <= max_w:
        return text
    ellipsis = "…"
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _text_w(draw, text[:mid] + ellipsis, font) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + ellipsis


_PLACEHOLDER_COLORS = (
    (88, 101, 242), (235, 69, 158), (87, 178, 115), (250, 166, 26),
    (32, 167, 201), (155, 89, 182), (231, 76, 60), (52, 152, 219),
)


def placeholder_avatar(user_id: int | None, name: str, size: int) -> Image.Image:
    seed = int(user_id) if user_id is not None else sum(
        (i + 1) * ord(c) for i, c in enumerate(name or "?"))
    color = _PLACEHOLDER_COLORS[seed % len(_PLACEHOLDER_COLORS)]
    img = Image.new("RGB", (size, size), color)
    draw = ImageDraw.Draw(img)
    initial = (name or "?").strip()[:1] or "?"
    font = _font(int(size * 0.52))
    bbox = draw.textbbox((0, 0), initial, font=font)
    draw.text(((size - (bbox[2] - bbox[0])) / 2 - bbox[0],
               (size - (bbox[3] - bbox[1])) / 2 - bbox[1]),
              initial, font=font, fill=(255, 255, 255))
    return img


def circle_avatar(user_id: int | None, name: str, avatar_bytes: bytes | None,
                  size: int) -> Image.Image:
    img = None
    if avatar_bytes:
        try:
            src = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
            src.thumbnail((size * 2, size * 2), Image.LANCZOS)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            scale = max(size / src.width, size / src.height)
            resized = src.resize((max(1, int(src.width * scale)),
                                  max(1, int(src.height * scale))),
                                 Image.LANCZOS)
            canvas.alpha_composite(resized, ((size - resized.width) // 2,
                                             (size - resized.height) // 2))
            img = canvas
        except Exception:
            img = None
    if img is None:
        img = placeholder_avatar(user_id, name, size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def draw_bar(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int,
             frac: float, color) -> None:
    draw.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=TRACK)
    fw = int(w * min(1.0, max(0.0, frac)))
    if fw > 0:
        draw.rounded_rectangle((x, y, x + max(fw, h), y + h), radius=h // 2,
                               fill=color)


def _darken(color, ratio: float = 0.72):
    return tuple(max(0, min(255, int(c * ratio))) for c in color)


def _tint(color, ratio: float = 0.10):
    """白にアクセントを ratio だけ混ぜた淡色（ハイライト行用）。"""
    return tuple(int(c * ratio + 255 * (1 - ratio)) for c in color)


def _card_rect(draw: ImageDraw.ImageDraw, box, *, fill=CARD, radius: int = 14,
               border=CARD_BORDER) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0, y0 + 3, x1, y1 + 3), radius=radius, fill=SHADOW)
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=fill)
    if border is not None:
        draw.rounded_rectangle((x0, y0, x1, y1), radius=radius,
                               outline=border, width=1)


def _medal(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, rank: int) -> None:
    color = MEDAL_FILLS.get(rank)
    if color is None:
        return
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    font = _font(int(r * 1.1))
    text = str(rank)
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0],
               cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              text, font=font, fill=MEDAL_INK)


# ============================================================
# 本体
# ============================================================
def _version_of(sections, avatars) -> str:
    h = hashlib.sha1()
    for title, rows in sections:
        h.update(f"[{title}];".encode("utf-8", "ignore"))
        for row in rows:
            h.update(
                f"{row.user_id}|{row.name}|{row.value}|{row.sub}|{row.bar};"
                .encode("utf-8", "ignore"))
            data = avatars.get(row.user_id) if row.user_id is not None else None
            if data:
                h.update(hashlib.sha1(data).digest())
    return h.hexdigest()[:16]


def render_leaderboard_png(*, title: str, sections, accent=DEFAULT_ACCENT,
                           subtitle: str = "", podium: bool = True,
                           highlight_user_id=None, avatars=None,
                           empty_text: str = "まだ記録がありません。",
                           cache_namespace: str = "leaderboard") -> bytes:
    """白基調のリーダーボード画像を描く。

    sections は [(見出し or None, [BoardRow, ...]), ...]。先頭セクションの
    先頭3行は（podium=True かつ行があれば）表彰台として大きく描く。
    """
    sections = [(t, list(rows)) for t, rows in sections]
    avatars = avatars or {}
    key = (cache_namespace, title, subtitle, accent, podium,
           highlight_user_id, _version_of(sections, avatars))
    return render_cached(key, lambda: _draw_leaderboard(
        title=title, sections=sections, accent=accent, subtitle=subtitle,
        podium=podium, highlight_user_id=highlight_user_id, avatars=avatars,
        empty_text=empty_text))


def _draw_leaderboard(*, title, sections, accent, subtitle, podium,
                      highlight_user_id, avatars, empty_text) -> bytes:
    total_rows = sum(len(rows) for _t, rows in sections)
    height = HEADER_H + 16
    layout = []  # (section_title, podium_rows, body_rows)
    for index, (sec_title, rows) in enumerate(sections):
        use_podium = podium and index == 0 and len(rows) >= 1
        podium_rows = rows[:3] if use_podium else []
        body_rows = rows[3:] if use_podium else rows
        if sec_title:
            height += SECTION_H
        if use_podium:
            height += PODIUM_H
        height += max(1, len(body_rows)) * ROW_H if total_rows else 0
        layout.append((sec_title, podium_rows, body_rows))
    if total_rows == 0:
        height = HEADER_H + ROW_H + 16

    img = Image.new("RGB", (BOARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    title_font = _font(36)
    sub_font = _font(24)
    draw.text((28, 16), title, font=title_font, fill=INK)
    if subtitle:
        draw.text((BOARD_W - 28 - _text_w(draw, subtitle, sub_font), 24),
                  subtitle, font=sub_font, fill=MUTE)
    draw.line((28, HEADER_H - 6, BOARD_W - 28, HEADER_H - 6),
              fill=accent, width=3)

    y = HEADER_H
    if total_rows == 0:
        draw.text((28, y + 26), empty_text, font=_font(30), fill=MUTE)
    for sec_title, podium_rows, body_rows in layout:
        if sec_title:
            sec_font = _font(28)
            draw.text((28, y + 12), sec_title, font=sec_font,
                      fill=_darken(accent, 0.8))
            y += SECTION_H
        if podium_rows:
            _draw_podium(draw, img, podium_rows, y, avatars=avatars,
                         highlight_user_id=highlight_user_id, accent=accent)
            y += PODIUM_H
        rank_offset = len(podium_rows)
        for i, row in enumerate(body_rows):
            _draw_row(draw, img, row, rank_offset + i + 1, y,
                      avatars=avatars, highlight_user_id=highlight_user_id,
                      accent=accent)
            y += ROW_H

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _draw_podium(draw, img, top_rows, y, *, avatars, highlight_user_id,
                 accent) -> None:
    # 1位を中央に大きく、2位を左、3位を右に置く表彰台レイアウト。
    slots = [(0, BOARD_W // 2, 148), (1, 190, 116), (2, BOARD_W - 190, 116)]
    name_font = _font(30)
    value_font = _font(25)
    sub_font = _font(21)
    for index, cx, size in slots:
        if index >= len(top_rows):
            continue
        row = top_rows[index]
        rank = index + 1
        x0 = cx - 150
        highlighted = (highlight_user_id is not None
                       and row.user_id == highlight_user_id)
        fill = _tint(accent, 0.12) if highlighted else CARD
        border = accent if highlighted else CARD_BORDER
        _card_rect(draw, (x0, y + 10, x0 + 300, y + PODIUM_H - 12),
                   fill=fill, radius=18, border=border)
        medal_color = MEDAL_FILLS.get(rank)
        if medal_color is not None:
            draw.rounded_rectangle(
                (x0, y + 10, x0 + 300, y + 22), radius=6, fill=medal_color)
        avatar = circle_avatar(row.user_id, row.name,
                               avatars.get(row.user_id), size)
        img.paste(avatar, (cx - size // 2, y + 20), avatar)
        _medal(draw, cx + size // 2 - 6, y + 24, 24, rank)
        shown = fit_text(draw, row.name, name_font, 270)
        draw.text((cx - _text_w(draw, shown, name_font) / 2, y + 176),
                  shown, font=name_font, fill=INK)
        value = fit_text(draw, row.value, value_font, 280)
        draw.text((cx - _text_w(draw, value, value_font) / 2, y + 212),
                  value, font=value_font, fill=_darken(accent, 0.78))
        if row.sub:
            sub = fit_text(draw, row.sub, sub_font, 280)
            draw.text((cx - _text_w(draw, sub, sub_font) / 2, y + 242),
                      sub, font=sub_font, fill=MUTE)
        if row.bar is not None:
            draw_bar(draw, cx - 110, y + PODIUM_H - 24, 220, 10,
                     row.bar, accent)


def _draw_row(draw, img, row, rank, y, *, avatars, highlight_user_id,
              accent) -> None:
    highlighted = (highlight_user_id is not None
                   and row.user_id == highlight_user_id)
    fill = _tint(accent, 0.12) if highlighted else CARD
    border = accent if highlighted else CARD_BORDER
    _card_rect(draw, (16, y + 6, BOARD_W - 16, y + ROW_H - 6),
               fill=fill, radius=14, border=border)
    rank_font = _font(34)
    draw.text((30, y + ROW_H // 2 - 20), f"#{rank}", font=rank_font,
              fill=RANK_INKS.get(rank, MUTE))
    avatar = circle_avatar(row.user_id, row.name, avatars.get(row.user_id), 64)
    img.paste(avatar, (118, y + (ROW_H - 64) // 2), avatar)
    name_font = _font(32)
    shown = fit_text(draw, row.name, name_font, 400)
    draw.text((200, y + 14), shown, font=name_font, fill=INK)
    if row.bar is not None:
        draw_bar(draw, 200, y + ROW_H - 30, 400, 12, row.bar, accent)
    value_font = _font(32)
    value = fit_text(draw, row.value, value_font, 330)
    if row.sub or row.bar is not None:
        value_y = y + 12
    else:
        value_y = y + (ROW_H - 40) // 2
    draw.text((BOARD_W - 30 - _text_w(draw, value, value_font), value_y),
              value, font=value_font, fill=INK)
    if row.sub:
        sub_font = _font(26)
        sub = fit_text(draw, row.sub, sub_font, 330)
        draw.text((BOARD_W - 30 - _text_w(draw, sub, sub_font), y + 52),
                  sub, font=sub_font, fill=MUTE)


# ============================================================
# アバター取得（非同期・Discord 側）
# ============================================================
async def fetch_avatar_bytes(bot, user_ids) -> dict:
    """表示名解決と同じ方針でアバター画像を取得する（失敗は None=代替表示）。"""
    result: dict[int, bytes | None] = {}
    if bot is None:
        return {int(uid): None for uid in user_ids}
    for uid in list(user_ids)[:25]:  # 表示名解決と同じ上限（user_names._MAX_FETCH）
        data = None
        try:
            user = bot.get_user(uid) if hasattr(bot, "get_user") else None
            if user is None and hasattr(bot, "fetch_user"):
                user = await bot.fetch_user(uid)
            if user is not None:
                data = await user.display_avatar.replace(
                    size=128, format="png").read()
        except Exception:
            data = None
        result[int(uid)] = data
    return result
