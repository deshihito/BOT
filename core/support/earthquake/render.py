# -*- coding: utf-8 -*-
"""地震情報の投稿文面（Components V2）の組み立て。

文面の組み立て（post_lines）は Discord 非依存の純粋関数にしてあり、
EarthquakePostView がそれを TextDisplay 群へ流し込む。最大震度は
震度バッジ画像（badge.py）で大きく見せ、文面側にも必ず震度を書く
（画像が読めない環境でも情報が欠けないように）。
"""
from __future__ import annotations

import discord

from core.support.earthquake import badge as badge_mod
from core.support.earthquake import feed
from core.support.earthquake import map_render
from core.support.earthquake.feed import QuakeEvent

#: 震度別地域ブロックの最大文字数（TextDisplay 上限への配慮）。
AREAS_TEXT_LIMIT = 2000


def _occurred_text(event: QuakeEvent) -> str:
    if event.occurred_at is None:
        return event.key
    at = event.occurred_at
    return f"{at.month}月{at.day}日 {at.hour}時{at.minute:02d}分ごろ"


def post_lines(event: QuakeEvent) -> list[str]:
    """投稿の本文ブロック（Markdown 文字列のリスト）を返す。"""
    lines = [
        f"## 地震情報",
        f"最大震度 **{feed.scale_label(event.max_scale)}** の地震がありました。",
        f"発生時刻: {_occurred_text(event)}",
    ]
    if event.hypocenter_name:
        lines.append(f"震源: {event.hypocenter_name}")
    lines.append(
        f"規模: {feed.format_magnitude(event.magnitude)}"
        f" ／ 深さ: {feed.format_depth(event.depth_km)}"
    )
    tsunami = feed.tsunami_text(event.domestic_tsunami)
    if tsunami:
        lines.append(tsunami)
    return lines


def areas_text(event: QuakeEvent) -> str:
    """震度別の観測地域ブロック。無い場合は空文字。"""
    groups = feed.group_points(event.points)
    if not groups:
        return ""
    parts: list[str] = []
    for scale, names, total in groups:
        text = f"**震度{feed.scale_label(scale)}** " + "、".join(names)
        rest = total - len(names)
        if rest > 0:
            text += f" ほか{rest}件"
        parts.append(text)
    text = "\n".join(parts)
    if len(text) > AREAS_TEXT_LIMIT:
        text = text[:AREAS_TEXT_LIMIT - 1] + "…"
    return text


class EarthquakePostView(discord.ui.LayoutView):
    """チャンネルへ投稿する地震情報（Components V2、操作なし）。"""

    def __init__(self, event: QuakeEvent, *, badge_png: bytes | None,
                 map_png: bytes | None):
        super().__init__(timeout=None)
        color = feed.scale_color(event.max_scale)
        children: list[discord.ui.Item] = []
        children.append(discord.ui.TextDisplay("\n".join(post_lines(event))))

        gallery_items = []
        if badge_png is not None:
            gallery_items.append(
                discord.MediaGalleryItem(f"attachment://{badge_mod.BADGE_FILENAME}"))
        if map_png is not None:
            gallery_items.append(
                discord.MediaGalleryItem(f"attachment://{map_render.MAP_FILENAME}"))
        if gallery_items:
            children.append(discord.ui.MediaGallery(*gallery_items))

        areas = areas_text(event)
        if areas:
            children.append(discord.ui.TextDisplay(areas))

        children.append(discord.ui.Separator())
        children.append(discord.ui.TextDisplay(
            "-# 出典: 気象庁の発表（P2P地震情報を経由して取得）"))
        children.append(discord.ui.ActionRow(
            discord.ui.Button(
                label="気象庁の地震情報ページ",
                style=discord.ButtonStyle.link,
                url=feed.JMA_QUAKE_URL,
            )
        ))
        self.add_item(discord.ui.Container(
            *children, accent_colour=(color[0] << 16) | (color[1] << 8) | color[2]))


def build_post_view(event: QuakeEvent, *, badge_png: bytes | None = None,
                    map_png: bytes | None = None) -> EarthquakePostView:
    return EarthquakePostView(event, badge_png=badge_png, map_png=map_png)
