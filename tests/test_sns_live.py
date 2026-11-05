"""Tests for YouTube live notifications in SNS notify (feature gap #3)."""
from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.sns import (
    SnsItem,
    SnsNotifyMessage,
    get_sns_settings,
    parse_youtube_feed,
    sns_youtube_kind_allowed,
)

FEED_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
  <title>テストチャンネル</title>
  <author><name>テストチャンネル</name></author>
  {entries}
</feed>
"""

UPLOAD_ENTRY = """
  <entry>
    <yt:videoId>upload12345</yt:videoId>
    <title>通常の動画</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=upload12345"/>
    <published>2026-11-05T10:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/upload12345/hqdefault.jpg" width="480" height="360"/>
      <media:community>
        <media:starRating count="10" average="5.00" min="1" max="5"/>
        <media:statistics views="100"/>
      </media:community>
    </media:group>
  </entry>
"""

LIVE_ENTRY = """
  <entry>
    <yt:videoId>live1234567</yt:videoId>
    <title>ライブ配信タイトル</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=live1234567"/>
    <published>2026-11-05T11:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/live1234567/hqdefault_live.jpg" width="480" height="360"/>
      <media:community>
        <media:statistics views="3"/>
      </media:community>
    </media:group>
  </entry>
"""


def feed(*entries: str) -> bytes:
    return FEED_TEMPLATE.format(entries="".join(entries)).encode("utf-8")


class ParseYoutubeLiveTest(unittest.TestCase):
    def test_upload_is_not_live(self):
        _, items = parse_youtube_feed(feed(UPLOAD_ENTRY))
        self.assertEqual(len(items), 1)
        self.assertFalse(items[0].live)

    def test_live_thumbnail_marks_live(self):
        _, items = parse_youtube_feed(feed(LIVE_ENTRY))
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].live)

    def test_mixed_feed(self):
        _, items = parse_youtube_feed(feed(UPLOAD_ENTRY, LIVE_ENTRY))
        self.assertEqual([i.live for i in items], [False, True])


class KindFilterTest(unittest.TestCase):
    def test_defaults_allow_both(self):
        settings = {}
        self.assertTrue(sns_youtube_kind_allowed(SnsItem(id="1", title="t", url="u", live=True), settings))
        self.assertTrue(sns_youtube_kind_allowed(SnsItem(id="2", title="t", url="u", live=False), settings))

    def test_live_only(self):
        settings = {"live_enabled": True, "uploads_enabled": False}
        self.assertTrue(sns_youtube_kind_allowed(SnsItem(id="1", title="t", url="u", live=True), settings))
        self.assertFalse(sns_youtube_kind_allowed(SnsItem(id="2", title="t", url="u", live=False), settings))

    def test_uploads_only(self):
        settings = {"live_enabled": False, "uploads_enabled": True}
        self.assertFalse(sns_youtube_kind_allowed(SnsItem(id="1", title="t", url="u", live=True), settings))
        self.assertTrue(sns_youtube_kind_allowed(SnsItem(id="2", title="t", url="u", live=False), settings))


class FakeStore:
    def __init__(self, raw):
        self.raw = raw

    def get(self, guild_id, section):
        return self.raw


class SettingsTest(unittest.TestCase):
    def test_live_settings_defaults(self):
        settings = get_sns_settings(FakeStore({}), 1)
        self.assertTrue(settings["live_enabled"])
        self.assertTrue(settings["uploads_enabled"])
        self.assertIsNone(settings["live_role_id"])

    def test_live_settings_round_trip(self):
        raw = {"live_enabled": False, "uploads_enabled": False, "live_role_id": 555}
        settings = get_sns_settings(FakeStore(raw), 1)
        self.assertFalse(settings["live_enabled"])
        self.assertFalse(settings["uploads_enabled"])
        self.assertEqual(settings["live_role_id"], 555)


class LiveMessageTest(unittest.TestCase):
    def _texts(self, view):
        texts = []

        def walk(item):
            content = getattr(item, "content", None)
            if isinstance(content, str):
                texts.append(content)
            for child in getattr(item, "children", []) or []:
                walk(child)

        for item in view.children:
            walk(item)
        return texts

    def test_live_message_header_and_role(self):
        sub = {"platform": "youtube", "name": "テストチャンネル"}
        item = SnsItem(id="x", title="配信", url="https://example.com", live=True)
        view = SnsNotifyMessage(sub, item, 777)
        texts = self._texts(view)
        self.assertTrue(any("ライブ配信を開始しました" in t for t in texts), texts)
        self.assertTrue(any("<@&777>" in t for t in texts), texts)

    def test_upload_message_header(self):
        sub = {"platform": "youtube", "name": "テストチャンネル"}
        item = SnsItem(id="x", title="動画", url="https://example.com", live=False)
        view = SnsNotifyMessage(sub, item, None)
        texts = self._texts(view)
        self.assertTrue(any("新着動画" in t for t in texts), texts)


if __name__ == "__main__":
    unittest.main()
