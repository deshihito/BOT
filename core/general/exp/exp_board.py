# -*- coding: utf-8 -*-
"""EXPランキングの集計と盤面/カード画像の描画。

集計（軸別ソート・全体合算・ページング・ライバル計算）は純関数として
切り出し、盤面の描画は共通リーダーボード基盤 core.leaderboard_image
（白基調テーマ）に寄せる。個人ランクカードも同じ白基調で描く。
再描画は board_image.render_cached の LRU で抑える（Pi 負荷対策）。
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from core.game.game.board_image import render_cached
from core.leaderboard_image import (
    BG, BOARD_W, HEADER_H, INK, MUTE, PODIUM_H, ROW_H, BoardRow,
    circle_avatar, draw_bar, fit_text, render_leaderboard_png,
)
from core.leaderboard_image import _font, _text_w

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

# テーマ色は core.leaderboard_image の白基調に統一（BG はそちらから再輸出）。
RANK_GOLD = (184, 134, 11)


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
# 盤面（ランキングボード）: 共通レンダラへ委譲
# ============================================================
def render_board_png(rows: list[dict], *, axis: str = "general",
                     scope_label: str = "サーバー内", page: int = 0,
                     total_pages: int = 1, names: dict | None = None,
                     avatars: dict | None = None,
                     highlight_user_id=None) -> bytes:
    """ランキング盤面を描く（白基調）。先頭ページは表彰台レイアウト。"""
    names = names or {}
    board_rows = [
        BoardRow(
            user_id=row["user_id"],
            name=names.get(row["user_id"]) or "ユーザー",
            value=f"Lv.{row['level']}",
            sub=f"{row['value']:,} EXP",
            bar=row["progress"],
        )
        for row in rows
    ]
    return render_leaderboard_png(
        title=f"EXPランキング｜{AXIS_LABELS.get(axis, '総合')}",
        sections=[(None, board_rows)],
        accent=AXIS_ACCENTS.get(axis, AXIS_ACCENTS["general"]),
        subtitle=f"{scope_label}　{page + 1}/{total_pages} ページ",
        podium=(page == 0),
        highlight_user_id=highlight_user_id,
        avatars=avatars,
        empty_text="まだEXPデータがありません。",
        cache_namespace="exp-board",
    )


# ============================================================
# 個人ランクカード（白基調）
# ============================================================
CARD_W, CARD_H = 1000, 400


def render_card_png(*, user_id: int, name: str, avatar_bytes: bytes | None,
                    chat_exp: int, vc_exp: int, server_rank: int | None,
                    global_rank: int | None) -> bytes:
    """個人ランクカード（横長）。順位が None のときは「圏外」と出す。"""
    key = ("exp-card", user_id, name, chat_exp, vc_exp, server_rank, global_rank)
    return render_cached(key, lambda: _render_card(
        user_id=user_id, name=name, avatar_bytes=avatar_bytes,
        chat_exp=chat_exp, vc_exp=vc_exp,
        server_rank=server_rank, global_rank=global_rank))


def _render_card(*, user_id, name, avatar_bytes, chat_exp, vc_exp,
                 server_rank, global_rank) -> bytes:
    img = Image.new("RGB", (CARD_W, CARD_H), BG)
    draw = ImageDraw.Draw(img)
    accent = AXIS_ACCENTS["general"]
    draw.rounded_rectangle((10, 10, CARD_W - 10, CARD_H - 10), radius=24,
                           fill=(255, 255, 255))
    draw.rounded_rectangle((10, 10, CARD_W - 10, CARD_H - 10), radius=24,
                           outline=accent, width=3)
    avatar = circle_avatar(user_id, name, avatar_bytes, 220)
    img.paste(avatar, (44, (CARD_H - 220) // 2), avatar)

    x = 300
    name_font = _font(44)
    shown = fit_text(draw, name or "ユーザー", name_font, 640)
    draw.text((x, 36), shown, font=name_font, fill=INK)
    gl = general_level(chat_exp, vc_exp)
    lv_font = _font(64)
    draw.text((x, 92), f"general Lv.{gl}", font=lv_font, fill=accent)
    total_font = _font(28)
    draw.text((x, 172), f"総EXP {chat_exp + vc_exp:,}", font=total_font,
              fill=MUTE)

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
        draw_bar(draw, x + 250, y + 8, 240, 14,
                 (cur / need) if need else 1.0, color)
        num = f"{cur:,}/{need:,}"
        draw.text((CARD_W - 36 - _text_w(draw, num, num_font), y + 2),
                  num, font=num_font, fill=MUTE)
        y += 48

    rank_font = _font(30)
    server = f"サーバー内 {server_rank}位" if server_rank else "サーバー内 圏外"
    global_ = f"全体 {global_rank}位" if global_rank else "全体 圏外"
    draw.text((x, y + 6), f"{server}　／　{global_}", font=rank_font,
              fill=RANK_GOLD)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
