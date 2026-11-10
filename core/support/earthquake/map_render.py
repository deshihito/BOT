# -*- coding: utf-8 -*-
"""震度分布マップ画像の差し替え口（v1 では未実装）。

調査結果（2026-11-10）: 気象庁 bosai の震度分布図は、公式サイト上で
GeoJSON（地域境界）と地震ごとの詳細 JSON をクライアント側で合成して
描く仕組みで、地震ごとに安定して参照できる公式の静的画像 URL は
公開されていない。唯一の画像プロダクトである推計震度分布図は
震度5弱以上の地震だけが対象で、メッシュタイルの合成が必要なため
正規の参照とは言えない。よって v1 はマップなしで出し、将来マップを
足す場合はこの関数の戻り値（PNG バイト列）だけ差し替えれば投稿側
（render.build_post_view）がそのまま添付できるようにしてある。
"""
from __future__ import annotations

from core.support.earthquake.feed import QuakeEvent

MAP_FILENAME = "earthquake_map.png"


def render_map_png(event: QuakeEvent) -> bytes | None:
    """震度分布マップの PNG を返す。v1 では常に None（マップなし）。"""
    return None
