# -*- coding: utf-8 -*-
"""人物分析カードの PIL レンダラ（白基調）。

テーマは core/leaderboard_image.py に統一（薄グレーの背景、白カード、
金銀銅ではなく単一アクセント）。レイアウトは参考スクショの構成に寄せる:

- ヘッダー: アバター・表示名・@ID・クラスタチップ（C2・51人）
- 4タイル: 受け取った／送った／PageRank／媒介中心性（いずれも全期間）
- 活発な時間: ピーク時間帯テキスト＋24時間ヒストグラム
- よく絡む相手: アバター＋名前＋双方向カウント（→送った／←受けた）

氏名はメンションではなくプレーンテキスト（core/general/user_names.py の
方針）。描画は純関数で、render_cached の LRU で再描画を抑える。
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

from core.game.game.board_image import render_cached
from core.leaderboard_image import (
    BG,
    BOARD_W,
    CARD_BORDER,
    DEFAULT_ACCENT,
    INK,
    MUTE,
    board_safe_name,
    circle_avatar,
    fit_text,
    fmt_int,
)
from core.leaderboard_image import _card_rect, _darken, _font, _text_w, _tint

ACCENT = DEFAULT_ACCENT
SENT_COLOR = (227, 119, 36)     # 「→ 送った」のオレンジ
RECEIVED_COLOR = (41, 128, 185)  # 「← 受けた」のブルー

MARGIN = 28
HEADER_H = 132
TILE_H = 116
TILE_GAP = 16
SECTION_TITLE_H = 46
HISTOGRAM_H = 168
PARTNER_ROW_H = 76


@dataclass
class PartnerRow:
    name: str
    user_id: int | None
    sent: int
    received: int


@dataclass
class PersonCard:
    """カード1枚分の表示データ（名前は解決済みプレーンテキスト）。"""

    name: str
    username: str
    user_id: int | None
    cluster_label: str | None = None
    cluster_size: int = 0
    received: int = 0
    sent: int = 0
    pagerank: float = 0.0
    betweenness: float | None = None
    hours: list[int] = field(default_factory=lambda: [0] * 24)
    peaks: list[int] = field(default_factory=list)
    partners: list[PartnerRow] = field(default_factory=list)


def _version_of(card: PersonCard, avatars: dict) -> str:
    h = hashlib.sha1()
    h.update(repr((
        card.name, card.username, card.user_id, card.cluster_label,
        card.cluster_size, card.received, card.sent, card.pagerank,
        card.betweenness, tuple(card.hours), tuple(card.peaks),
        tuple((p.name, p.user_id, p.sent, p.received) for p in card.partners),
    )).encode("utf-8", "ignore"))
    for user_id in sorted(avatars, key=str):
        data = avatars.get(user_id)
        if data:
            h.update(hashlib.sha1(data).digest())
    return h.hexdigest()[:16]


def render_person_card_png(card: PersonCard,
                           avatars: dict | None = None) -> bytes:
    """人物カードの PNG を返す。データが空でも落ちずに空状態で描く。"""
    avatars = avatars or {}
    key = ("person_analysis", _version_of(card, avatars))
    return render_cached(key, lambda: _draw_card(card, avatars))


def _draw_card(card: PersonCard, avatars: dict) -> bytes:
    partner_area = (PARTNER_ROW_H * len(card.partners)
                    if card.partners else PARTNER_ROW_H)
    height = (
        HEADER_H + TILE_H * 2 + TILE_GAP + 24
        + SECTION_TITLE_H + 40 + HISTOGRAM_H
        + SECTION_TITLE_H + partner_area + MARGIN
    )
    img = Image.new("RGB", (BOARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    _draw_header(draw, img, card, avatars)
    y = _draw_tiles(draw, card, HEADER_H + 8)
    y = _draw_hours(draw, card, y + 24)
    _draw_partners(draw, img, card, avatars, y)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _draw_header(draw: ImageDraw.ImageDraw, img: Image.Image,
                 card: PersonCard, avatars: dict) -> None:
    avatar = circle_avatar(card.user_id, card.name,
                           avatars.get(card.user_id), 104)
    img.paste(avatar, (MARGIN, 16), avatar)
    name = board_safe_name(card.name, card.username or "不明")
    name_font = _font(40)
    shown = fit_text(draw, name, name_font, 560)
    draw.text((MARGIN + 124, 30), shown, font=name_font, fill=INK)
    if card.username:
        handle_font = _font(26)
        handle = fit_text(draw, f"@{card.username}", handle_font, 560)
        draw.text((MARGIN + 124, 82), handle, font=handle_font, fill=MUTE)
    if card.cluster_label:
        chip_font = _font(26)
        chip_text = f"{card.cluster_label}・{card.cluster_size}人"
        chip_w = _text_w(draw, chip_text, chip_font) + 36
        x1 = BOARD_W - MARGIN
        x0 = x1 - chip_w
        draw.rounded_rectangle((x0, 44, x1, 92), radius=24,
                               fill=_tint(ACCENT, 0.14))
        draw.text((x0 + 18, 55), chip_text, font=chip_font,
                  fill=_darken(ACCENT, 0.75))
    draw.line((MARGIN, HEADER_H - 4, BOARD_W - MARGIN, HEADER_H - 4),
              fill=ACCENT, width=3)


def _draw_tiles(draw: ImageDraw.ImageDraw, card: PersonCard, y: int) -> int:
    tiles = [
        ("受け取った（全期間）", fmt_int(card.received)),
        ("送った（全期間）", fmt_int(card.sent)),
        ("PageRank（全期間）", f"{card.pagerank:.3f}"),
        ("媒介中心性（全期間）",
         "—" if card.betweenness is None else f"{card.betweenness:.2f}"),
    ]
    tile_w = (BOARD_W - MARGIN * 2 - TILE_GAP) // 2
    label_font = _font(24)
    value_font = _font(46)
    for index, (label, value) in enumerate(tiles):
        col, row = index % 2, index // 2
        x0 = MARGIN + col * (tile_w + TILE_GAP)
        y0 = y + row * (TILE_H + TILE_GAP)
        _card_rect(draw, (x0, y0, x0 + tile_w, y0 + TILE_H), radius=16)
        draw.text((x0 + 22, y0 + 14), label, font=label_font, fill=MUTE)
        draw.text((x0 + 22, y0 + 50), value, font=value_font, fill=INK)
    return y + TILE_H * 2 + TILE_GAP


def _draw_hours(draw: ImageDraw.ImageDraw, card: PersonCard, y: int) -> int:
    title_font = _font(28)
    draw.text((MARGIN, y + 6), "活発な時間（発言件数）",
              font=title_font, fill=_darken(ACCENT, 0.8))
    y += SECTION_TITLE_H
    if card.peaks:
        peak_font = _font(30)
        peak_text = "・".join(f"{hour}時" for hour in card.peaks)
        draw.text((MARGIN, y), peak_text, font=peak_font, fill=INK)
    else:
        draw.text((MARGIN, y), "まだデータがありません",
                  font=_font(26), fill=MUTE)
    y += 40

    hist = (list(card.hours) + [0] * 24)[:24]
    peak_value = max(hist) if hist else 0
    chart_x0 = MARGIN + 4
    chart_w = BOARD_W - MARGIN * 2 - 8
    bar_area_h = HISTOGRAM_H - 34
    slot = chart_w / 24
    bar_w = max(6, int(slot * 0.58))
    baseline = y + bar_area_h
    draw.line((chart_x0, baseline, chart_x0 + chart_w, baseline),
              fill=CARD_BORDER, width=2)
    peak_hours = set(card.peaks)
    for hour, count in enumerate(hist):
        if count <= 0 or peak_value <= 0:
            continue
        bar_h = max(4, int(bar_area_h * count / peak_value))
        x0 = int(chart_x0 + hour * slot + (slot - bar_w) / 2)
        color = _darken(ACCENT, 0.8) if hour in peak_hours else ACCENT
        draw.rounded_rectangle(
            (x0, baseline - bar_h, x0 + bar_w, baseline),
            radius=min(5, bar_w // 2), fill=color)
    axis_font = _font(20)
    for hour in (0, 6, 12, 18, 23):
        label = f"{hour}時"
        x = chart_x0 + hour * slot + slot / 2
        draw.text((x - _text_w(draw, label, axis_font) / 2, baseline + 8),
                  label, font=axis_font, fill=MUTE)
    return baseline + 34


def _draw_partners(draw: ImageDraw.ImageDraw, img: Image.Image,
                   card: PersonCard, avatars: dict, y: int) -> None:
    title_font = _font(28)
    draw.text((MARGIN, y + 6), "よく絡む相手",
              font=title_font, fill=_darken(ACCENT, 0.8))
    y += SECTION_TITLE_H
    if not card.partners:
        draw.text((MARGIN + 4, y + 16), "まだデータがありません",
                  font=_font(26), fill=MUTE)
        return
    name_font = _font(30)
    count_font = _font(27)
    for row in card.partners:
        _card_rect(draw, (MARGIN, y + 4, BOARD_W - MARGIN,
                          y + PARTNER_ROW_H - 8), radius=14)
        avatar = circle_avatar(row.user_id, row.name,
                               avatars.get(row.user_id), 52)
        img.paste(avatar, (MARGIN + 14, y + (PARTNER_ROW_H - 52) // 2),
                  avatar)
        name = board_safe_name(row.name, "不明")
        shown = fit_text(draw, name, name_font, 380)
        draw.text((MARGIN + 80, y + PARTNER_ROW_H // 2 - 19),
                  shown, font=name_font, fill=INK)
        sent_text = f"→ {fmt_int(row.sent)} 送った"
        received_text = f"← {fmt_int(row.received)} 受けた"
        sent_w = _text_w(draw, sent_text, count_font)
        received_w = _text_w(draw, received_text, count_font)
        gap = 18
        x = BOARD_W - MARGIN - 20 - received_w
        text_y = y + PARTNER_ROW_H // 2 - 17
        draw.text((x, text_y), received_text, font=count_font,
                  fill=RECEIVED_COLOR)
        draw.text((x - gap - sent_w, text_y), sent_text, font=count_font,
                  fill=SENT_COLOR)
        y += PARTNER_ROW_H
