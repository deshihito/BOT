# -*- coding: utf-8 -*-
"""GDELT DOC 2.0 API からのニュース取得と解析。

取得元は GDELT Project（世界のニュースメディアを収集したオープンデータ）。
利用条件（https://www.gdeltproject.org/about.html#termsofuse）:
データは無償・無制限に利用でき、再配布・再公開も認められる。条件は
出典（GDELT Project）の明記とサイトへのリンクのみで、API キーは不要。
投稿メッセージには毎回この出典表記を入れる（cog.format_post）。

NHK をはじめ国内メディア各社の RSS は「プログラムによる再配信」を
認めていないため使わない（2026-11-13 に公式の利用条件で確認）。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlencode

import aiohttp

logger = logging.getLogger("cogs.news")

API_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
SITE_URL = "https://www.gdeltproject.org/"

# キー → (表示名, DOC API のクエリ)。日本語メディアの記事に絞り、
# 分類は GDELT が英訳した本文へのキーワード検索で行う（NHK RSS のような
# 出版社側のカテゴリ分けではない）。クエリの前提:
# - sourcelang:japanese … 日本語の記事だけ（見出しも日本語で返る）
# - sourcecountry:JA … 日本のメディア（GDELT の国コードは FIPS 準拠）
TOPICS: dict[str, tuple[str, str]] = {
    "top": ("日本のニュース", "sourcecountry:JA sourcelang:japanese"),
    "politics": ("政治",
                 "(politics OR government OR election OR parliament OR diplomacy) "
                 "sourcelang:japanese"),
    "business": ("経済",
                 "(economy OR market OR stocks OR trade OR inflation) "
                 "sourcelang:japanese"),
    "world": ("国際",
              "(summit OR \"foreign minister\" OR ukraine OR \"middle east\" "
              "OR nato OR \"un security council\") sourcelang:japanese"),
    "sports": ("スポーツ",
               "(baseball OR soccer OR olympics OR \"world cup\" OR tennis) "
               "sourcelang:japanese"),
    "disaster": ("防災",
                 "(earthquake OR typhoon OR tsunami OR flood OR evacuation) "
                 "sourcecountry:JA sourcelang:japanese"),
}

class RateLimited(Exception):
    """GDELT が混雑している（HTTP 429）。retry_after は秒（不明なら None）。"""

    def __init__(self, retry_after: float | None = None):
        super().__init__("GDELT rate limited")
        self.retry_after = retry_after


FETCH_TIMEOUT = aiohttp.ClientTimeout(total=20)
USER_AGENT = "AGOBOT news notifier (+https://agobot.app)"
MAX_RECORDS = 25
TIMESPAN = "24h"


@dataclass(frozen=True)
class NewsItem:
    feed_key: str  # TOPICS のキー
    title: str
    link: str
    published: datetime | None  # tz-aware（取れなければ None）


def build_url(topic_key: str) -> str:
    _label, query = TOPICS[topic_key]
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": str(MAX_RECORDS),
        "sort": "datedesc",
        "timespan": TIMESPAN,
    }
    return f"{API_URL}?{urlencode(params)}"


def _parse_seendate(raw: str) -> datetime | None:
    try:
        return datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(
            tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def parse_doc(text: str, topic_key: str, limit: int = 20) -> list[NewsItem]:
    """DOC API の JSON から記事を取り出す。

    GDELT はエラー時に JSON でないテキストを返すことがあるため、
    壊れた応答では空リストを返す（次回ポーリングで再試行される）。
    """
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        logger.warning("news: GDELT の応答が JSON ではありません topic=%s",
                       topic_key)
        return []
    articles = data.get("articles") if isinstance(data, dict) else None
    if not isinstance(articles, list):
        return []
    items: list[NewsItem] = []
    seen_links: set[str] = set()
    for entry in articles:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        link = str(entry.get("url") or "").strip()
        if not title or not link or link in seen_links:
            continue
        seen_links.add(link)
        items.append(NewsItem(
            feed_key=topic_key, title=title, link=link,
            published=_parse_seendate(str(entry.get("seendate") or ""))))
        if len(items) >= limit:
            break
    return items


async def fetch_feed(session: aiohttp.ClientSession, topic_key: str) -> list[NewsItem]:
    """1 トピックを取得する。失敗したら例外（呼び出し側で握る）。

    429 は RateLimited として投げ、呼び出し側がバックオフする。
    """
    async with session.get(build_url(topic_key), timeout=FETCH_TIMEOUT,
                           headers={"User-Agent": USER_AGENT}) as resp:
        if resp.status == 429:
            retry_after = resp.headers.get("Retry-After")
            try:
                retry_after = float(retry_after) if retry_after else None
            except (TypeError, ValueError):
                retry_after = None
            raise RateLimited(retry_after)
        resp.raise_for_status()
        text = await resp.text()
    return parse_doc(text, topic_key)


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
    # API は新しい順に返す前提で、投稿は古い順にする。
    fresh.reverse()
    if len(fresh) > cap:
        fresh = fresh[-cap:]
    return fresh, False
