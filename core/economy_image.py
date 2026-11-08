# -*- coding: utf-8 -*-
"""経済系パネル共通の画像レンダラ（白基調テーマで統一）。

リーダーボード基盤 core/leaderboard_image.py（PR #596）の白基調テーマと
部品（フォント・カード・進捗バー・アバター）を土台に、経済系パネル向けの
「ステータスカード／カタログ」と「価格チャート」の描画を提供する。
各パネルは行データを組み立てて渡すだけで、描画コードを各 cog に
コピペしない。描画は PIL の純関数で、再描画は board_image.render_cached
の LRU で抑える（Pi 負荷対策）。

表示層専用モジュールであり、経済ロジック（残高・価格・確率等）は
一切持たない。数値の桁区切りはカンマで統一する。
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, ImageDraw

from core.game.game.board_image import render_cached
from core.leaderboard_image import (
    BG, CARD, CARD_BORDER, INK, MUTE, TRACK, circle_avatar, draw_bar,
    fit_text, fmt_int,
)
from core.leaderboard_image import _card_rect, _darken, _font, _text_w, _tint

PANEL_W = 1000
HEADER_H = 68
SECTION_H = 52
HERO_H = 132
BANNER_H = 56

UP_COLOR = (22, 163, 74)
DOWN_COLOR = (220, 38, 38)
MA_COLOR = (245, 158, 11)
GRID = (226, 230, 238)

DEFAULT_ACCENT = (88, 101, 242)


@dataclass(frozen=True)
class PanelRow:
    """ステータス/カタログの1行。label 左、value 右、sub は label 下の補足。"""

    label: str
    value: str = ""
    sub: str = ""
    bar: float | None = None


@dataclass(frozen=True)
class PanelHero:
    """カード上部の大きな数値ブロック（残高など）。"""

    label: str
    value: str
    sub: str = ""
    user_id: int | None = None
    name: str = ""


# ============================================================
# テキスト折り返し
# ============================================================
def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int,
          max_lines: int = 3) -> list[str]:
    """幅に収まるよう文字単位で折り返す（最終行は省略記号つき）。"""
    if not text:
        return []
    lines: list[str] = []
    rest = text
    while rest and len(lines) < max_lines:
        if _text_w(draw, rest, font) <= max_w:
            lines.append(rest)
            rest = ""
            break
        lo, hi = 0, len(rest)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _text_w(draw, rest[:mid], font) <= max_w:
                lo = mid
            else:
                hi = mid - 1
        if lo <= 0:
            lo = 1
        lines.append(rest[:lo])
        rest = rest[lo:]
    if rest:
        lines[-1] = fit_text(draw, lines[-1] + "…", font, max_w)
    return lines


def _row_height(sub_lines: int) -> int:
    return 78 + 30 * max(0, sub_lines)


# ============================================================
# ステータスカード／カタログ
# ============================================================
def _version_of(title, subtitle, banner, hero, sections, avatars) -> str:
    h = hashlib.sha1()
    h.update(f"{title}|{subtitle}|{banner};".encode("utf-8", "ignore"))
    if hero is not None:
        h.update(
            f"H{hero.label}|{hero.value}|{hero.sub}|{hero.user_id}|{hero.name};"
            .encode("utf-8", "ignore"))
        data = avatars.get(hero.user_id) if hero.user_id is not None else None
        if data:
            h.update(hashlib.sha1(data).digest())
    for sec_title, rows, columns in sections:
        h.update(f"[{sec_title}|{columns}];".encode("utf-8", "ignore"))
        for row in rows:
            h.update(
                f"{row.label}|{row.value}|{row.sub}|{row.bar};"
                .encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


def _normalize_sections(sections) -> list:
    normalized = []
    for section in sections:
        if len(section) == 2:
            sec_title, rows = section
            columns = 1
        else:
            sec_title, rows, columns = section
        normalized.append((sec_title, list(rows), max(1, int(columns))))
    return normalized


def render_panel_png(*, title: str, sections, accent=DEFAULT_ACCENT,
                     subtitle: str = "", banner: str = "",
                     hero: PanelHero | None = None, avatars=None,
                     empty_text: str = "データがありません。",
                     cache_namespace: str = "economy-panel") -> bytes:
    """白基調のステータスカード/カタログ画像を描く。

    sections は [(見出し or None, [PanelRow, ...])] または
    [(見出し or None, [PanelRow, ...], 列数)]。列数2は行数が多い
    カタログ向け（並び順は左→右・上→下の読み順を維持する）。
    """
    sections = _normalize_sections(sections)
    avatars = avatars or {}
    key = (cache_namespace, title, subtitle, banner, accent,
           _version_of(title, subtitle, banner, hero, sections, avatars))
    return render_cached(key, lambda: _draw_panel(
        title=title, sections=sections, accent=accent, subtitle=subtitle,
        banner=banner, hero=hero, avatars=avatars, empty_text=empty_text))


def _layout_rows(draw, rows, columns: int, width: int, sub_font):
    """行ごとの (row, sub_lines, height) と総高さを返す。"""
    laid = []
    for row in rows:
        sub_lines = _wrap(draw, row.sub, sub_font, width - 40) if row.sub else []
        laid.append((row, sub_lines, _row_height(len(sub_lines))))
    if columns <= 1:
        return laid, sum(h for _r, _s, h in laid)
    total = 0
    for i in range(0, len(laid), columns):
        total += max(h for _r, _s, h in laid[i:i + columns])
    return laid, total


def _draw_panel(*, title, sections, accent, subtitle, banner, hero,
                avatars, empty_text) -> bytes:
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    sub_font = _font(24)
    # 先にレイアウトを確定して高さを決める。
    height = HEADER_H + 16
    if banner:
        height += BANNER_H
    if hero is not None:
        height += HERO_H
    laid_sections = []
    total_rows = 0
    for sec_title, rows, columns in sections:
        col_w = (PANEL_W - 32 - (columns - 1) * 16) // columns
        laid, rows_h = _layout_rows(probe, rows, columns, col_w, sub_font)
        sec_h = (SECTION_H if sec_title else 0)
        if rows:
            sec_h += rows_h
        elif sec_title:
            sec_h += _row_height(0)
        height += sec_h
        total_rows += len(rows)
        laid_sections.append((sec_title, laid, columns, col_w))
    if not sections:
        height += _row_height(0)

    img = Image.new("RGB", (PANEL_W, height), BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(36)
    sub_font_head = _font(24)
    draw.text((28, 16), title, font=title_font, fill=INK)
    if subtitle:
        draw.text((PANEL_W - 28 - _text_w(draw, subtitle, sub_font_head), 24),
                  subtitle, font=sub_font_head, fill=MUTE)
    draw.line((28, HEADER_H - 6, PANEL_W - 28, HEADER_H - 6),
              fill=accent, width=3)

    y = HEADER_H
    if banner:
        _card_rect(draw, (16, y + 6, PANEL_W - 16, y + BANNER_H - 4),
                   fill=_tint(accent, 0.12), radius=12, border=accent)
        banner_font = _font(27)
        shown = fit_text(draw, banner, banner_font, PANEL_W - 90)
        draw.text((36, y + 14), shown, font=banner_font,
                  fill=_darken(accent, 0.72))
        y += BANNER_H
    if hero is not None:
        _draw_hero(draw, img, hero, y, avatars=avatars, accent=accent)
        y += HERO_H
    if total_rows == 0 and hero is None and not sections:
        draw.text((28, y + 22), empty_text, font=_font(28), fill=MUTE)
    for sec_title, laid, columns, col_w in laid_sections:
        if sec_title:
            sec_font = _font(28)
            draw.text((28, y + 12), sec_title, font=sec_font,
                      fill=_darken(accent, 0.8))
            y += SECTION_H
        if not laid:
            if sec_title:
                draw.text((28, y + 18), "（なし）", font=_font(26), fill=MUTE)
                y += _row_height(0)
            continue
        if columns <= 1:
            for row, sub_lines, row_h in laid:
                _draw_row(draw, row, sub_lines, 16, y, col_w, accent)
                y += row_h
        else:
            for i in range(0, len(laid), columns):
                chunk = laid[i:i + columns]
                row_h = max(h for _r, _s, h in chunk)
                for j, (row, sub_lines, _h) in enumerate(chunk):
                    _draw_row(draw, row, sub_lines,
                              16 + j * (col_w + 16), y, col_w, accent,
                              compact=True)
                y += row_h

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _draw_hero(draw, img, hero: PanelHero, y, *, avatars, accent) -> None:
    _card_rect(draw, (16, y + 6, PANEL_W - 16, y + HERO_H - 6),
               fill=CARD, radius=16, border=CARD_BORDER)
    x = 36
    if hero.user_id is not None or hero.name:
        avatar = circle_avatar(hero.user_id, hero.name or "?",
                               avatars.get(hero.user_id), 88)
        img.paste(avatar, (36, y + (HERO_H - 88) // 2), avatar)
        x = 144
        if hero.name:
            name_font = _font(28)
            shown = fit_text(draw, hero.name, name_font, 380)
            draw.text((x, y + 22), shown, font=name_font, fill=MUTE)
    label_font = _font(26)
    draw.text((x, y + 56), hero.label, font=label_font, fill=MUTE)
    value_font = _font(52)
    value = fit_text(draw, hero.value, value_font, PANEL_W - x - 36)
    draw.text((PANEL_W - 36 - _text_w(draw, value, value_font), y + 26),
              value, font=value_font, fill=INK)
    if hero.sub:
        sub_font = _font(24)
        sub = fit_text(draw, hero.sub, sub_font, PANEL_W - x - 36)
        draw.text((PANEL_W - 36 - _text_w(draw, sub, sub_font), y + 88),
                  sub, font=sub_font, fill=_darken(accent, 0.78))


def _draw_row(draw, row: PanelRow, sub_lines: list[str], x, y, w,
              accent, *, compact: bool = False) -> None:
    row_h = _row_height(len(sub_lines))
    _card_rect(draw, (x, y + 5, x + w, y + row_h - 5),
               fill=CARD, radius=12, border=CARD_BORDER)
    label_font = _font(29 if not compact else 27)
    value_font = _font(29 if not compact else 27)
    value = ""
    value_w = 0
    if row.value:
        # 値は行幅の6割まで使う（「掘れます（セッション残り N 回）」等の
        # 長めの状態文が切れないように。ラベル側にも最低限の幅を残す）。
        value = fit_text(draw, row.value, value_font,
                         max(160, int((w - 40) * 0.62)))
        value_w = _text_w(draw, value, value_font)
    label_w = w - 40 - (value_w + 16 if value else 0)
    shown = fit_text(draw, row.label, label_font, max(60, label_w))
    draw.text((x + 20, y + 14), shown, font=label_font, fill=INK)
    if value:
        vx = x + w - 20 - value_w
        vy = y + 14 if (sub_lines or row.bar is not None) else y + (row_h - 38) // 2
        draw.text((vx, vy), value, font=value_font,
                  fill=_darken(accent, 0.72) if compact else INK)
    sub_font = _font(24)
    for i, line in enumerate(sub_lines):
        draw.text((x + 20, y + 52 + i * 30), line, font=sub_font, fill=MUTE)
    if row.bar is not None:
        draw_bar(draw, x + 20, y + row_h - 22, min(360, w - 40), 10,
                 row.bar, accent)


# ============================================================
# 価格チャート
# ============================================================
def _chart_version(buckets, ma, stats) -> str:
    h = hashlib.sha1()
    for b in buckets:
        h.update(
            f"{b.get('t')}|{b.get('open')}|{b.get('high')}|{b.get('low')}"
            f"|{b.get('close')};".encode("utf-8", "ignore"))
    for v in ma:
        h.update(f"{v};".encode("utf-8", "ignore"))
    h.update(repr(sorted((stats or {}).items())).encode("utf-8", "ignore"))
    return h.hexdigest()[:16]


def render_market_chart_png(*, buckets, ma, token_name: str,
                            stats: dict | None = None,
                            cache_namespace: str = "economy-market-chart"
                            ) -> bytes | None:
    """OHLC バケットと移動平均から白基調の価格チャートを描く。

    buckets は core/general/market/market.py の ohlc_buckets の出力、
    ma は moving_average の出力（データ整形は呼び出し側＝市場ロジック側）。
    バケットが無ければ None（チャートに足る系列が無い）。
    stats には rate / change_1h / change_day / supply / circulating を
    任意で渡す（ヘッダのステータス表示用、表示専用の値）。
    """
    if not buckets:
        return None
    stats = stats or {}
    key = (cache_namespace, token_name,
           _chart_version(buckets, ma, stats))
    return render_cached(key, lambda: _draw_chart(
        buckets=buckets, ma=ma, token_name=token_name, stats=stats))


def _draw_chart(*, buckets, ma, token_name, stats) -> bytes:
    width, height = 1000, 640
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(34)
    draw.text((28, 16), f"{token_name}市場", font=title_font, fill=INK)
    draw.line((28, 62, width - 28, 62), fill=(46, 204, 113), width=3)

    # ヘッダのステータス（現在レート・変動・総供給/流通）。
    y = 76
    if stats.get("rate") is not None:
        rate_font = _font(44)
        rate_text = f"{float(stats['rate']):,.2f} AGO"
        draw.text((28, y), rate_text, font=rate_font, fill=INK)
        x = 28 + _text_w(draw, rate_text, rate_font) + 28
        change_font = _font(28)
        for label, key_name in (("1時間", "change_1h"), ("本日", "change_day")):
            change = stats.get(key_name)
            if change is None:
                continue
            text = f"{label} {float(change):+.2%}"
            color = UP_COLOR if change >= 0 else DOWN_COLOR
            draw.text((x, y + 12), text, font=change_font, fill=color)
            x += _text_w(draw, text, change_font) + 24
    supply_font = _font(24)
    supply_parts = []
    if stats.get("supply") is not None:
        supply_parts.append(f"総供給量 {fmt_int(stats['supply'])}")
    if stats.get("circulating") is not None:
        supply_parts.append(f"流通量 {fmt_int(stats['circulating'])}")
    if supply_parts:
        # 変動表示と横並びにすると桁数次第で重なるため、専用の段に置く。
        text = "／".join(supply_parts)
        draw.text((28, y + 58), text, font=supply_font, fill=MUTE)

    # チャート領域。
    plot_x0, plot_x1 = 28, width - 96
    plot_y0, plot_y1 = 176, height - 56
    _card_rect(draw, (16, plot_y0 - 12, width - 16, height - 40),
               fill=CARD, radius=14, border=CARD_BORDER)
    values = [float(b["high"]) for b in buckets] + [float(b["low"]) for b in buckets]
    hi, lo = max(values), min(values)
    pad = (hi - lo) * 0.08 or hi * 0.02 or 1.0
    hi, lo = hi + pad, lo - pad

    def to_y(v: float) -> float:
        return plot_y1 - (v - lo) / (hi - lo) * (plot_y1 - plot_y0)

    axis_font = _font(21)
    for i in range(5):
        v = lo + (hi - lo) * i / 4
        gy = to_y(v)
        draw.line((plot_x0, gy, plot_x1, gy), fill=GRID, width=1)
        label = f"{v:,.1f}"
        draw.text((plot_x1 + 10, gy - 11), label, font=axis_font, fill=MUTE)

    n = len(buckets)
    step = (plot_x1 - plot_x0) / max(1, n)
    body_w = max(2, int(step * 0.6))
    for i, b in enumerate(buckets):
        cx = plot_x0 + step * (i + 0.5)
        up = float(b["close"]) >= float(b["open"])
        color = UP_COLOR if up else DOWN_COLOR
        draw.line((cx, to_y(float(b["high"])), cx, to_y(float(b["low"]))),
                  fill=color, width=2)
        y_top = to_y(max(float(b["open"]), float(b["close"])))
        y_bot = to_y(min(float(b["open"]), float(b["close"])))
        draw.rectangle((cx - body_w / 2, y_top, cx + body_w / 2,
                        max(y_bot, y_top + 2)), fill=color)
    ma_points = [(plot_x0 + step * (i + 0.5), to_y(float(v)))
                 for i, v in enumerate(ma) if v is not None]
    if len(ma_points) >= 2:
        draw.line(ma_points, fill=MA_COLOR, width=3)
    label_step = max(1, n // 6)
    time_font = _font(21)
    for i in range(0, n, label_step):
        t = buckets[i].get("t")
        if t is None:
            continue
        try:
            label = t.strftime("%H:%M")
        except AttributeError:
            label = str(t)[11:16]
        cx = plot_x0 + step * (i + 0.5)
        draw.text((cx - _text_w(draw, label, time_font) / 2, height - 32),
                  label, font=time_font, fill=MUTE)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
