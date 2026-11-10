# -*- coding: utf-8 -*-
"""P2P地震情報 API（v2）の地震情報（code 551）のパースと整形。

P2P地震情報は気象庁が発表した地震情報・津波予報を JSON に加工して
無料・キーなしで再配信しているサービス。REST の /v2/history は
codes=551 で地震情報だけを新しい順に返し、各レコードが1報（震度速報
→ 震源に関する情報 → 震度・震源に関する情報 → 各地の震度に関する
情報、のいずれか）に対応する。同じ地震の続報は earthquake.time
（発生時刻）が共通するので、それを地震の同一性キーにする。

このモジュールは純粋関数のみ（HTTP も Discord も触らない）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

#: P2P地震情報 REST API（地震情報の履歴）。
HISTORY_URL = "https://api.p2pquake.net/v2/history?codes=551&limit=10"

#: 気象庁の地震情報ページ（投稿の「詳細」リンク先）。
JMA_QUAKE_URL = "https://www.jma.go.jp/bosai/map.html#contents=earthquake_map"

# ------------------------------------------------------------------
# 震度階級（P2P の maxScale / scale は「震度×10」表記:
# 10=震度1 … 40=震度4、45=5弱、50=5強、55=6弱、60=6強、70=震度7、-1=不明）
# ------------------------------------------------------------------
SCALE_LABELS: dict[int, str] = {
    10: "1",
    20: "2",
    30: "3",
    40: "4",
    45: "5弱",
    50: "5強",
    55: "6弱",
    60: "6強",
    70: "7",
}

#: しきい値として選べる震度（小さい順）。
SCALE_CHOICES: tuple[int, ...] = (10, 20, 30, 40, 45, 50, 55, 60, 70)

#: 震度の色分け。気象庁「ホームページにおける気象情報の配色に関する
#: 設定指針」（令和2年7月改訂）表2-2 の震度基本配色に準拠する
#: （公式体系への準拠であり、他サービスの画面の模倣ではない）。
SCALE_COLORS: dict[int, tuple[int, int, int]] = {
    70: (180, 0, 104),     # 震度7: 赤紫
    60: (165, 0, 33),      # 震度6強: 濃い赤
    55: (255, 40, 0),      # 震度6弱: 赤
    50: (255, 153, 0),     # 震度5強: 橙
    45: (255, 230, 0),     # 震度5弱: 黄
    40: (250, 230, 150),   # 震度4: クリーム
    30: (0, 65, 255),      # 震度3: 青
    20: (0, 170, 255),     # 震度2: 水色
    10: (242, 242, 255),   # 震度1: 白（灰）
}

#: 明るい背景色の震度ではバッジの文字を濃色にする。
SCALE_DARK_TEXT: frozenset = frozenset({10, 40, 45, 50})

#: 津波情報（earthquake.domesticTsunami）の日本語文。
#: P2P の値は気象庁電文の区分を英語化したもの。
TSUNAMI_TEXTS: dict[str, str] = {
    "None": "この地震による津波の心配はありません。",
    "Checking": "津波の有無については調査中です。",
    "NonEffective": "若干の海面変動が予想されますが、被害の心配はありません。",
    "Watch": "津波注意報が発表されています。",
    "Warning": "津波警報が発表されています。",
}

#: 報の詳しさ。投稿は「震度・震源に関する情報」（震源と最大震度が
#: そろう）以降を対象にする。震度速報だけでは震源が分からず、各地の
#: 震度（最終報）まで待つと速報性が落ちるため、その中間を投稿点にする。
REPORT_LEVELS: dict[str, int] = {
    "ScalePrompt": 1,          # 震度速報
    "Destination": 1,          # 震源に関する情報
    "ScaleAndDestination": 2,  # 震度・震源に関する情報
    "DetailScale": 3,          # 各地の震度に関する情報
}

#: 投稿対象にする報の最低レベル。
POST_LEVEL = 2


def scale_label(scale: int) -> str:
    """震度値（×10表記）を表示ラベルにする。不明値は「不明」。"""
    return SCALE_LABELS.get(scale, "不明")


def scale_color(scale: int) -> tuple[int, int, int]:
    """震度値の公式色。未知の値は震度1の色に倒す。"""
    return SCALE_COLORS.get(scale, SCALE_COLORS[10])


def tsunami_text(value: str | None) -> str:
    """津波区分の日本語文。未知・空なら空文字（表示しない）。"""
    if not value:
        return ""
    return TSUNAMI_TEXTS.get(value, "")


def _parse_jst(value) -> datetime | None:
    """P2P の日時文字列（"2026/11/10 06:16:00"、JST）を datetime にする。"""
    if not isinstance(value, str):
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=JST)
        except ValueError:
            continue
    return None


@dataclass(frozen=True)
class QuakePoint:
    """震度観測点（または地域）1件。"""

    pref: str
    addr: str
    scale: int
    is_area: bool


@dataclass(frozen=True)
class QuakeEvent:
    """1報分の地震情報。同じ地震の続報は key が共通する。"""

    key: str  # earthquake.time の文字列（発生時刻）
    occurred_at: datetime | None
    issue_time: datetime | None
    issue_type: str
    hypocenter_name: str
    magnitude: float | None  # None = 震源情報なし（P2P では -1）
    depth_km: int | None     # None = 震源情報なし。0 は「ごく浅い」
    max_scale: int           # -1 = 最大震度不明
    domestic_tsunami: str
    points: tuple[QuakePoint, ...] = field(default_factory=tuple)

    @property
    def level(self) -> int:
        return REPORT_LEVELS.get(self.issue_type, 0)


def _as_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def parse_report(item) -> QuakeEvent | None:
    """P2P の履歴レコード1件を QuakeEvent にする。対象外は None。"""
    if not isinstance(item, dict) or item.get("code") != 551:
        return None
    quake = item.get("earthquake")
    if not isinstance(quake, dict):
        return None
    key = quake.get("time")
    if not isinstance(key, str) or not key:
        return None
    issue = item.get("issue") if isinstance(item.get("issue"), dict) else {}
    hypo = quake.get("hypocenter") if isinstance(quake.get("hypocenter"), dict) else {}

    magnitude = _as_number(hypo.get("magnitude"))
    if magnitude is not None and magnitude < 0:
        magnitude = None
    depth = _as_number(hypo.get("depth"))
    depth_km = int(depth) if depth is not None and depth >= 0 else None

    max_scale = _as_number(quake.get("maxScale"))
    points: list[QuakePoint] = []
    raw_points = item.get("points")
    if isinstance(raw_points, list):
        for raw in raw_points:
            if not isinstance(raw, dict):
                continue
            scale = _as_number(raw.get("scale"))
            if scale is None:
                continue
            points.append(QuakePoint(
                pref=str(raw.get("pref") or ""),
                addr=str(raw.get("addr") or ""),
                scale=int(scale),
                is_area=bool(raw.get("isArea")),
            ))

    return QuakeEvent(
        key=key,
        occurred_at=_parse_jst(quake.get("time")),
        issue_time=_parse_jst(issue.get("time")),
        issue_type=str(issue.get("type") or ""),
        hypocenter_name=str(hypo.get("name") or ""),
        magnitude=float(magnitude) if magnitude is not None else None,
        depth_km=depth_km,
        max_scale=int(max_scale) if max_scale is not None else -1,
        domestic_tsunami=str(quake.get("domesticTsunami") or ""),
        points=tuple(points),
    )


def parse_history(payload) -> list[QuakeEvent]:
    """履歴レスポンス全体をパースする（新しい順を維持）。"""
    if not isinstance(payload, list):
        return []
    events = []
    for item in payload:
        event = parse_report(item)
        if event is not None:
            events.append(event)
    return events


def best_reports(events: list[QuakeEvent]) -> dict[str, QuakeEvent]:
    """地震ごとに最も詳しい1報へ畳む（同レベルなら発表が新しい方）。"""
    best: dict[str, QuakeEvent] = {}
    for event in events:
        current = best.get(event.key)
        if current is None:
            best[event.key] = event
            continue
        if event.level > current.level:
            best[event.key] = event
        elif event.level == current.level:
            if (event.issue_time or datetime.min.replace(tzinfo=JST)) >= \
                    (current.issue_time or datetime.min.replace(tzinfo=JST)):
                best[event.key] = event
    return best


def plan_posts(events: list[QuakeEvent], state: dict, *,
               now: datetime, baseline: bool,
               fresh_window: timedelta = timedelta(minutes=15),
               ) -> tuple[list[QuakeEvent], dict]:
    """投稿すべき地震と、更新後の既読状態を返す純粋関数。

    state は {key: {"level": int, "posted": bool, "issue_time": str}}。
    投稿条件は「震度・震源に関する情報 以降の報が初めて届いたこと」
    「最大震度が判明していること」「発表から fresh_window 以内である
    こと」の全てを満たす場合。baseline=True（起動後の初回ポーリング）
    では投稿せず、現在の報のレベルだけを既読として取り込む（再起動の
    たびに古い地震が流れる事故を防ぐ）。状態は呼び出し側が永続化する。
    """
    best = best_reports(events)
    new_state = {key: dict(value) for key, value in state.items()
                 if isinstance(value, dict)}
    posts: list[QuakeEvent] = []
    ordered = sorted(
        best.values(),
        key=lambda e: e.occurred_at or datetime.min.replace(tzinfo=JST),
    )
    for event in ordered:
        prev = new_state.get(event.key) or {}
        prev_level = prev.get("level") if isinstance(prev.get("level"), int) else 0
        prev_posted = bool(prev.get("posted"))
        fresh = (
            event.issue_time is not None
            and now - event.issue_time <= fresh_window
            and event.issue_time <= now + timedelta(minutes=1)
        )
        should_post = (
            not baseline
            and not prev_posted
            and event.level >= POST_LEVEL
            and prev_level < POST_LEVEL
            and event.max_scale > 0
            and fresh
        )
        if should_post:
            posts.append(event)
            prev_posted = True
        new_state[event.key] = {
            "level": max(prev_level, event.level),
            "posted": prev_posted,
            "issue_time": (event.issue_time.isoformat()
                           if event.issue_time else prev.get("issue_time", "")),
        }
    return posts, new_state


def prune_state(state: dict, *, now: datetime,
                keep: timedelta = timedelta(hours=48)) -> dict:
    """発表から keep を過ぎた既読状態を落とす。"""
    result = {}
    for key, value in state.items():
        if not isinstance(value, dict):
            continue
        stamp = value.get("issue_time")
        when = None
        if isinstance(stamp, str) and stamp:
            try:
                when = datetime.fromisoformat(stamp)
            except ValueError:
                when = None
        if when is not None and now - when > keep:
            continue
        result[key] = value
    return result


def group_points(points: tuple[QuakePoint, ...] | list[QuakePoint],
                 *, max_names: int = 10,
                 ) -> list[tuple[int, list[str], int]]:
    """観測点を震度の高い順に (震度, 代表地名リスト, 総件数) へまとめる。

    地域名（isArea）の報では地域名をそのまま使う。観測点の報では、
    最大震度の段だけ地点名（市区町村＋地点）を出し、それ以外は
    都道府県名に丸めて一覧性を優先する。各地名は重複を除く。
    """
    by_scale: dict[int, list[QuakePoint]] = {}
    for point in points:
        by_scale.setdefault(point.scale, []).append(point)
    if not by_scale:
        return []
    top_scale = max(by_scale)
    groups: list[tuple[int, list[str], int]] = []
    for scale in sorted(by_scale, reverse=True):
        members = by_scale[scale]
        names: list[str] = []
        seen: set[str] = set()
        for point in members:
            if point.is_area or scale == top_scale:
                name = point.addr or point.pref
            else:
                name = point.pref or point.addr
            if name and name not in seen:
                seen.add(name)
                names.append(name)
        groups.append((scale, names[:max_names], len(names)))
    return groups


def format_magnitude(magnitude: float | None) -> str:
    if magnitude is None:
        return "―"
    return f"M{magnitude:.1f}"


def format_depth(depth_km: int | None) -> str:
    if depth_km is None:
        return "―"
    if depth_km == 0:
        return "ごく浅い"
    return f"{depth_km}km"
