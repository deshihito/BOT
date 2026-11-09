# -*- coding: utf-8 -*-
"""サーバー分析の集計計算（純関数・表示時にその場で計算）。

入力は store の guild_snapshot（{"started_at": str, "days": {...}}）。
保存形式とは独立させ、既知の小さい日次データで単体テストできるように
する。期間は終了日を含む直近 ``days`` 日（既定14日）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta


@dataclass
class Overview:
    """Overview 1枚分の集計結果。"""

    start: date
    end: date
    total_messages: int = 0
    active_users: int = 0
    voice_seconds: int = 0
    new_members: int = 0
    #: (日付, 発言数) を古い順に並べた日次推移。
    daily: list[tuple[date, int]] = field(default_factory=list)
    top_users: list[tuple[int, int]] = field(default_factory=list)
    top_emojis: list[tuple[str, int]] = field(default_factory=list)
    top_reacted: list[tuple[int, int]] = field(default_factory=list)
    top_mentioned: list[tuple[int, int]] = field(default_factory=list)
    recorded_days: int = 0


def _window(snapshot: dict, end: date, days: int) -> list[tuple[date, dict]]:
    """対象期間に含まれる (日付, day) を古い順に返す（無い日は空 dict）。"""
    raw_days = snapshot.get("days") or {}
    result: list[tuple[date, dict]] = []
    for offset in range(days - 1, -1, -1):
        day_date = end - timedelta(days=offset)
        result.append((day_date, raw_days.get(day_date.isoformat()) or {}))
    return result


def _merge_counter(window: list[tuple[date, dict]], key: str) -> dict:
    merged: dict = {}
    for _day_date, day in window:
        for item_key, count in (day.get(key) or {}).items():
            merged[item_key] = merged.get(item_key, 0) + int(count)
    return merged


def _top(counter: dict, limit: int) -> list:
    return sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[:limit]


def build_overview(snapshot: dict, *, end: date, days: int = 14,
                   top_limit: int = 5) -> Overview:
    window = _window(snapshot, end, days)
    users = _merge_counter(window, "users")
    overview = Overview(
        start=end - timedelta(days=days - 1),
        end=end,
        total_messages=sum(int(day.get("messages") or 0)
                           for _d, day in window),
        active_users=len(users),
        voice_seconds=sum(
            sum(int(v) for v in (day.get("vc_seconds") or {}).values())
            for _d, day in window),
        new_members=sum(int(day.get("new_members") or 0)
                        for _d, day in window),
        daily=[(day_date, int(day.get("messages") or 0))
               for day_date, day in window],
        top_users=_top(users, top_limit),
        top_emojis=_top(_merge_counter(window, "emojis"), top_limit),
        top_reacted=_top(_merge_counter(window, "reacted"), top_limit),
        top_mentioned=_top(_merge_counter(window, "mentioned"), top_limit),
        recorded_days=sum(1 for _d, day in window if day),
    )
    return overview


def build_heatmap(snapshot: dict, *, end: date,
                  days: int = 14) -> list[list[int]]:
    """曜日（月=0 … 日=6）× 24時間の発言件数行列を返す。

    各日の hours ヒストグラムを、その日の曜日行へ合算する。
    """
    matrix = [[0] * 24 for _ in range(7)]
    for day_date, day in _window(snapshot, end, days):
        hours = day.get("hours") or []
        row = matrix[day_date.weekday()]
        for hour in range(24):
            if hour < len(hours):
                row[hour] += int(hours[hour] or 0)
    return matrix
