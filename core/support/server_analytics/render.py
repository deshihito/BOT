# -*- coding: utf-8 -*-
"""サーバー分析の PIL レンダラ（白基調）。

テーマは core/leaderboard_image.py に統一（薄グレーの背景・白カード・
単一アクセント）。レイアウトは自前構成:
- Overview: ヘッダー → 4指標の横帯 → 日次推移エリアチャート →
  ランキング2列×2段（発言／絵文字／リアクションを受けた／メンション）
- Heatmap: 曜日（月–日）× 0–23 時のグリッド＋濃淡凡例

氏名はメンションではなくプレーンテキスト（core/general/user_names.py
の方針）。描画は純関数で、render_cached の LRU で再描画を抑える。
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

from PIL import ImageFont

from core.game.game.board_image import render_cached
from core.leaderboard_image import (
    BG,
    BOARD_W,
    CARD_BORDER,
    DEFAULT_ACCENT,
    INK,
    MUTE,
    board_safe_name,
    fit_text,
    fmt_int,
)
from core.leaderboard_image import _card_rect, _darken, _font, _text_w, _tint
from core.support.server_analytics.metrics import Overview

ACCENT = DEFAULT_ACCENT
MARGIN = 28
WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"]

_EMOJI_FONT_SIZE = 109  # Noto Color Emoji は 109px でしか読めない
_emoji_font_cache = None


def _emoji_font():
    """同梱の Noto Color Emoji フォント（無ければ None）。"""
    global _emoji_font_cache
    if _emoji_font_cache is None:
        _emoji_font_cache = False
        from core.support import data_paths

        path = data_paths.repo_root() / "assets" / "fonts" / "NotoColorEmoji.ttf"
        if path.is_file():
            try:
                _emoji_font_cache = ImageFont.truetype(
                    str(path), _EMOJI_FONT_SIZE)
            except Exception:
                _emoji_font_cache = False
    return _emoji_font_cache or None


def _draw_emoji_key(img: Image.Image, draw: ImageDraw.ImageDraw,
                    x: int, y: int, key: str, size: int = 30) -> None:
    """絵文字キーを描く。カスタム絵文字は ``:name:`` のテキスト表記、

    ユニコード絵文字はカラーフォントで描いて貼る（通常フォントには
    字形が無く空白になるため。MIQ と同じ手法）。
    """
    if key.startswith(":"):
        draw.text((x, y + 2), key, font=_font(26), fill=INK)
        return
    font = _emoji_font()
    if font is None:
        draw.text((x, y + 2), key, font=_font(26), fill=INK)
        return
    canvas = Image.new("RGBA", (_EMOJI_FONT_SIZE * 2, _EMOJI_FONT_SIZE * 2),
                       (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((10, 10), key, font=font, embedded_color=True)
    bbox = canvas.getbbox()
    if bbox is None:
        draw.text((x, y + 2), key, font=_font(26), fill=INK)
        return
    glyph = canvas.crop(bbox)
    glyph.thumbnail((size, size))
    img.paste(glyph, (x, y + (30 - glyph.height) // 2), glyph)


@dataclass
class OverviewImage:
    """Overview 1枚分の表示データ（名前は解決済みプレーンテキスト）。"""

    server_name: str
    member_count: int | None
    started_at: str
    overview: Overview
    top_user_names: dict[int, str] = field(default_factory=dict)
    top_reacted_names: dict[int, str] = field(default_factory=dict)
    top_mentioned_names: dict[int, str] = field(default_factory=dict)


@dataclass
class HeatmapImage:
    server_name: str
    started_at: str
    period_start: str
    period_end: str
    matrix: list[list[int]] = field(default_factory=list)


def _period_text(start, end) -> str:
    return f"{start.month}/{start.day} – {end.month}/{end.day}（直近14日）"


def _started_text(started_at: str) -> str:
    if not started_at:
        return ""
    return f"収集開始 {started_at[:10]}"


def _draw_header(draw: ImageDraw.ImageDraw, title: str, server_name: str,
                 subtexts: list[str]) -> int:
    draw.text((MARGIN, 22), title, font=_font(34),
              fill=_darken(ACCENT, 0.8))
    name_font = _font(40)
    shown = fit_text(draw, board_safe_name(server_name, "サーバー"),
                     name_font, BOARD_W - MARGIN * 2)
    draw.text((MARGIN, 64), shown, font=name_font, fill=INK)
    sub = " · ".join(text for text in subtexts if text)
    if sub:
        draw.text((MARGIN, 116), sub, font=_font(24), fill=MUTE)
    draw.line((MARGIN, 148, BOARD_W - MARGIN, 148), fill=ACCENT, width=3)
    return 162


def render_overview_png(data: OverviewImage) -> bytes:
    key = ("server_analytics_overview", _overview_version(data))
    return render_cached(key, lambda: _draw_overview(data))


def _overview_version(data: OverviewImage) -> str:
    ov = data.overview
    h = hashlib.sha1()
    h.update(repr((
        data.server_name, data.member_count, data.started_at,
        ov.total_messages, ov.active_users, ov.voice_seconds,
        ov.new_members, ov.recorded_days, tuple(ov.daily),
        tuple(ov.top_users), tuple(ov.top_emojis), tuple(ov.top_reacted),
        tuple(ov.top_mentioned),
        tuple(sorted(data.top_user_names.items())),
        tuple(sorted(data.top_reacted_names.items())),
        tuple(sorted(data.top_mentioned_names.items())),
    )).encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


def _draw_overview(data: OverviewImage) -> bytes:
    ov = data.overview
    height = 162 + 108 + 24 + 46 + 190 + 24 + 600 + 46 + 30
    img = Image.new("RGB", (BOARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    subtexts = [_period_text(ov.start, ov.end)]
    if data.member_count is not None:
        subtexts.append(f"メンバー {fmt_int(data.member_count)}人")
    subtexts.append(_started_text(data.started_at))
    y = _draw_header(draw, "サーバー分析", data.server_name, subtexts)

    if ov.recorded_days == 0:
        draw.text((MARGIN, y + 30),
                  "まだデータがありません。収集 ON 以降の活動から記録されます。",
                  font=_font(28), fill=MUTE)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()

    y = _draw_snapshot(draw, ov, y)
    y = _draw_trend(draw, ov, y + 24)
    y = _draw_lists(draw, img, data, y + 24)
    if ov.recorded_days < 14:
        draw.text((MARGIN, y + 6),
                  f"収集開始からの {ov.recorded_days} 日分を表示しています。",
                  font=_font(22), fill=MUTE)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _draw_snapshot(draw: ImageDraw.ImageDraw, ov: Overview, y: int) -> int:
    band_h = 108
    _card_rect(draw, (MARGIN, y, BOARD_W - MARGIN, y + band_h), radius=16)
    stats = [
        ("発言数", fmt_int(ov.total_messages)),
        ("アクティブユーザー", fmt_int(ov.active_users)),
        ("VC 時間", f"{ov.voice_seconds / 3600:.1f} h"),
        ("新規参加", fmt_int(ov.new_members)),
    ]
    col_w = (BOARD_W - MARGIN * 2) // 4
    label_font = _font(23)
    value_font = _font(42)
    for index, (label, value) in enumerate(stats):
        x0 = MARGIN + index * col_w
        if index:
            draw.line((x0, y + 18, x0, y + band_h - 18),
                      fill=CARD_BORDER, width=2)
        draw.text((x0 + 22, y + 14), label, font=label_font, fill=MUTE)
        draw.text((x0 + 22, y + 48), value, font=value_font, fill=INK)
    return y + band_h


def _draw_trend(draw: ImageDraw.ImageDraw, ov: Overview, y: int) -> int:
    title_font = _font(28)
    draw.text((MARGIN, y + 6), "日ごとの発言数",
              font=title_font, fill=_darken(ACCENT, 0.8))
    y += 46
    chart_h = 190
    chart_x0 = MARGIN + 4
    chart_w = BOARD_W - MARGIN * 2 - 8
    baseline = y + chart_h - 28
    top = y + 6
    values = [count for _d, count in ov.daily] or [0]
    peak = max(values) or 1
    draw.line((chart_x0, baseline, chart_x0 + chart_w, baseline),
              fill=CARD_BORDER, width=2)
    n = len(values)
    points = []
    for index, value in enumerate(values):
        x = chart_x0 + (chart_w * index / max(1, n - 1) if n > 1
                        else chart_w / 2)
        yy = baseline - int((baseline - top) * value / peak)
        points.append((x, yy))
    if len(points) > 1:
        polygon = points + [(points[-1][0], baseline), (points[0][0], baseline)]
        draw.polygon(polygon, fill=_tint(ACCENT, 0.22))
        draw.line(points, fill=_darken(ACCENT, 0.85), width=3)
    for x, yy in points:
        draw.ellipse((x - 4, yy - 4, x + 4, yy + 4),
                     fill=_darken(ACCENT, 0.85))
    axis_font = _font(20)
    if ov.daily:
        first = f"{ov.daily[0][0].month}/{ov.daily[0][0].day}"
        last = f"{ov.daily[-1][0].month}/{ov.daily[-1][0].day}"
        peak_text = f"最大 {fmt_int(peak)}"
        draw.text((chart_x0, baseline + 6), first, font=axis_font, fill=MUTE)
        draw.text((chart_x0 + chart_w - _text_w(draw, last, axis_font),
                   baseline + 6), last, font=axis_font, fill=MUTE)
        draw.text((chart_x0 + chart_w - _text_w(draw, peak_text, axis_font),
                   top - 24), peak_text, font=axis_font, fill=MUTE)
    return y + chart_h


def _draw_rank_list(draw: ImageDraw.ImageDraw, img: Image.Image,
                    x0: int, y: int, width: int,
                    title: str, rows: list[tuple[str, str]],
                    *, emoji: bool = False) -> None:
    title_font = _font(26)
    draw.text((x0, y + 2), title, font=title_font,
              fill=_darken(ACCENT, 0.8))
    y += 42
    if not rows:
        draw.text((x0 + 4, y + 8), "まだデータがありません",
                  font=_font(24), fill=MUTE)
        return
    name_font = _font(26)
    count_font = _font(26)
    rank_font = _font(24)
    row_h = 50
    _card_rect(draw, (x0, y, x0 + width, y + row_h * len(rows)), radius=14)
    for index, (name, count_text) in enumerate(rows):
        cy = y + index * row_h
        if index:
            draw.line((x0 + 14, cy, x0 + width - 14, cy),
                      fill=CARD_BORDER, width=1)
        rank_text = f"{index + 1}."
        draw.text((x0 + 16, cy + 12), rank_text, font=rank_font, fill=MUTE)
        if emoji:
            _draw_emoji_key(img, draw, x0 + 58, cy + 10, name)
        else:
            shown = fit_text(draw, name, name_font, width - 170)
            draw.text((x0 + 58, cy + 10), shown, font=name_font, fill=INK)
        count_w = _text_w(draw, count_text, count_font)
        draw.text((x0 + width - 18 - count_w, cy + 10), count_text,
                  font=count_font, fill=INK)


def _named_rows(pairs, names: dict[int, str], suffix: str):
    from core.general.user_names import fallback_name

    return [
        (board_safe_name(names.get(uid, fallback_name(uid)), "不明"),
         f"{fmt_int(count)}{suffix}")
        for uid, count in pairs
    ]


def _draw_lists(draw: ImageDraw.ImageDraw, img: Image.Image,
                data: OverviewImage, y: int) -> int:
    ov = data.overview
    col_w = (BOARD_W - MARGIN * 2 - 24) // 2
    left_x = MARGIN
    right_x = MARGIN + col_w + 24
    _draw_rank_list(draw, img, left_x, y, col_w, "発言 Top",
                    _named_rows(ov.top_users, data.top_user_names, ""))
    _draw_rank_list(draw, img, right_x, y, col_w, "よく使われた絵文字",
                    [(key, f"{fmt_int(count)}") for key, count in ov.top_emojis],
                    emoji=True)
    y += 300
    _draw_rank_list(draw, img, left_x, y, col_w, "リアクションを受けた",
                    _named_rows(ov.top_reacted, data.top_reacted_names, ""))
    _draw_rank_list(draw, img, right_x, y, col_w, "メンションされた",
                    _named_rows(ov.top_mentioned, data.top_mentioned_names, ""))
    return y + 300


# ----------------------------------------------------------------------
# Heatmap
# ----------------------------------------------------------------------

def render_heatmap_png(data: HeatmapImage) -> bytes:
    key = ("server_analytics_heatmap", _heatmap_version(data))
    return render_cached(key, lambda: _draw_heatmap(data))


def _heatmap_version(data: HeatmapImage) -> str:
    h = hashlib.sha1()
    h.update(repr((
        data.server_name, data.started_at, data.period_start,
        data.period_end, tuple(tuple(row) for row in data.matrix),
    )).encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


def _heat_color(ratio: float):
    """0.0–1.0 を白→アクセントの5段階に落とす。"""
    if ratio <= 0:
        return (255, 255, 255)
    steps = [0.85, 0.62, 0.4, 0.18, 0.0]
    index = min(4, int(ratio * 5))
    return _tint(ACCENT, steps[index]) if index < 4 else ACCENT


def _draw_heatmap(data: HeatmapImage) -> bytes:
    grid_top = 196
    label_w = 44
    cell_w = (BOARD_W - MARGIN * 2 - label_w) // 24
    cell_h = 40
    grid_h = cell_h * 7
    height = grid_top + grid_h + 84 + MARGIN
    img = Image.new("RGB", (BOARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    subtexts = [f"{data.period_start} – {data.period_end}（直近14日・JST）",
                _started_text(data.started_at)]
    y = _draw_header(draw, "サーバー分析 ヒートマップ", data.server_name,
                     subtexts)

    matrix = data.matrix or [[0] * 24 for _ in range(7)]
    peak = max((max(row) if row else 0) for row in matrix) or 0
    grid_x0 = MARGIN + label_w
    axis_font = _font(20)
    for hour in range(0, 24, 3):
        label = str(hour)
        x = grid_x0 + hour * cell_w + cell_w // 2
        draw.text((x - _text_w(draw, label, axis_font) / 2, grid_top - 28),
                  label, font=axis_font, fill=MUTE)
    weekday_font = _font(24)
    for weekday in range(7):
        cy = grid_top + weekday * cell_h
        label = WEEKDAY_LABELS[weekday]
        draw.text((MARGIN + 6, cy + cell_h // 2 - 13), label,
                  font=weekday_font, fill=INK)
        row = matrix[weekday] if weekday < len(matrix) else [0] * 24
        for hour in range(24):
            value = row[hour] if hour < len(row) else 0
            ratio = value / peak if peak else 0.0
            x0 = grid_x0 + hour * cell_w
            draw.rounded_rectangle(
                (x0 + 2, cy + 3, x0 + cell_w - 2, cy + cell_h - 3),
                radius=6, fill=_heat_color(ratio),
                outline=CARD_BORDER, width=1)
    legend_y = grid_top + grid_h + 30
    legend_font = _font(22)
    draw.text((grid_x0, legend_y), "Less", font=legend_font, fill=MUTE)
    x = grid_x0 + _text_w(draw, "Less", legend_font) + 12
    for ratio in (0.0, 0.2, 0.45, 0.7, 1.0):
        draw.rounded_rectangle((x, legend_y + 1, x + 26, legend_y + 23),
                               radius=5, fill=_heat_color(ratio),
                               outline=CARD_BORDER, width=1)
        x += 32
    draw.text((x + 4, legend_y), "More", font=legend_font, fill=MUTE)
    if peak == 0:
        draw.text((grid_x0, legend_y + 40),
                  "まだデータがありません。収集 ON 以降の活動から記録されます。",
                  font=_font(22), fill=MUTE)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
