# -*- coding: utf-8 -*-
"""EXPランキングの集計と盤面/カード画像の描画。

集計（軸別ソート・全体合算・ページング・ライバル計算）は純関数として
切り出し、描画は PIL の純関数（アバター欠落時はプレースホルダで代替）。
盤面は「タイル/格子をテキストで再現すると安っぽくなる」ため画像化し、
再描画は core.game.game.board_image.render_cached の LRU で抑える（Pi 負荷対策）。
"""
from __future__ import annotations

import hashlib
import io

from PIL import Image, ImageDraw, ImageFont

from core.game.game.board_image import FONT_PATH, render_cached

from ..common import CHAT_EXP_BASE, CHAT_EXP_RATIO, VC_EXP_BASE, VC_EXP_RATIO
from .exp import _as_int, general_level, level_from_exp

PAGE_SIZE = 10

AXES = ("general", "chat", "vc")
AXIS_LABELS = {"general": "総合", "chat": "チャット", "vc": "VC"}
AXIS_ACCENTS = {
    "general": (169, 112, 220),
    "chat": (88, 150, 255),
    "vc": (72, 199, 142),
}

BOARD_W = 1000
ROW_H = 92
HEADER_H = 68
PODIUM_H = 304

BG = (23, 25, 43)
PANEL = (35, 38, 62)
PANEL_HIGHLIGHT = (74, 54, 110)
INK = (240, 242, 250)
MUTE = (158, 164, 190)
TRACK = (52, 56, 84)
GOLD = (241, 196, 15)
SILVER = (198, 204, 214)
BRONZE = (205, 127, 50)
MEDALS = {1: GOLD, 2: SILVER, 3: BRONZE}


# ============================================================
# 集計
# ============================================================
def _row_from(user_id, chat_exp: int, vc_exp: int, axis: str) -> dict:
    chat_exp = _as_int(chat_exp)
    vc_exp = _as_int(vc_exp)
    gl = general_level(chat_exp, vc_exp)
    cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
    vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
    if axis == "chat":
        level, cur, need, value = cl, ccur, cneed, chat_exp
    elif axis == "vc":
        level, cur, need, value = vl, vcur, vneed, vc_exp
    else:
        # general のバーは chat/vc 両軸の進捗の平均（次 general Lv への目安）。
        frac = 0.0
        if cneed > 0:
            frac += ccur / cneed
        if vneed > 0:
            frac += vcur / vneed
        level, cur, need, value = gl, 0, 0, chat_exp + vc_exp
        return {
            "user_id": user_id, "chat_exp": chat_exp, "vc_exp": vc_exp,
            "general_level": gl, "level": level, "value": value,
            "progress": min(1.0, frac / 2.0),
        }
    return {
        "user_id": user_id, "chat_exp": chat_exp, "vc_exp": vc_exp,
        "general_level": gl, "level": level, "value": value,
        "progress": (cur / need) if need > 0 else 1.0,
    }


def build_rows(data: dict, axis: str = "general", guild_id=None) -> list[dict]:
    """EXPデータから軸別にソート済みの行リストを作る。

    guild_id が None のときは全ギルドをユーザー単位で合算する（全体）。
    ソート意味論は従来踏襲: general は (general_level, 合計EXP)、
    chat/vc は各 EXP 値（同点は合計EXP→user_id で安定化）。
    """
    if axis not in AXES:
        axis = "general"
    totals: dict[int, tuple[int, int]] = {}
    if guild_id is None:
        guilds = data.values() if isinstance(data, dict) else []
        for guild in guilds:
            if not isinstance(guild, dict):
                continue
            for uid, u in guild.items():
                if not isinstance(u, dict):
                    continue
                try:
                    uid_int = int(uid)
                except (TypeError, ValueError):
                    continue
                ce, ve = totals.get(uid_int, (0, 0))
                totals[uid_int] = (ce + _as_int(u.get("chat_exp")),
                                   ve + _as_int(u.get("vc_exp")))
    else:
        guild = data.get(str(guild_id), {}) if isinstance(data, dict) else {}
        if isinstance(guild, dict):
            for uid, u in guild.items():
                if not isinstance(u, dict):
                    continue
                try:
                    uid_int = int(uid)
                except (TypeError, ValueError):
                    continue
                totals[uid_int] = (_as_int(u.get("chat_exp")),
                                   _as_int(u.get("vc_exp")))
    rows = [_row_from(uid, ce, ve, axis) for uid, (ce, ve) in totals.items()]
    if axis == "general":
        rows.sort(key=lambda r: (r["general_level"], r["value"], r["user_id"]),
                  reverse=True)
    else:
        rows.sort(key=lambda r: (r["value"], r["chat_exp"] + r["vc_exp"],
                                 r["user_id"]), reverse=True)
    for i, row in enumerate(rows, start=1):
        row["rank"] = i
    return rows


def paginate(rows: list[dict], page: int, per_page: int = PAGE_SIZE):
    """(そのページの行, 総ページ数, 補正後ページ) を返す。"""
    total_pages = max(1, (len(rows) + per_page - 1) // per_page)
    page = min(max(int(page), 0), total_pages - 1)
    start = page * per_page
    return rows[start:start + per_page], total_pages, page


def find_rank(rows: list[dict], user_id) -> int | None:
    """1始まりの順位。圏外（データなし）は None。"""
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    for row in rows:
        if row["user_id"] == uid:
            return row["rank"]
    return None


def rival_info(rows: list[dict], user_id) -> dict | None:
    """ライバル情報: 自分の順位・真上の user_id・その人との EXP 差。

    差は対象軸の value（general は合計EXP、chat/vc は各軸EXP）で測る。
    1位のときは above_user_id=None / gap=0。圏外は None を返す。
    """
    rank = find_rank(rows, user_id)
    if rank is None:
        return None
    me = rows[rank - 1]
    if rank == 1:
        return {"rank": 1, "above_user_id": None, "gap": 0,
                "value": me["value"]}
    above = rows[rank - 2]
    return {"rank": rank, "above_user_id": above["user_id"],
            "gap": above["value"] - me["value"], "value": me["value"]}


def top_clan(clans: list[dict]) -> dict | None:
    """list_clans() 形式（total_points 降順想定）からトップクランを返す。"""
    best = None
    for clan in clans or []:
        if not isinstance(clan, dict):
            continue
        if best is None or _as_int(clan.get("total_points")) > _as_int(best.get("total_points")):
            best = clan
    return best


# ============================================================
# 描画ヘルパ
# ============================================================
def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except Exception:
        return ImageFont.load_default()


def _text_w(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _fit_text(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
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


def _placeholder_avatar(user_id: int, name: str, size: int) -> Image.Image:
    color = _PLACEHOLDER_COLORS[int(user_id or 0) % len(_PLACEHOLDER_COLORS)]
    img = Image.new("RGB", (size, size), color)
    draw = ImageDraw.Draw(img)
    initial = (name or "?").strip()[:1] or "?"
    font = _font(int(size * 0.52))
    bbox = draw.textbbox((0, 0), initial, font=font)
    draw.text(((size - (bbox[2] - bbox[0])) / 2 - bbox[0],
               (size - (bbox[3] - bbox[1])) / 2 - bbox[1]),
              initial, font=font, fill=(255, 255, 255))
    return img


def _circle_avatar(user_id: int, name: str, avatar_bytes: bytes | None,
                   size: int) -> Image.Image:
    img = None
    if avatar_bytes:
        try:
            src = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
            src.thumbnail((size * 2, size * 2), Image.LANCZOS)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            scale = max(size / src.width, size / src.height)
            resized = src.resize((max(1, int(src.width * scale)),
                                  max(1, int(src.height * scale))), Image.LANCZOS)
            canvas.alpha_composite(resized, ((size - resized.width) // 2,
                                             (size - resized.height) // 2))
            img = canvas
        except Exception:
            img = None
    if img is None:
        img = _placeholder_avatar(user_id, name, size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def _bar(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int,
         frac: float, color) -> None:
    draw.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=TRACK)
    fw = int(w * min(1.0, max(0.0, frac)))
    if fw > 0:
        draw.rounded_rectangle((x, y, x + max(fw, h), y + h), radius=h // 2,
                               fill=color)


def _medal(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, rank: int) -> None:
    color = MEDALS.get(rank)
    if color is None:
        return
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    font = _font(int(r * 1.1))
    text = str(rank)
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0],
               cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              text, font=font, fill=(40, 32, 8))


def _version_of(rows: list[dict], names: dict) -> str:
    h = hashlib.sha1()
    for row in rows:
        h.update(f"{row['user_id']}:{row['chat_exp']}:{row['vc_exp']}:"
                 f"{names.get(row['user_id'], '')};".encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


# ============================================================
# 盤面（ランキングボード）
# ============================================================
def render_board_png(rows: list[dict], *, axis: str = "general",
                     scope_label: str = "サーバー内", page: int = 0,
                     total_pages: int = 1, names: dict | None = None,
                     avatars: dict | None = None,
                     highlight_user_id=None) -> bytes:
    """ランキング盤面を描く。先頭ページは 1〜3位を表彰台として大きく描く。"""
    names = names or {}
    avatars = avatars or {}
    key = ("exp-board", axis, scope_label, page, highlight_user_id,
           _version_of(rows, names))
    return render_cached(key, lambda: _render_board(
        rows, axis=axis, scope_label=scope_label, page=page,
        total_pages=total_pages, names=names, avatars=avatars,
        highlight_user_id=highlight_user_id))


def _render_board(rows, *, axis, scope_label, page, total_pages, names,
                  avatars, highlight_user_id) -> bytes:
    accent = AXIS_ACCENTS.get(axis, AXIS_ACCENTS["general"])
    podium = page == 0 and len(rows) >= 1
    body_rows = rows[3:] if podium else rows
    height = HEADER_H + (PODIUM_H if podium else 0) + max(1, len(body_rows)) * ROW_H + 16
    img = Image.new("RGB", (BOARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    title_font = _font(36)
    sub_font = _font(24)
    draw.text((28, 16), f"EXPランキング｜{AXIS_LABELS.get(axis, '総合')}",
              font=title_font, fill=INK)
    sub = f"{scope_label}　{page + 1}/{total_pages} ページ"
    draw.text((BOARD_W - 28 - _text_w(draw, sub, sub_font), 24), sub,
              font=sub_font, fill=MUTE)
    draw.line((28, HEADER_H - 6, BOARD_W - 28, HEADER_H - 6), fill=accent, width=3)

    y = HEADER_H
    if podium:
        _draw_podium(draw, img, rows[:3], y, names=names, avatars=avatars,
                     highlight_user_id=highlight_user_id, accent=accent)
        y += PODIUM_H
    if not rows:
        draw.text((28, y + 26), "まだEXPデータがありません。",
                  font=_font(30), fill=MUTE)
    for row in body_rows:
        _draw_row(draw, img, row, y, names=names, avatars=avatars,
                  highlight_user_id=highlight_user_id, accent=accent)
        y += ROW_H

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _draw_podium(draw, img, top_rows, y, *, names, avatars, highlight_user_id,
                 accent) -> None:
    # 1位を中央に大きく、2位を左、3位を右に置く表彰台レイアウト。
    slots = [(0, BOARD_W // 2, 148), (1, 190, 116), (2, BOARD_W - 190, 116)]
    name_font = _font(30)
    lv_font = _font(24)
    for index, cx, size in slots:
        if index >= len(top_rows):
            continue
        row = top_rows[index]
        rank = row["rank"]
        uid = row["user_id"]
        name = names.get(uid) or "ユーザー"
        x0 = cx - 150
        fill = PANEL_HIGHLIGHT if uid == highlight_user_id else PANEL
        draw.rounded_rectangle((x0, y + 10, x0 + 300, y + PODIUM_H - 12),
                               radius=18, fill=fill)
        avatar = _circle_avatar(uid, name, avatars.get(uid), size)
        img.paste(avatar, (cx - size // 2, y + 18), avatar)
        _medal(draw, cx + size // 2 - 6, y + 22, 24, rank)
        shown = _fit_text(draw, name, name_font, 270)
        draw.text((cx - _text_w(draw, shown, name_font) / 2, y + 178),
                  shown, font=name_font, fill=INK)
        lv = _fit_text(draw, f"Lv.{row['level']}　{row['value']:,} EXP",
                       lv_font, 280)
        draw.text((cx - _text_w(draw, lv, lv_font) / 2, y + 218),
                  lv, font=lv_font, fill=accent)
        _bar(draw, cx - 110, y + PODIUM_H - 40, 220, 12, row["progress"], accent)


def _draw_row(draw, img, row, y, *, names, avatars, highlight_user_id,
              accent) -> None:
    uid = row["user_id"]
    name = names.get(uid) or "ユーザー"
    fill = PANEL_HIGHLIGHT if uid == highlight_user_id else PANEL
    draw.rounded_rectangle((16, y + 6, BOARD_W - 16, y + ROW_H - 6),
                           radius=14, fill=fill)
    rank_font = _font(34)
    rank_text = f"#{row['rank']}"
    draw.text((30, y + ROW_H // 2 - 20), rank_text, font=rank_font,
              fill=MEDALS.get(row["rank"], MUTE))
    avatar = _circle_avatar(uid, name, avatars.get(uid), 64)
    img.paste(avatar, (118, y + (ROW_H - 64) // 2), avatar)
    name_font = _font(32)
    shown = _fit_text(draw, name, name_font, 400)
    draw.text((200, y + 14), shown, font=name_font, fill=INK)
    _bar(draw, 200, y + ROW_H - 30, 400, 12, row["progress"], accent)
    info_font = _font(32)
    info = f"Lv.{row['level']}"
    draw.text((BOARD_W - 30 - _text_w(draw, info, info_font), y + 12),
              info, font=info_font, fill=INK)
    exp_font = _font(26)
    exp = f"{row['value']:,} EXP"
    draw.text((BOARD_W - 30 - _text_w(draw, exp, exp_font), y + 52),
              exp, font=exp_font, fill=MUTE)


# ============================================================
# 個人ランクカード
# ============================================================
CARD_W, CARD_H = 1000, 400


def render_card_png(*, user_id: int, name: str, avatar_bytes: bytes | None,
                    chat_exp: int, vc_exp: int, server_rank: int | None,
                    global_rank: int | None) -> bytes:
    """個人ランクカード（横長）。順位が None のときは「圏外」と出す。"""
    key = ("exp-card", user_id, name, chat_exp, vc_exp, server_rank, global_rank)
    return render_cached(key, lambda: _render_card(
        user_id=user_id, name=name, avatar_bytes=avatar_bytes,
        chat_exp=chat_exp, vc_exp=vc_exp, server_rank=server_rank,
        global_rank=global_rank))


def _render_card(*, user_id, name, avatar_bytes, chat_exp, vc_exp,
                 server_rank, global_rank) -> bytes:
    img = Image.new("RGB", (CARD_W, CARD_H), BG)
    draw = ImageDraw.Draw(img)
    accent = AXIS_ACCENTS["general"]
    draw.rounded_rectangle((10, 10, CARD_W - 10, CARD_H - 10), radius=24,
                           outline=accent, width=3)
    avatar = _circle_avatar(user_id, name, avatar_bytes, 220)
    img.paste(avatar, (44, (CARD_H - 220) // 2), avatar)

    x = 300
    name_font = _font(44)
    shown = _fit_text(draw, name or "ユーザー", name_font, 640)
    draw.text((x, 36), shown, font=name_font, fill=INK)
    gl = general_level(chat_exp, vc_exp)
    lv_font = _font(64)
    draw.text((x, 92), f"general Lv.{gl}", font=lv_font, fill=accent)
    total_font = _font(28)
    draw.text((x, 172), f"総EXP {chat_exp + vc_exp:,}", font=total_font, fill=MUTE)

    rows = []
    cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
    vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
    rows.append(("チャット", cl, ccur, cneed, AXIS_ACCENTS["chat"]))
    rows.append(("VC", vl, vcur, vneed, AXIS_ACCENTS["vc"]))
    label_font = _font(28)
    num_font = _font(24)
    y = 224
    for label, level, cur, need, color in rows:
        draw.text((x, y), f"{label} Lv.{level}", font=label_font, fill=INK)
        _bar(draw, x + 250, y + 8, 240, 14, (cur / need) if need else 1.0, color)
        num = f"{cur:,}/{need:,}"
        draw.text((CARD_W - 36 - _text_w(draw, num, num_font), y + 2),
                  num, font=num_font, fill=MUTE)
        y += 48

    rank_font = _font(30)
    server = f"サーバー内 {server_rank}位" if server_rank else "サーバー内 圏外"
    global_ = f"全体 {global_rank}位" if global_rank else "全体 圏外"
    draw.text((x, y + 6), f"{server}　／　{global_}", font=rank_font, fill=GOLD)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
