"""Tests for generic RSS subscriptions in SNS notify (feature gap #4)."""
from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.sns import (
    SNS_PLATFORMS,
    SnsError,
    get_sns_settings,
    normalize_rss_url,
    parse_generic_feed,
)

RSS20 = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>\xe3\x83\x86\xe3\x82\xb9\xe3\x83\x88\xe3\x83\x96\xe3\x83\xad\xe3\x82\xb0</title>
    <item>
      <title>\xe8\xa8\x98\xe4\xba\x8b1</title>
      <link>https://example.com/entry/1</link>
      <guid>https://example.com/entry/1</guid>
      <pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate>
      <description>body</description>
    </item>
    <item>
      <title>\xe8\xa8\x98\xe4\xba\x8b2</title>
      <link>https://example.com/entry/2</link>
      <guid isPermaLink="false">id-2</guid>
      <pubDate>Thu, 05 Nov 2026 11:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""

ATOM = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <id>tag:example.com,2026:1</id>
    <title>Atom Entry</title>
    <link rel="alternate" href="https://example.com/a/1"/>
    <published>2026-11-05T10:00:00Z</published>
  </entry>
</feed>
"""


class NormalizeRssUrlTest(unittest.TestCase):
    def test_accepts_http_https(self):
        self.assertEqual(normalize_rss_url(" https://example.com/feed "), "https://example.com/feed")
        self.assertEqual(normalize_rss_url("http://example.com/rss.xml"), "http://example.com/rss.xml")

    def test_rejects_bad_urls(self):
        for bad in ("", "example.com/feed", "ftp://example.com/feed", "javascript:alert(1)"):
            with self.assertRaises(SnsError, msg=bad):
                normalize_rss_url(bad)


class ParseGenericFeedTest(unittest.TestCase):
    def test_rss20(self):
        title, items = parse_generic_feed(RSS20)
        self.assertEqual(title, "テストブログ")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].title, "記事1")
        self.assertEqual(items[0].url, "https://example.com/entry/1")
        self.assertEqual(items[1].id, "id-2")

    def test_atom(self):
        title, items = parse_generic_feed(ATOM)
        self.assertEqual(title, "Atom Blog")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].title, "Atom Entry")
        self.assertEqual(items[0].url, "https://example.com/a/1")

    def test_invalid_xml(self):
        with self.assertRaises(SnsError):
            parse_generic_feed(b"not xml")


class FakeStore:
    def __init__(self, raw):
        self.raw = raw

    def get(self, guild_id, section):
        return self.raw


class RssSettingsTest(unittest.TestCase):
    def test_rss_platform_registered(self):
        self.assertIn("rss", SNS_PLATFORMS)

    def test_rss_sub_round_trip(self):
        raw = {
            "subs": [
                {"platform": "rss", "key": "https://example.com/feed", "name": "Blog", "seen": ["a"]},
            ]
        }
        settings = get_sns_settings(FakeStore(raw), 1)
        self.assertEqual(len(settings["subs"]), 1)
        self.assertEqual(settings["subs"][0]["platform"], "rss")
        self.assertEqual(settings["subs"][0]["key"], "https://example.com/feed")


if __name__ == "__main__":
    unittest.main()
