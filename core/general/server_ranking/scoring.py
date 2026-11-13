# -*- coding: utf-8 -*-
"""サーバー対抗ランキングの期間集計とスコア計算（純関数）。

入力はサーバー分析ストアのスナップショット
（``ServerAnalyticsStore.guild_snapshot`` の形: {"started_at", "days"}。
days は "YYYY-MM-DD" → {messages, users{uid:件数}, vc_seconds{uid:秒}, …}）。

スコアは発言・VC・活動人数の複合 pt。重みとキャップは内部定数として
ここにだけ持ち、ユーザー向け文面には出さない（水増し対策を兼ねる）。
キャップは「1日あたり」に掛ける: 単日の異常なスパイクで期間合計が
跳ねるのを抑えつつ、継続した活動はそのまま積み上がる形にする。

- 発言: 1件 = 1pt（上限 10,000件/日 ≒ 毎分7件ペースの継続発言まで素直に数える）
- VC: 延べ1分 = 1pt（上限 6,000分/日 = 延べ100人時間/日）
- 活動人数: その日に発言または VC 参加した distinct ユーザー 1人 = 5pt
  （上限 300人/日。「人数が集まる活動」に重みを置くための係数）
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Iterable, Mapping

#: 期間キーと、その日数（JST の暦日ベース。today は当日0時起点と同じ）。
PERIODS = ("today", "week", "month")
PERIOD_DAYS = {"today": 1, "week": 7, "month": 30}
PERIOD_LABELS = {"today": "今日", "week": "7日", "month": "30日"}

# スコアの重み（内部値）。
MESSAGE_WEIGHT = 1
VC_MINUTE_WEIGHT = 1
ACTIVE_WEIGHT = 5

# 1日あたりの材料キャップ（内部値）。
MESSAGE_CAP_PER_DAY = 10_000
VC_MINUTES_CAP_PER_DAY = 6_000
ACTIVE_CAP_PER_DAY = 300

PAGE_SIZE = 10


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _day_activity(day: Mapping[str, Any]) -> tuple[int, int, set]:
    """1日分の集計から (発言数, VC秒数, 活動ユーザーID集合) を取り出す。"""
    messages = max(0, _as_int(day.get("messages")))
    users = day.get("users") or {}
    vc = day.get("vc_seconds") or {}
    vc_seconds = sum(max(0, _as_int(v)) for v in vc.values()) \
        if isinstance(vc, Mapping) else 0
    active_ids = set()
    if isinstance(users, Mapping):
        active_ids.update(users.keys())
    if isinstance(vc, Mapping):
        active_ids.update(vc.keys())
    return messages, vc_seconds, active_ids


def _day_points(messages: int, vc_seconds: int, active_count: int) -> int:
    """1日分の pt（材料ごとにキャップを掛けてから重み付けする）。"""
    vc_minutes = vc_seconds // 60
    return (
        min(messages, MESSAGE_CAP_PER_DAY) * MESSAGE_WEIGHT
        + min(vc_minutes, VC_MINUTES_CAP_PER_DAY) * VC_MINUTE_WEIGHT
        + min(active_count, ACTIVE_CAP_PER_DAY) * ACTIVE_WEIGHT
    )


def aggregate_guild(snapshot: Mapping[str, Any], *, period: str,
                    today: date) -> dict[str, Any]:
    """1ギルド分の期間集計を返す。

    戻り値: {"points", "messages", "vc_seconds", "actives"}。
    messages / vc_seconds / actives は表示用の実績値（キャップ前の生値、
    actives は期間を通した distinct 人数）、points だけキャップ適用後の
    スコア。期間外の日と未来の日は数えない。
    """
    days = PERIOD_DAYS.get(period, PERIOD_DAYS["today"])
    start = today - timedelta(days=days - 1)
    raw_days = snapshot.get("days") if isinstance(snapshot, Mapping) else None
    points = 0
    messages_total = 0
    vc_total = 0
    active_union: set = set()
    if isinstance(raw_days, Mapping):
        for key, day in raw_days.items():
            try:
                day_date = date.fromisoformat(str(key))
            except ValueError:
                continue
            if day_date < start or day_date > today:
                continue
            if not isinstance(day, Mapping):
                continue
            messages, vc_seconds, active_ids = _day_activity(day)
            points += _day_points(messages, vc_seconds, len(active_ids))
            messages_total += messages
            vc_total += vc_seconds
            active_union.update(active_ids)
    return {
        "points": points,
        "messages": messages_total,
        "vc_seconds": vc_total,
        "actives": len(active_union),
    }


def build_rows(snapshots: Mapping[Any, Mapping[str, Any]], *, period: str,
               today: date, opted_out: Iterable[Any] = ()) -> list[dict]:
    """全ギルド分のランキング行を作る（pt 降順、同点は発言数→ギルドIDで安定化）。

    snapshots は {guild_id: guild_snapshot}。opted_out に含まれるギルドと
    pt が 0 のギルド（データ無し・活動無し）は載せない。
    戻り値の各行: {"guild_id", "points", "messages", "vc_seconds",
    "actives", "rank"}。
    """
    excluded = set()
    for guild_id in opted_out:
        try:
            excluded.add(int(guild_id))
        except (TypeError, ValueError):
            continue
    rows: list[dict] = []
    for raw_id, snapshot in (snapshots or {}).items():
        try:
            guild_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if guild_id in excluded or not isinstance(snapshot, Mapping):
            continue
        agg = aggregate_guild(snapshot, period=period, today=today)
        if agg["points"] <= 0:
            continue
        rows.append({"guild_id": guild_id, **agg})
    rows.sort(key=lambda r: (-r["points"], -r["messages"], r["guild_id"]))
    for i, row in enumerate(rows, start=1):
        row["rank"] = i
    return rows


def paginate(rows: list[dict], page: int, per_page: int = PAGE_SIZE):
    """(そのページの行, 総ページ数, 補正後ページ) を返す（EXPボードと同じ意味論）。"""
    total_pages = max(1, (len(rows) + per_page - 1) // per_page)
    page = min(max(int(page), 0), total_pages - 1)
    start = page * per_page
    return rows[start:start + per_page], total_pages, page


def find_row(rows: list[dict], guild_id) -> dict | None:
    """自ギルドの行を返す。圏外（未掲載）は None。"""
    try:
        gid = int(guild_id)
    except (TypeError, ValueError):
        return None
    for row in rows:
        if row["guild_id"] == gid:
            return row
    return None


def rival_info(rows: list[dict], guild_id) -> dict | None:
    """ライバル情報: 自ギルドの順位・真上のギルド・その差（pt）。

    1位のときは above_guild_id=None / gap=0。圏外は None を返す。
    """
    me = find_row(rows, guild_id)
    if me is None:
        return None
    rank = me["rank"]
    if rank == 1:
        return {"rank": 1, "above_guild_id": None, "gap": 0,
                "points": me["points"]}
    above = rows[rank - 2]
    return {"rank": rank, "above_guild_id": above["guild_id"],
            "gap": above["points"] - me["points"], "points": me["points"]}


def format_vc(seconds: int) -> str:
    """VC 延べ時間の表示（例: 8時間47分 / 45分 / 0分）。"""
    total_minutes = max(0, _as_int(seconds)) // 60
    hours, minutes = divmod(total_minutes, 60)
    if hours:
        return f"{hours}時間{minutes}分"
    return f"{minutes}分"


def format_vc_compact(seconds: int) -> str:
    """盤面の内訳行用の短い VC 表示（例: 89h / 45m / 0m）。

    盤面の行幅では「178時間30分」まで書くと内訳が切れてしまうため、
    盤面サブ表記だけ h/m 単位に畳む（embed や Web は format_vc の
    日本語表記を使う）。
    """
    total_minutes = max(0, _as_int(seconds)) // 60
    hours, minutes = divmod(total_minutes, 60)
    if hours:
        return f"{hours}h"
    return f"{minutes}m"
