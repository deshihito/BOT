# -*- coding: utf-8 -*-
"""サーバー対抗ランキングの盤面描画（白基調）。

EXPボードと同じ共通レンダラ core.leaderboard_image に寄せる。行の
user_id 欄にはギルドIDを入れ、アバター画像の代わりにサーバーアイコン
（無ければ頭文字プレースホルダ）を描く。先頭ページは表彰台レイアウト。
"""
from __future__ import annotations

from core.leaderboard_image import BoardRow, render_leaderboard_png

from .scoring import PERIOD_LABELS, format_vc_compact

#: サーバー対抗のアクセント（EXP の紫と区別するティール）。
ACCENT = (32, 145, 178)


def render_board_png(page_rows: list[dict], *, period: str = "today",
                     page: int = 0, total_pages: int = 1,
                     names: dict | None = None, icons: dict | None = None,
                     highlight_guild_id=None, top_points: int = 0) -> bytes:
    """1ページ分の盤面を描く。

    names / icons は {guild_id: 表示名 / アイコン画像 bytes}。
    bar は首位 pt に対する比率（top_points が 0 のときは先頭行から取る）。
    """
    names = names or {}
    if not top_points and page_rows:
        top_points = page_rows[0]["points"] if page == 0 else 0
    board_rows = []
    for row in page_rows:
        gid = row["guild_id"]
        bar = (row["points"] / top_points) if top_points else None
        board_rows.append(BoardRow(
            user_id=gid,
            name=names.get(gid) or "サーバー",
            value=f"{row['points']:,} pt",
            # 内訳は盤面の行幅に収まる短い形にする（VC は h/m 表記）。
            sub=(f"{row['actives']:,}人・{row['messages']:,}発言"
                 f"・VC{format_vc_compact(row['vc_seconds'])}"),
            bar=bar,
        ))
    return render_leaderboard_png(
        title=f"サーバー対抗ランキング｜{PERIOD_LABELS.get(period, '今日')}",
        sections=[(None, board_rows)],
        accent=ACCENT,
        subtitle=f"{page + 1}/{total_pages} ページ",
        podium=(page == 0),
        highlight_user_id=highlight_guild_id,
        avatars=icons or {},
        empty_text="まだランキングに載っているサーバーがありません。",
        cache_namespace="server-ranking-board",
    )
