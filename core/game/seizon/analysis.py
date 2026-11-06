# -*- coding: utf-8 -*-
"""生存確認（fujo）の時間帯分析（ユーザー指示 2026-11-07）。

本人の ``fujo_activities`` から「どの時間帯に検知されやすいか」を可視化する。
値は生の累計回数ではなく、**日単位統計からの平均**：まず暦日（JST）ごとに
時間帯（0–23時）別の検知回数を数え、それを「検知のあった日数」で割った
1日あたり平均検知回数を時間帯ごとに算出する。活動量の多い日が支配的に
ならないよう、1日 = 1票として均すのが狙い。

- 窓は直近 ``ANALYSIS_WINDOW_DAYS`` 日のうち**完了した暦日**だけを使う。
  今日（JST）はまだ途中の部分日なので、平均が薄まるのを避けて除外する。
- 分母は「窓の中で検知が1件以上あった暦日の数」。検知ゼロの日まで分母に
  入れると、登録だけして放置している期間に平均が潰れてしまうため。
- データが ``ANALYSIS_MIN_DAYS`` 日分未満なら分析は出さない（呼び出し側で
  「まだデータが少ない」表示に分岐する）。
- 集計は純関数（``average_hourly_profile``）。描画も bytes を返す純関数で、
  フォントは盤面画像と同じリポジトリ同梱 font.ttf 基盤を使う。
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))

ANALYSIS_WINDOW_DAYS = 30
ANALYSIS_MIN_DAYS = 3

_FONT_PATH = Path(__file__).resolve().parents[3] / "font.ttf"

_BG = (24, 26, 32)
_FG = (245, 245, 245)
_SUB = (170, 178, 190)
_GRID = (58, 63, 74)
_BAR = (46, 160, 113)
_BAR_PEAK = (241, 196, 15)


def _record_dt(record: dict) -> datetime | None:
    raw = record.get("detected_at")
    if isinstance(raw, str):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    return None


def analysis_window(now: datetime) -> tuple[date, date]:
    """分析窓 [開始日, 終了日]（どちらも JST の暦日、終了日は昨日）。"""
    today = now.astimezone(JST).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=ANALYSIS_WINDOW_DAYS - 1)
    return start, end


@dataclass(frozen=True)
class HourlyProfile:
    averages: tuple[float, ...]  # 24 要素（時 0–23 の1日あたり平均検知回数）
    days: int                    # 分母（検知のあった暦日数）
    total: int                   # 窓内の総検知回数
    peak_hour: int               # 平均が最大の時（同点は早い方）
    window_start: date
    window_end: date


def average_hourly_profile(records, now: datetime) -> HourlyProfile | None:
    """検知ログから時間帯別の1日平均プロファイルを計算する純関数。

    ``records`` は ``detected_at`` を持つ dict の列。窓（直近
    ``ANALYSIS_WINDOW_DAYS`` 日の完了した暦日、JST）の外と未来の記録は
    無視する。検知のあった日が ``ANALYSIS_MIN_DAYS`` 未満なら None。
    """
    start, end = analysis_window(now)
    daily: dict[date, list[int]] = {}
    total = 0
    for record in records:
        dt = _record_dt(record)
        if dt is None or dt > now:
            continue
        local = dt.astimezone(JST)
        day = local.date()
        if day < start or day > end:
            continue
        counts = daily.setdefault(day, [0] * 24)
        counts[local.hour] += 1
        total += 1
    days = len(daily)
    if days < ANALYSIS_MIN_DAYS:
        return None
    averages = tuple(
        sum(counts[hour] for counts in daily.values()) / days for hour in range(24)
    )
    peak_hour = max(range(24), key=lambda h: averages[h])
    return HourlyProfile(
        averages=averages,
        days=days,
        total=total,
        peak_hour=peak_hour,
        window_start=start,
        window_end=end,
    )


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.truetype(str(_FONT_PATH), size)
    except Exception:
        return ImageFont.load_default()


def render_hourly_chart(profile: HourlyProfile, *, title: str) -> bytes:
    """24本の棒グラフを PNG bytes で返す純関数。"""
    from PIL import Image, ImageDraw

    width, height = 960, 520
    margin_left, margin_right = 64, 20
    margin_top, margin_bottom = 112, 52
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    base_y = margin_top + plot_h

    img = Image.new("RGB", (width, height), _BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(30)
    label_font = _font(20)
    small_font = _font(17)

    draw.text((margin_left, 16), title, font=title_font, fill=_FG)
    sub = (
        f"{profile.window_start.isoformat()} 〜 {profile.window_end.isoformat()}"
        f"（検知のあった {profile.days} 日の平均）"
    )
    draw.text((margin_left, 58), sub, font=small_font, fill=_SUB)

    max_avg = max(profile.averages) if profile.averages else 0.0
    # 棒の上に値ラベルを置く余白として最大値に 15% のヘッドルームを持たせる
    y_max = max(max_avg * 1.15, 0.5)
    # 横グリッド 0 / 半分 / 最大 の3本と Y 軸ラベル（回/日）
    for frac in (0.0, 0.5, 1.0):
        y = base_y - plot_h * frac
        draw.line([(margin_left, y), (width - margin_right, y)], fill=_GRID, width=1)
        label = f"{y_max * frac:.1f}"
        bbox = draw.textbbox((0, 0), label, font=small_font)
        draw.text((margin_left - 10 - (bbox[2] - bbox[0]), y - 9), label, font=small_font, fill=_SUB)
    draw.text((8, margin_top - 26), "回/日", font=small_font, fill=_SUB)

    slot = plot_w / 24
    bar_w = slot * 0.68
    for hour, avg in enumerate(profile.averages):
        x0 = margin_left + slot * hour + (slot - bar_w) / 2
        x1 = x0 + bar_w
        bar_h = plot_h * (avg / y_max) if avg > 0 else 0.0
        color = _BAR_PEAK if hour == profile.peak_hour else _BAR
        if bar_h > 0:
            draw.rectangle([x0, base_y - bar_h, x1, base_y], fill=color)
            value = f"{avg:.1f}"
            bbox = draw.textbbox((0, 0), value, font=small_font)
            draw.text(
                (x0 + (bar_w - (bbox[2] - bbox[0])) / 2, base_y - bar_h - 22),
                value, font=small_font, fill=_FG,
            )
        hour_label = str(hour)
        bbox = draw.textbbox((0, 0), hour_label, font=label_font)
        draw.text(
            (margin_left + slot * hour + (slot - (bbox[2] - bbox[0])) / 2, base_y + 8),
            hour_label, font=label_font, fill=_SUB,
        )
    draw.text((width - margin_right - 30, base_y + 30), "時", font=small_font, fill=_SUB)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
