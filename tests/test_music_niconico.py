"""Tests for Niconico URL routing in music (feature gap #8).

yt-dlp measurement (2026-11-05): the bundled yt-dlp extracts nicovideo
watch pages without login (title/duration/audio formats for sm9), so only
URL routing was missing.
"""
from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from cogs.vc import niconico_url_kind


class NiconicoUrlKindTest(unittest.TestCase):
    def test_watch_urls(self):
        for url in (
            "https://www.nicovideo.jp/watch/sm9",
            "https://www.nicovideo.jp/watch/sm12345678",
            "https://www.nicovideo.jp/watch/so1234567",
            "https://www.nicovideo.jp/watch/1234567",
            "http://www.nicovideo.jp/watch/nm12345",
        ):
            self.assertEqual(niconico_url_kind(url), "track", url)

    def test_short_urls(self):
        self.assertEqual(niconico_url_kind("https://nico.ms/sm9"), "track")
        self.assertEqual(niconico_url_kind("https://nico.ms/sm12345678?ref=top"), "track")

    def test_non_niconico(self):
        for url in (
            "https://www.youtube.com/watch?v=abc",
            "https://soundcloud.com/user/track",
            "https://www.nicovideo.jp/my",
            "https://www.nicovideo.jp/watch/",
            "sm9",
            "",
            "キーワード検索",
        ):
            self.assertIsNone(niconico_url_kind(url), url)


if __name__ == "__main__":
    unittest.main()
