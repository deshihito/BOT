# -*- coding: utf-8 -*-
"""ニュース通知（core/general/news）のテスト。

GDELT 応答の解析・新着選別・設定の正規化・ポーリング投稿を、
実ネットワークなし（フェイク取得）で検証する。
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
from core.general.news.feeds import NewsItem, parse_doc, select_new  # noqa: E402
from core.support import guild_settings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402

SAMPLE_DOC = """{"articles": [
{"url": "https://example.com/a2", "title": "新しい記事",
 "seendate": "20261112T213000Z", "domain": "example.com",
 "language": "Japanese", "sourcecountry": "JA"},
{"url": "https://example.com/a1", "title": "古い記事",
 "seendate": "20261112T200000Z", "domain": "example.com",
 "language": "Japanese", "sourcecountry": "JA"},
{"url": "https://example.com/a2", "title": "重複記事",
 "seendate": "20261112T213000Z"},
{"title": "リンクなし", "seendate": "20261112T190000Z"}
]}"""


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


class ParseDocTest(unittest.TestCase):
    def test_parse_items(self):
        items = parse_doc(SAMPLE_DOC, "top")
        # リンクのない記事と重複は落ちる
        self.assertEqual([i.link for i in items],
                         ["https://example.com/a2", "https://example.com/a1"])
        self.assertEqual(items[0].title, "新しい記事")
        # seendate は UTC。21:30Z = 翌 06:30 JST
        self.assertEqual(items[0].published.hour, 21)
        self.assertIsNotNone(items[0].published.tzinfo)

    def test_non_json_returns_empty(self):
        # GDELT はエラー時に JSON でないテキストを返すことがある
        self.assertEqual(parse_doc("Please limit your query", "top"), [])

    def test_topic_table(self):
        self.assertEqual(len(feeds_mod.TOPICS), 6)
        for key, (_label, query) in feeds_mod.TOPICS.items():
            self.assertIn("sourcelang:japanese", query, msg=key)
        self.assertIn("api.gdeltproject.org", feeds_mod.API_URL)


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
        self.assertIn("ニュース（日本のニュース）", text)
        self.assertIn("[記事a](a)", text)
        # GDELT の利用条件: 出典明記とリンク
        self.assertIn("GDELT Project", text)
        self.assertIn("https://www.gdeltproject.org/", text)


if __name__ == "__main__":
    unittest.main()


class OpenPanelTest(unittest.IsolatedAsyncioTestCase):
    """設定パネルの入口（/support の「ニュース通知」から呼ばれる）。"""

    def setUp(self):
        use_temp_settings(self)
        self.cog = NewsCog(FakeBot(FakeChannel()))

    def _interaction(self, *, admin: bool):
        from unittest.mock import AsyncMock
        import types as _types
        perms = _types.SimpleNamespace(manage_guild=admin)
        return _types.SimpleNamespace(
            guild_id=777,
            user=_types.SimpleNamespace(id=42, guild_permissions=perms),
            response=_types.SimpleNamespace(send_message=AsyncMock()),
        )

    async def test_admin_gets_settings_view(self):
        interaction = self._interaction(admin=True)
        await self.cog.open_panel(interaction)
        kwargs = interaction.response.send_message.call_args.kwargs
        self.assertIn("view", kwargs)

    async def test_non_admin_gets_summary_only(self):
        interaction = self._interaction(admin=False)
        await self.cog.open_panel(interaction)
        args, kwargs = interaction.response.send_message.call_args
        self.assertIn("OFF", args[0])
        self.assertTrue(kwargs.get("ephemeral"))
        self.assertNotIn("view", kwargs)

    def test_no_standalone_app_command(self):
        # トップレベルコマンドを増やさない方針: /news は持たない
        self.assertFalse(hasattr(self.cog, "news"))


class FakeResponse:
    def __init__(self, status, headers=None, text=""):
        self.status = status
        self.headers = headers or {}
        self._text = text

    async def text(self):
        return self._text

    def raise_for_status(self):
        if self.status >= 400:
            raise AssertionError("429 は raise_for_status より前に処理する")


class FakeSession:
    def __init__(self, response):
        self._response = response

    def get(self, url, **kwargs):
        session = self

        class _Ctx:
            async def __aenter__(self):
                return session._response

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


class FetchRateLimitTest(unittest.IsolatedAsyncioTestCase):
    async def test_429_raises_rate_limited_with_retry_after(self):
        session = FakeSession(FakeResponse(429, {"Retry-After": "120"}))
        with self.assertRaises(feeds_mod.RateLimited) as ctx:
            await feeds_mod.fetch_feed(session, "top")
        self.assertEqual(ctx.exception.retry_after, 120.0)


class PollRateLimitTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)
        self.channel = FakeChannel()
        self.calls = 0

        async def fetcher(session, feed_key):
            self.calls += 1
            raise feeds_mod.RateLimited(60)

        self.cog = NewsCog(FakeBot(self.channel), fetcher=fetcher)

    async def test_rate_limited_topic_backs_off(self):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=4242,
                           feeds=["top"], seen=["a"])
        # 429 でも例外にならず、投稿もしない
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(self.calls, 1)
        # バックオフ中は取得自体を試みない
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(self.calls, 1)


RSS_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Example Blog</title>
<item><title>古い記事</title><link>https://example.com/a1</link>
<pubDate>Wed, 12 Nov 2026 09:00:00 +0900</pubDate></item>
<item><title>新しい記事</title><link>https://example.com/a2</link>
<pubDate>Thu, 13 Nov 2026 09:00:00 +0900</pubDate></item>
<item><title>リンク無し</title></item>
</channel></rss>"""

ATOM_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Blog</title>
<entry><title>Atom記事1</title>
<link rel="self" href="https://example.com/feed.atom"/>
<link rel="alternate" href="https://example.com/e1"/>
<published>2026-11-13T01:00:00Z</published></entry>
<entry><title>Atom記事2</title><link href="https://example.com/e2"/>
<updated>2026-11-12T01:00:00Z</updated></entry>
</feed>"""


class CustomFeedParseTest(unittest.TestCase):
    def test_rss_items_newest_first(self):
        items = feeds_mod.parse_feed_xml(RSS_SAMPLE)
        self.assertEqual([i.link for i in items],
                         ["https://example.com/a2", "https://example.com/a1"])
        self.assertEqual(items[0].feed_key, "custom")

    def test_atom_items(self):
        items = feeds_mod.parse_feed_xml(ATOM_SAMPLE)
        self.assertEqual([i.link for i in items],
                         ["https://example.com/e1", "https://example.com/e2"])
        self.assertEqual(items[0].title, "Atom記事1")

    def test_garbage_returns_empty(self):
        self.assertEqual(feeds_mod.parse_feed_xml("not xml at all"), [])
        self.assertEqual(feeds_mod.parse_feed_xml("<html></html>"), [])


class CustomFeedSettingsTest(unittest.TestCase):
    def setUp(self):
        use_temp_settings(self)

    async def _settings(self, **section):
        store = guild_settings.get_store()
        await store.update(888, guild_settings.NEWS_SECTION, **section)
        return guild_settings.news_settings(888)

    def test_defaults_have_custom_fields(self):
        settings = guild_settings.news_settings(999999)
        self.assertEqual(settings["custom_feeds"], [])
        self.assertEqual(settings["custom_seen"], [])
        self.assertEqual(settings["custom_seeded"], [])


class CustomFeedSettingsAsyncTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)

    async def test_capped_at_three_and_invalid_dropped(self):
        store = guild_settings.get_store()
        await store.update(888, guild_settings.NEWS_SECTION, custom_feeds=[
            {"name": "A", "url": "https://a.example/feed"},
            {"name": "", "url": "https://b.example/feed"},
            {"name": "C", "url": "ftp://c.example/feed"},
            {"name": "D", "url": "https://d.example/feed"},
            {"name": "E", "url": "https://e.example/feed"},
            {"name": "F", "url": "https://f.example/feed"},
        ])
        settings = guild_settings.news_settings(888)
        self.assertEqual([f["name"] for f in settings["custom_feeds"]],
                         ["A", "D", "E"])


class PollCustomFeedTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)
        import core.general.news.cog as cog_mod
        self._cog_mod = cog_mod
        self._old_spacing = cog_mod.CUSTOM_FETCH_SPACING_SECONDS
        cog_mod.CUSTOM_FETCH_SPACING_SECONDS = 0
        self.addCleanup(setattr, cog_mod, "CUSTOM_FETCH_SPACING_SECONDS",
                        self._old_spacing)
        self.channel = FakeChannel()
        self.feed_items = [make_item("https://blog.example/1", 10, feed="custom"),
                           make_item("https://blog.example/2", 11, feed="custom")]

        async def fetcher(session, feed_key):
            return []

        async def custom_fetcher(session, url):
            return list(self.feed_items)

        self.cog = NewsCog(FakeBot(self.channel), fetcher=fetcher,
                           custom_fetcher=custom_fetcher)

    async def _enable(self):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=4242, feeds=["top"],
                           custom_feeds=[{"name": "公式ブログ",
                                          "url": "https://blog.example/feed"}])

    async def test_first_poll_seeds_custom_feed(self):
        await self._enable()
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(self.channel.sent, [])
        settings = guild_settings.news_settings(777)
        self.assertEqual(settings["custom_seeded"],
                         ["https://blog.example/feed"])
        self.assertEqual(len(settings["custom_seen"]), 2)

    async def test_new_custom_item_posted(self):
        await self._enable()
        await self.cog.poll_once()  # シード
        self.feed_items.insert(
            0, make_item("https://blog.example/3", 12, feed="custom"))
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 1)
        self.assertEqual(len(self.channel.sent), 1)
        self.assertIn("📡 **公式ブログ**", self.channel.sent[0])
        self.assertIn("https://blog.example/3", self.channel.sent[0])
        # 同じ記事は二度送らない
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        self.assertEqual(len(self.channel.sent), 1)


class CustomFeedPanelTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)
        from core.general.news.cog import NewsSettingsView
        self.view_cls = NewsSettingsView
        self.cog = NewsCog(FakeBot(FakeChannel()))

    def _view(self, settings=None):
        base = {"enabled": False, "channel_id": 4242, "feeds": ["top"],
                "custom_feeds": []}
        base.update(settings or {})
        return self.view_cls(self.cog, 42, 777, base)

    def _edit_interaction(self):
        from unittest.mock import AsyncMock
        import types as _types
        return _types.SimpleNamespace(
            response=_types.SimpleNamespace(is_done=lambda: True),
            edit_original_response=AsyncMock())

    async def test_modal_adds_feed(self):
        from core.general.news.cog import _CustomFeedModal
        view = self._view()
        modal = _CustomFeedModal(view)
        modal.name_input._value = "公式ブログ"
        modal.url_input._value = "https://blog.example/feed"
        await modal.on_submit(self._edit_interaction())
        self.assertEqual(view.custom_feeds,
                         [{"name": "公式ブログ",
                           "url": "https://blog.example/feed"}])

    async def test_modal_rejects_bad_url(self):
        from core.general.news.cog import _CustomFeedModal
        view = self._view()
        modal = _CustomFeedModal(view)
        modal.name_input._value = "x"
        modal.url_input._value = "ftp://example.com/feed"
        await modal.on_submit(self._edit_interaction())
        self.assertEqual(view.custom_feeds, [])
        self.assertIn("http", view.notice)

    async def test_save_persists_custom_feeds(self):
        view = self._view(settings={
            "custom_feeds": [{"name": "A", "url": "https://a.example/f"}]})
        await view._on_save(self._edit_interaction())
        settings = guild_settings.news_settings(777)
        self.assertEqual(settings["custom_feeds"],
                         [{"name": "A", "url": "https://a.example/f"}])
        self.assertTrue(settings["enabled"])

    async def test_remove_select_drops_feed(self):
        from core.general.news.cog import _CustomFeedRemoveSelect
        view = self._view(settings={"custom_feeds": [
            {"name": "A", "url": "https://a.example/f"},
            {"name": "B", "url": "https://b.example/f"}]})
        select = _CustomFeedRemoveSelect(view)
        select._values = ["0"]
        await select.callback(self._edit_interaction())
        self.assertEqual([f["name"] for f in view.custom_feeds], ["B"])


class PollSendFailureRetryTest(unittest.IsolatedAsyncioTestCase):
    """投稿に失敗した新着は既読にせず、次回に送り直すこと。"""

    def setUp(self):
        use_temp_settings(self)
        self.channel = FakeChannel()
        self.fail = False
        outer = self

        class FlakyChannel(FakeChannel):
            async def send(self, content):
                if outer.fail:
                    raise RuntimeError("送信できない")
                self.sent.append(content)

        self.channel = FlakyChannel()

        async def fetcher(session, feed_key):
            return [make_item("https://example.com/n1", 10),
                    make_item("https://example.com/n2", 11)]

        self.cog = NewsCog(FakeBot(self.channel), fetcher=fetcher)

    async def test_failed_post_is_retried_next_poll(self):
        store = guild_settings.get_store()
        await store.update(777, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=4242,
                           feeds=["top"],
                           seen=["https://example.com/n1"])
        self.fail = True
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 0)
        # 失敗した記事は既読になっていない
        settings = guild_settings.news_settings(777)
        self.assertNotIn("https://example.com/n2", settings["seen"])
        # 直ると次のチェックで届く
        self.fail = False
        posted = await self.cog.poll_once()
        self.assertEqual(posted, 1)
        self.assertEqual(len(self.channel.sent), 1)
        settings = guild_settings.news_settings(777)
        self.assertIn("https://example.com/n2", settings["seen"])
