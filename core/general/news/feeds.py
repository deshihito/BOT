# -*- coding: utf-8 -*-
"""NHK ニュース RSS の取得と解析。

ニュースの取得元は NHK の公開 RSS（API キー不要・利用登録不要）。
カテゴリ別フィード（cat0〜cat7）をそのまま読み、見出しとリンクと
公開時刻だけを使う。記事本文は取得しない。
"""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime

import aiohttp

logger = logging.getLogger("cogs.news")

# キー → (表示名, フィード URL)。NHK のカテゴリ別 RSS。
FEEDS: dict[str, tuple[str, str]] = {
    "top": ("主要", "https://www3.nhk.or.jp/rss/news/cat0.xml"),
    "society": ("社会", "https://www3.nhk.or.jp/rss/news/cat1.xml"),
    "science": ("科学・文化", "https://www3.nhk.or.jp/rss/news/cat2.xml"),
    "politics": ("政治", "https://www3.nhk.or.jp/rss/news/cat3.xml"),
    "business": ("経済", "https://www3.nhk.or.jp/rss/news/cat4.xml"),
    "world": ("国際", "https://www3.nhk.or.jp/rss/news/cat5.xml"),
    "sports": ("スポーツ", "https://www3.nhk.or.jp/rss/news/cat6.xml"),
    "entertainment": ("エンタメ", "https://www3.nhk.or.jp/rss/news/cat7.xml"),
}

FETCH_TIMEOUT = aiohttp.ClientTimeout(total=15)
USER_AGENT = "AGOBOT news notifier (+https://agobot.app)"


@dataclass(frozen=True)
class NewsItem:
    feed_key: str
    title: str
    link: str
    published: datetime | None  # tz-aware（取れなければ None）


def parse_rss(xml_text: str, feed_key: str, limit: int = 20) -> list[NewsItem]:
    """RSS 2.0 の XML から記事を取り出す。壊れた XML では空リスト。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        logger.warning("news: RSS の解析に失敗しました feed=%s", feed_key)
        return []
    items: list[NewsItem] = []
    for node in root.iter("item"):
        title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        if not title or not link:
            continue
        published = None
        raw_date = (node.findtext("pubDate") or "").strip()
        if raw_date:
            try:
                published = parsedate_to_datetime(raw_date)
            except (TypeError, ValueError):
                published = None
        items.append(NewsItem(feed_key=feed_key, title=title, link=link,
                              published=published))
        if len(items) >= limit:
            break
    return items


async def fetch_feed(session: aiohttp.ClientSession, feed_key: str) -> list[NewsItem]:
    """1 フィードを取得する。失敗したら例外（呼び出し側で握る）。"""
    _label, url = FEEDS[feed_key]
    async with session.get(url, timeout=FETCH_TIMEOUT,
                           headers={"User-Agent": USER_AGENT}) as resp:
        resp.raise_for_status()
        text = await resp.text()
    return parse_rss(text, feed_key)


def select_new(items: list[NewsItem], seen_links: list[str],
               cap: int) -> tuple[list[NewsItem], bool]:
    """未投稿の記事を選ぶ。(投稿すべき記事（古い順）, 初回シードかどうか)

    seen が空（＝このサーバーの初回チェック）のときは、既存の記事を
    遡って投稿せず、全件を「投稿済み」として取り込むだけにする
    （bool が True）。新着が cap を超えたら新しい方を優先し、残りは
    投稿済みにして古いニュースを垂れ流さない。
    """
    if not seen_links:
        return [], True
    seen = set(seen_links)
    fresh = [item for item in items if item.link not in seen]
    # フィードは新しい順に並んでいる前提で、投稿は古い順にする。
    fresh.reverse()
    if len(fresh) > cap:
        fresh = fresh[-cap:]
    return fresh, False
