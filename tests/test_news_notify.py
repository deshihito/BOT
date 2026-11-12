# -*- coding: utf-8 -*-
"""ニュース通知（core/general/news）のテスト。

RSS 解析・新着選別・設定の正規化・ポーリング投稿を、実ネットワーク
なし（フェイク取得）で検証する。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.general.news import feeds as feeds_mod  # noqa: E402
from core.general.news.cog import NewsCog, format_post  # noqa: E402
from core.general.news.feeds import NewsItem, parse_rss, select_new  # noqa: E402
from core.support import guild_settings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402

SAMPLE_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>NHKニュース</title>
<item><title>新しい記事</title><link>https://example.com/a2</link>
<pubDate>Fri, 13 Nov 2026 06:30:00 +0900</pubDate>
<description>概要2</description></item>
<item><title>古い記事</title><link>https://example.com/a1</link>
<pubDate>Fri, 13 Nov 2026 05:00:00 +0900</pubDate>
<description>概要1</description></item>
<item><title>リンクなし</title><pubDate>Fri, 13 Nov 2026 04:00:00 +0900</pubDate></item>
</channel></rss>"""


def use_temp_settings(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    guild_settings.set_store(guild_settings.GuildSettings(
        KVStore("guild_settings", client=None,
                path=os.path.join(tmp.name, "kv.json"))))
    test.addCleanup(guild_settings.set_store, None)


def make_item(link: str, hour: int, feed: str = "top") -> NewsItem:
    return NewsItem(feed_key=feed, title=f"記事{link}",
                    link=link,
                    published=datetime(2026, 11, 13, hour, 0,
                                       tzinfo=timezone.utc))


class ParseRssTest(unittest.TestCase):
    def test_parse_items(self):
        items = parse_rss(SAMPLE_RSS, "top")
        # リンクのない item は落ちる
        self.assertEqual([i.link for i in items],
                         ["https://example.com/a2", "https://example.com/a1"])
        self.assertEqual(items[0].title, "新しい記事")
        self.assertEqual(items[0].published.hour, 6)
        self.assertIsNotNone(items[0].published.tzinfo)

    def test_broken_xml_returns_empty(self):
        self.assertEqual(parse_rss("<rss><channel>", "top"), [])

    def test_feed_table(self):
        self.assertEqual(len(feeds_mod.FEEDS), 8)
        for key, (_label, url) in feeds_mod.FEEDS.items():
            self.assertTrue(url.startswith("https://www3.nhk.or.jp/rss/news/"),
                            msg=key)


class SelectNewTest(unittest.TestCase):
    def test_first_run_seeds_without_posting(self):
        items = [make_item("b", 7), make_item("a", 6)]
        fresh, seeded = select_new(items, [], cap=5)
        self.assertTrue(seeded)
        self.assertEqual(fresh, [])

    def test_new_items_oldest_first(self):
        items = [make_item("c", 8), make_item("b", 7), make_item("a", 6)]
        fresh, seeded = select_new(items, ["a"], cap=5)
        self.assertFalse(seeded)
        self.assertEqual([i.link for i in fresh], ["b", "c"])

    def test_cap_keeps_newest(self):
        items = [make_item(str(n), n) for n in (5, 4, 3, 2, 1)]
        fresh, _seeded = select_new(items, ["0"], cap=2)
        self.assertEqual([i.link for i in fresh], ["4", "5"])


class NewsSettingsTest(unittest.TestCase):
    def setUp(self):
        use_temp_settings(self)

    async def _setup_guild(self):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=4242,
                           feeds=["top", "world", 123, ""],
                           seen=["x"] * 100)

    def test_defaults(self):
        settings = guild_settings.news_settings(999)
        self.assertFalse(settings["enabled"])
        self.assertIsNone(settings["channel_id"])
        self.assertEqual(settings["feeds"], ["top"])
        self.assertEqual(settings["seen"], [])

    def test_normalization(self):
        import asyncio
        asyncio.run(self._setup_guild())
        settings = guild_settings.news_settings(777)
        self.assertTrue(settings["enabled"])
        self.assertEqual(settings["channel_id"], 4242)
        self.assertEqual(settings["feeds"], ["top", "world"])  # 不正値を除去
        self.assertEqual(len(settings["seen"]), guild_settings.NEWS_SEEN_LIMIT)


class FakeChannel:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, content):
        self.sent.append(content)


class FakeBot:
    def __init__(self, channel):
        self._channel = channel

    def get_channel(self, channel_id):
        return self._channel

    async def fetch_channel(self, channel_id):
        return self._channel


class PollTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)
        self.channel = FakeChannel()
        self.feed_items = {"top": [make_item("b", 7), make_item("a", 6)]}

        async def fetcher(session, feed_key):
            return list(self.feed_items.get(feed_key, []))

        self.cog = NewsCog(FakeBot(self.channel), fetcher=fetcher)

    async def _enable(self, seen):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=4242,
                           feeds=["top"], seen=seen)

    async def test_first_poll_seeds_only(self):
        await self._enable(seen=[])
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(self.channel.sent, [])
        settings = guild_settings.news_settings(777)
        self.assertEqual(set(settings["seen"]), {"a", "b"})

    async def test_new_article_posted_once(self):
        await self._enable(seen=["a", "b"])
        self.feed_items["top"] = [make_item("c", 8), make_item("b", 7),
                                   make_item("a", 6)]
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 1)
        self.assertEqual(len(self.channel.sent), 1)
        self.assertIn("記事c", self.channel.sent[0])
        # 2回目は新着なし
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(len(self.channel.sent), 1)

    async def test_disabled_guild_skipped(self):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=False, channel_id=4242,
                           feeds=["top"], seen=[])
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(self.channel.sent, [])


class FormatPostTest(unittest.TestCase):
    def test_format(self):
        text = format_post([make_item("a", 6)], ["top"])
        self.assertIn("NHKニュース（主要）", text)
        self.assertIn("[記事a](a)", text)


if __name__ == "__main__":
    unittest.main()
