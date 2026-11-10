# -*- coding: utf-8 -*-
"""天気カードの PIL レンダラ（白基調）。

テーマは core/leaderboard_image.py に統一（薄グレーの背景、白カード、
単一アクセント）。天気アイコンは外部素材を使わず PIL で自前描画する
（晴れ=太陽、くもり=雲、雨=雲+雨粒、雪=雲+雪片）。

- render_forecast_png: 1地域の予報カード（今日/明日/明後日＋週間）。
- render_national_png: 定時投稿用の全国概況カード（主要12地点の
  今日/明日）。気象庁は全国予報図の静的画像を安定URLで公開して
  いないため、同じ予報JSONから AGO が自前で描く（リレーではなく
  蒸留側の設計判断。2026-11-10 確認）。
"""
from __future__ import annotations

import hashlib
import io
import re
from datetime import datetime

from PIL import Image, ImageDraw

from core.game.game.board_image import render_cached
from core.leaderboard_image import (
    BG,
    CARD,
    CARD_BORDER,
    DEFAULT_ACCENT,
    INK,
    MUTE,
)
from core.leaderboard_image import _card_rect, _font, _text_w

ACCENT = DEFAULT_ACCENT
TEMP_MAX_COLOR = (211, 47, 47)
TEMP_MIN_COLOR = (41, 101, 185)
SUN_COLOR = (245, 166, 35)
CLOUD_COLOR = (144, 158, 178)
RAIN_COLOR = (41, 128, 225)
SNOW_COLOR = (110, 175, 225)
WEEKDAYS = ("月", "火", "水", "木", "金", "土", "日")


def _weekday(date_text: str) -> str:
    try:
        return WEEKDAYS[datetime.strptime(date_text, "%Y-%m-%d").weekday()]
    except (TypeError, ValueError):
        return ""


def _md(date_text: str) -> str:
    try:
        parsed = datetime.strptime(date_text, "%Y-%m-%d")
        return f"{parsed.month}/{parsed.day}"
    except (TypeError, ValueError):
        return date_text


def _clean_weather_text(text: str) -> str:
    """気象庁の天気文（全角空白区切り）を表示用に整える。"""
    cleaned = re.sub(r"[\u3000\s]+", " ", str(text or "")).strip()
    return cleaned


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int,
          max_lines: int) -> list[str]:
    """幅に合わせて折り返す（収まらない分は … で切る）。"""
    lines: list[str] = []
    rest = text
    while rest and len(lines) < max_lines:
        if _text_w(draw, rest, font) <= max_w:
            lines.append(rest)
            rest = ""
            break
        cut = len(rest)
        while cut > 1 and _text_w(draw, rest[:cut], font) > max_w:
            cut -= 1
        # 空白位置で優先的に切る（単語の途中を避ける）。
        space = rest.rfind(" ", 0, cut + 1)
        if space >= cut // 2:
            lines.append(rest[:space])
            rest = rest[space + 1:]
        else:
            lines.append(rest[:cut])
            rest = rest[cut:]
    if rest:
        if lines:
            lines[-1] = lines[-1].rstrip() + "…"
        else:
            lines.append("…")
    return lines


# ============================================================
# 天気アイコン（自前描画）
# ============================================================

def draw_weather_icon(draw: ImageDraw.ImageDraw, kind: str,
                      cx: int, cy: int, size: int) -> None:
    """(cx, cy) 中心・一辺 size の箱に天気アイコンを描く。"""
    r = size // 2
    if kind == "sunny":
        _draw_sun(draw, cx, cy, int(r * 0.52))
    elif kind == "cloudy":
        _draw_cloud(draw, cx, cy + int(r * 0.08), int(r * 0.95), int(r * 0.52))
    elif kind == "rain":
        _draw_cloud(draw, cx, cy - int(r * 0.28), int(r * 0.9), int(r * 0.46))
        drop = max(3, size // 16)
        for dx in (-0.42, 0.0, 0.42):
            x = cx + int(r * dx)
            for dy in (0.28, 0.62):
                y = cy + int(r * dy)
                draw.line((x - drop, y + drop, x + drop, y - drop),
                          fill=RAIN_COLOR, width=max(2, size // 18))
    elif kind == "snow":
        _draw_cloud(draw, cx, cy - int(r * 0.28), int(r * 0.9), int(r * 0.46))
        flake = max(3, size // 15)
        for dx in (-0.42, 0.0, 0.42):
            x = cx + int(r * dx)
            y = cy + int(r * 0.48)
            draw.line((x - flake, y, x + flake, y), fill=SNOW_COLOR,
                      width=max(2, size // 20))
            draw.line((x, y - flake, x, y + flake), fill=SNOW_COLOR,
                      width=max(2, size // 20))
    else:
        font = _font(max(16, size // 2))
        draw.text((cx - _text_w(draw, "?", font) / 2, cy - size // 4),
                  "?", fill=MUTE, font=font)


def _draw_sun(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int) -> None:
    import math

    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        x1 = cx + int((r + 4) * math.cos(rad))
        y1 = cy + int((r + 4) * math.sin(rad))
        x2 = cx + int((r + 13) * math.cos(rad))
        y2 = cy + int((r + 13) * math.sin(rad))
        draw.line((x1, y1, x2, y2), fill=SUN_COLOR, width=max(3, r // 5))
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=SUN_COLOR)


def _draw_cloud(draw: ImageDraw.ImageDraw, cx: int, cy: int,
                half_w: int, half_h: int) -> None:
    draw.rounded_rectangle(
        (cx - half_w, cy - int(half_h * 0.4), cx + half_w, cy + half_h),
        radius=half_h, fill=CLOUD_COLOR)
    draw.ellipse((cx - int(half_w * 0.62), cy - half_h,
                  cx + int(half_w * 0.1), cy + int(half_h * 0.45)),
                 fill=CLOUD_COLOR)
    draw.ellipse((cx - int(half_w * 0.12), cy - int(half_h * 0.78),
                  cx + int(half_w * 0.62), cy + int(half_h * 0.45)),
                 fill=CLOUD_COLOR)


# ============================================================
# 地域予報カード
# ============================================================

CARD_W = 1000


def render_forecast_png(forecast, office_label: str) -> bytes:
    """AreaForecast をカード画像（PNG bytes）にする。"""
    version = hashlib.sha256(repr((
        forecast.office_code, forecast.report_datetime,
        forecast.fetched_at.isoformat(), forecast.days, forecast.weekly,
    )).encode()).hexdigest()
    return render_cached(f"weather:forecast:{version}",
                         lambda: _draw_forecast(forecast, office_label))


def _header(draw: ImageDraw.ImageDraw, title: str, subtitle: str) -> int:
    draw.rectangle((0, 0, CARD_W, 6), fill=ACCENT)
    font_title = _font(44)
    draw.text((28, 26), title, fill=INK, font=font_title)
    font_sub = _font(22)
    draw.text((30, 84), subtitle, fill=MUTE, font=font_sub)
    return 128


def _temp_text(temp_max, temp_min) -> list[tuple[str, tuple]]:
    parts = []
    if temp_max is not None:
        parts.append((f"{temp_max}°", TEMP_MAX_COLOR))
    if temp_max is not None and temp_min is not None:
        parts.append((" / ", MUTE))
    if temp_min is not None:
        parts.append((f"{temp_min}°", TEMP_MIN_COLOR))
    return parts


def _draw_temp_line(draw, x: int, y: int, day, font) -> None:
    cursor = x
    for text, color in _temp_text(day.temp_max, day.temp_min):
        draw.text((cursor, y), text, fill=color, font=font)
        cursor += _text_w(draw, text, font)


def _draw_forecast(forecast, office_label: str) -> bytes:
    days = list(forecast.days[:3])
    weekly = list(forecast.weekly[:7])
    height = 128 + 330 + (238 if weekly else 0) + 52
    img = Image.new("RGB", (CARD_W, height), BG)
    draw = ImageDraw.Draw(img)

    report = ""
    if forecast.report_datetime is not None:
        report = forecast.report_datetime.strftime("%m/%d %H:%M発表")
    subtitle = "・".join(part for part in (
        office_label,
        forecast.publishing_office,
        report,
        f"取得 {forecast.fetched_at.strftime('%m/%d %H:%M')}",
    ) if part)
    y = _header(draw, f"{forecast.area_name}の天気", subtitle)

    day_labels = ("今日", "明日", "明後日")
    font_label = _font(26)
    font_weather = _font(25)
    font_temp = _font(34)
    font_pop = _font(23)
    card_w, gap, x0 = 304, 16, 24
    for index, day in enumerate(days):
        x = x0 + index * (card_w + gap)
        _card_rect(draw, (x, y, x + card_w, y + 314))
        label = day_labels[index] if index < len(day_labels) else ""
        draw.text((x + 20, y + 14),
                  f"{label} {_md(day.date)}（{_weekday(day.date)}）",
                  fill=INK, font=font_label)
        from .forecast import weather_kind
        draw_weather_icon(draw, weather_kind(day.weather_code),
                          x + card_w // 2, y + 118, 104)
        lines = _wrap(draw, _clean_weather_text(day.weather_text),
                      font_weather, card_w - 32, 2)
        for line_index, line in enumerate(lines):
            draw.text((x + card_w // 2 - _text_w(draw, line, font_weather) / 2,
                       y + 178 + line_index * 32),
                      line, fill=INK, font=font_weather)
        _draw_temp_line(draw, x + 20, y + 248, day, font_temp)
        pop_text = f"降水 {day.pop}%" if day.pop is not None else "降水 —"
        draw.text((x + card_w - 20 - _text_w(draw, pop_text, font_pop),
                   y + 256), pop_text, fill=MUTE, font=font_pop)
    y += 330

    if weekly:
        font_head = _font(26)
        draw.text((28, y + 4), "週間予報", fill=INK, font=font_head)
        y += 44
        font_wd = _font(22)
        font_wt = _font(21)
        col_w = (CARD_W - 48) // 7
        for index, day in enumerate(weekly):
            x = 24 + index * col_w
            _card_rect(draw, (x + 3, y, x + col_w - 3, y + 178))
            wd = f"{_md(day.date)}（{_weekday(day.date)}）"
            draw.text((x + col_w // 2 - _text_w(draw, wd, font_wd) / 2,
                       y + 10), wd, fill=INK, font=font_wd)
            from .forecast import weather_kind
            draw_weather_icon(draw, weather_kind(day.weather_code),
                              x + col_w // 2, y + 66, 52)
            temps = []
            if day.temp_max is not None:
                temps.append((f"{day.temp_max}°", TEMP_MAX_COLOR))
            if day.temp_max is not None and day.temp_min is not None:
                temps.append(("/", MUTE))
            if day.temp_min is not None:
                temps.append((f"{day.temp_min}°", TEMP_MIN_COLOR))
            total = sum(_text_w(draw, t, font_wt) for t, _c in temps)
            cursor = x + col_w // 2 - total / 2
            for text, color in temps:
                draw.text((cursor, y + 102), text, fill=color, font=font_wt)
                cursor += _text_w(draw, text, font_wt)
            pop_text = f"{day.pop}%" if day.pop is not None else "—"
            draw.text((x + col_w // 2 - _text_w(draw, pop_text, font_wt) / 2,
                       y + 134), pop_text, fill=MUTE, font=font_wt)
        y += 194

    font_foot = _font(19)
    draw.text((28, height - 38),
              "出典: 気象庁（日本国内の予報です）", fill=MUTE, font=font_foot)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


# ============================================================
# 全国概況カード（定時投稿用）
# ============================================================

def render_national_png(entries, fetched_at: datetime) -> bytes:
    """主要地点の今日/明日を並べた全国概況カード。

    entries: [(表示名, AreaForecast), ...]
    """
    version = hashlib.sha256(repr((
        fetched_at.isoformat(),
        [(label, fc.report_datetime, fc.days[:2]) for label, fc in entries],
    )).encode()).hexdigest()
    return render_cached(f"weather:national:{version}",
                         lambda: _draw_national(entries, fetched_at))


def _draw_national(entries, fetched_at: datetime) -> bytes:
    rows = max(1, len(entries))
    height = 128 + rows * 58 + 52
    img = Image.new("RGB", (CARD_W, height), BG)
    draw = ImageDraw.Draw(img)
    subtitle = f"主要地点の今日・明日 / 取得 {fetched_at.strftime('%m/%d %H:%M')}"
    y = _header(draw, "全国の天気", subtitle)

    font_city = _font(25)
    font_temp = _font(23)
    font_pop = _font(20)
    font_day = _font(20)
    col_w = CARD_W - 48
    from .forecast import weather_kind
    for index, (label, fc) in enumerate(entries):
        x = 24
        cy = y + index * 58
        _card_rect(draw, (x + 3, cy, x + col_w - 3, cy + 50))
        draw.text((x + 16, cy + 12), label, fill=INK, font=font_city)
        for day_index, day in enumerate(list(fc.days[:2])):
            cursor = x + 130 + day_index * 400
            tag = "今日" if day_index == 0 else "明日"
            draw.text((cursor, cy + 15), tag, fill=MUTE, font=font_day)
            cursor += _text_w(draw, tag, font_day) + 4
            draw_weather_icon(draw, weather_kind(day.weather_code),
                              cursor + 17, cy + 25, 34)
            cursor += 42
            temps = []
            if day.temp_max is not None:
                temps.append((f"{day.temp_max}°", TEMP_MAX_COLOR))
            if day.temp_max is not None and day.temp_min is not None:
                temps.append(("/", MUTE))
            if day.temp_min is not None:
                temps.append((f"{day.temp_min}°", TEMP_MIN_COLOR))
            for text, color in temps:
                draw.text((cursor, cy + 13), text, fill=color, font=font_temp)
                cursor += _text_w(draw, text, font_temp)
            cursor += 6
            if day.pop is not None:
                pop_text = f"{day.pop}%"
                draw.text((cursor, cy + 15), pop_text, fill=MUTE, font=font_pop)
                cursor += _text_w(draw, pop_text, font_pop)
            cursor += 18
    font_foot = _font(19)
    draw.text((28, height - 38),
              "出典: 気象庁（日本国内の予報です）", fill=MUTE, font=font_foot)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()
