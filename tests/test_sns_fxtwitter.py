"""Tests for the X (FxTwitter / FxEmbed API) source of SNS notify."""
from __future__ import annotations

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

from core.support.sns import (
    SnsError,
    SnsFetcher,
    SnsItem,
    SnsMedia,
    SnsNotifyMessage,
    _sns_fx_base,
    parse_fx_profile,
    parse_fx_statuses,
    sns_epoch,
    sns_metrics_text,
)

OWNER = {"screen_name": "jack", "name": "jack", "id": "12"}
OTHER = {"screen_name": "willemaw", "name": "Willem", "id": "2045"}


def _status(post_id, author, *, text="hello", ts=1794030109, reposted_by=None,
            replying_to=None, quote=None, created_at="Sat Nov 07 08:41:49 +0000 2026",
            metrics=None, media=None):
    row = {
        "type": "status",
        "id": str(post_id),
        "url": f"https://x.com/{author['screen_name']}/status/{post_id}",
        "text": text,
        "created_at": created_at,
        "author": author,
        "reposted_by": reposted_by,
        "replying_to": replying_to,
    }
    if ts is not None:
        row["created_timestamp"] = ts
    if quote is not None:
        row["quote"] = quote
    if metrics is not None:
        row.update(metrics)
    if media is not None:
        row["media"] = media
    return row


# FxTwitter 実ペイロード（2026-11-08 実測）の形に合わせたメディア断片
FX_PHOTO1 = {
    "type": "photo", "id": "111",
    "url": "https://pbs.twimg.com/media/AAA.jpg?name=orig",
    "width": 4096, "height": 2732, "altText": "写真1",
}
FX_PHOTO2 = {
    "type": "photo", "id": "112",
    "url": "https://pbs.twimg.com/media/BBB.jpg?name=orig",
    "width": 4096, "height": 2731, "altText": "写真2",
}
FX_VIDEO = {
    "type": "video", "id": "222",
    "url": "https://video.twimg.com/amplify_video/222/vid/avc1/1080x1920/xxx.mp4?tag=16",
    "thumbnail_url": "https://pbs.twimg.com/media/CCC.jpg",
    "duration": 63.463, "width": 1080, "height": 1920, "format": "video/mp4",
    "formats": [{"url": "https://video.twimg.com/amplify_video/222/pl/abc.m3u8?tag=16", "container": "m3u8"}],
}
FX_GIF = {
    "type": "gif", "id": "333",
    "url": "https://video.twimg.com/tweet_video/DDD.mp4",
    "thumbnail_url": "https://pbs.twimg.com/tweet_video_thumb/DDD.jpg",
    "duration": 0, "width": 500, "height": 500, "format": "video/mp4",
    "formats": [{"url": "https://video.twimg.com/tweet_video/DDD.mp4", "bitrate": 0, "container": "mp4"}],
}

MEDIA_PAYLOAD = {
    "code": 200,
    "results": [
        # 指標 + 写真2枚
        _status(3001, OWNER, text="with photos",
                metrics={"views": 131668, "likes": 333, "reposts": 32},
                media={"all": [FX_PHOTO1, FX_PHOTO2], "photos": [FX_PHOTO1, FX_PHOTO2]}),
        # 指標（一部0）+ 動画
        _status(3002, OWNER, text="with video",
                metrics={"views": 5, "likes": 0, "reposts": 0},
                media={"all": [FX_VIDEO], "videos": [FX_VIDEO]}),
        # 指標全部0 + GIF
        _status(3003, OWNER, text="with gif",
                metrics={"views": 0, "likes": 0, "reposts": 0},
                media={"all": [FX_GIF]}),
        # 引用ポスト: 引用先のメディアは自分のメディアに含めない
        _status(3004, OWNER, text="quoting",
                metrics={"views": 42, "likes": 1, "reposts": 0},
                quote={"id": "999", "text": "quoted", "media": {"all": [FX_PHOTO1]}}),
        # 指標キーなし + media 空
        _status(3005, OWNER, text="plain", media={}),
        # 型が不正な指標・メディアは無視する
        _status(3006, OWNER, text="weird",
                metrics={"views": "123", "likes": True, "reposts": -5},
                media={"all": [{"type": "photo", "url": "not-a-url"},
                               {"type": "poll", "url": "https://example.com/x"},
                               "junk"]}),
    ],
}


STATUSES_PAYLOAD = {
    "code": 200,
    "results": [
        # 本人の通常ポスト
        _status(1001, OWNER, text="first post"),
        # 他人のポストのリポスト → 除外
        _status(1002, OTHER, reposted_by=OWNER),
        # 自己リポスト → 除外（IDは元ポストと同一で通知済み扱い）
        _status(1001, OWNER, reposted_by=OWNER),
        # 他人宛の返信 → 除外
        _status(1003, OWNER, replying_to={"screen_name": "willemaw", "status": "1000"}),
        # 自分宛（スレッドの続き）の返信 → 含める
        _status(1004, OWNER, replying_to={"screen_name": "jack", "status": "1001"}),
        # 引用ポスト → 含める
        _status(1005, OWNER, quote={"id": "999", "text": "quoted"}),
        # created_timestamp が無い場合は created_at にフォールバック
        _status(1006, OWNER, ts=None),
    ],
    "cursor": {"top": "t", "bottom": "b"},
}

PROFILE_PAYLOAD = {
    "code": 200,
    "message": "OK",
    "user": {"id": "12", "screen_name": "jack", "name": "jack dorsey", "protected": False},
}


class ParseFxStatusesTest(unittest.TestCase):
    def test_keeps_only_own_posts(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        self.assertEqual([i.id for i in items], ["1001", "1004", "1005", "1006"])

    def test_fields_and_timestamp_priority(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        first = items[0]
        self.assertEqual(first.title, "first post")
        self.assertEqual(first.url, "https://x.com/jack/status/1001")
        self.assertEqual(first.author, "jack")
        # created_timestamp (unix秒) が ISO8601 になり、sns_epoch で戻せる
        self.assertEqual(sns_epoch(first.published), 1794030109)

    def test_created_at_fallback(self):
        items = parse_fx_statuses(STATUSES_PAYLOAD, "jack")
        last = items[-1]
        self.assertEqual(last.id, "1006")
        self.assertEqual(last.published, "Sat Nov 07 08:41:49 +0000 2026")

    def test_screen_name_case_insensitive(self):
        payload = {"code": 200, "results": [_status(2001, {"screen_name": "Jack", "name": "j"})]}
        items = parse_fx_statuses(payload, "jack")
        self.assertEqual([i.id for i in items], ["2001"])

    def test_non_200_code_raises(self):
        with self.assertRaises(SnsError):
            parse_fx_statuses({"code": 404, "message": "User not found"}, "jack")
        with self.assertRaises(SnsError):
            parse_fx_statuses(None, "jack")


class ParseFxMetricsMediaTest(unittest.TestCase):
    def setUp(self):
        self.items = {i.id: i for i in parse_fx_statuses(MEDIA_PAYLOAD, "jack")}

    def test_metrics_parsed(self):
        item = self.items["3001"]
        self.assertEqual(item.views, 131668)
        self.assertEqual(item.likes, 333)
        self.assertEqual(item.reposts, 32)

    def test_photo_media_parsed(self):
        item = self.items["3001"]
        self.assertEqual(
            [(m.kind, m.url) for m in item.media],
            [("photo", FX_PHOTO1["url"]), ("photo", FX_PHOTO2["url"])],
        )

    def test_video_media_uses_playable_url_and_thumbnail(self):
        item = self.items["3002"]
        self.assertEqual(len(item.media), 1)
        media = item.media[0]
        self.assertEqual(media.kind, "video")
        self.assertEqual(media.url, FX_VIDEO["url"])
        self.assertEqual(media.thumbnail, FX_VIDEO["thumbnail_url"])

    def test_gif_media_becomes_video(self):
        item = self.items["3003"]
        self.assertEqual([(m.kind, m.url) for m in item.media], [("video", FX_GIF["url"])])

    def test_quoted_media_not_included(self):
        item = self.items["3004"]
        self.assertEqual(item.media, ())
        self.assertEqual(item.views, 42)

    def test_missing_metrics_and_media(self):
        item = self.items["3005"]
        self.assertIsNone(item.views)
        self.assertIsNone(item.likes)
        self.assertIsNone(item.reposts)
        self.assertEqual(item.media, ())

    def test_invalid_metric_and_media_types_ignored(self):
        item = self.items["3006"]
        self.assertIsNone(item.views)
        self.assertIsNone(item.likes)
        self.assertIsNone(item.reposts)
        self.assertEqual(item.media, ())


class SnsMetricsTextTest(unittest.TestCase):
    def test_full_metrics_line(self):
        item = SnsItem(id="1", title="t", url="u", views=131668, likes=333, reposts=32)
        self.assertEqual(sns_metrics_text(item), "-# 👁 131,668 · ❤️ 333 · 🔁 32")

    def test_partial_metrics_show_zeroes_of_known_values(self):
        item = SnsItem(id="1", title="t", url="u", views=5, likes=0, reposts=0)
        self.assertEqual(sns_metrics_text(item), "-# 👁 5 · ❤️ 0 · 🔁 0")

    def test_missing_metric_is_omitted(self):
        item = SnsItem(id="1", title="t", url="u", views=12)
        self.assertEqual(sns_metrics_text(item), "-# 👁 12")

    def test_no_metrics_no_line(self):
        self.assertIsNone(sns_metrics_text(SnsItem(id="1", title="t", url="u")))

    def test_all_zero_metrics_no_line(self):
        item = SnsItem(id="1", title="t", url="u", views=0, likes=0, reposts=0)
        self.assertIsNone(sns_metrics_text(item))


def _walk_items(view):
    found = []

    def walk(item):
        found.append(item)
        for child in getattr(item, "children", []) or []:
            walk(child)

    for item in view.children:
        walk(item)
    return found


class XNotifyMessageTest(unittest.TestCase):
    SUB = {"platform": "x", "name": "jack"}

    def _texts(self, view):
        return [i.content for i in _walk_items(view) if isinstance(getattr(i, "content", None), str)]

    def _gallery_urls(self, view):
        urls = []
        for item in _walk_items(view):
            if isinstance(item, discord.ui.MediaGallery):
                urls.extend(g.media.url for g in item.items)
        return urls

    def test_message_with_photos_and_metrics(self):
        item = SnsItem(
            id="3001", title="with photos", url="https://x.com/jack/status/3001",
            views=131668, likes=333, reposts=32,
            media=(SnsMedia("photo", FX_PHOTO1["url"]), SnsMedia("photo", FX_PHOTO2["url"])),
        )
        view = SnsNotifyMessage(self.SUB, item, None)
        self.assertEqual(self._gallery_urls(view), [FX_PHOTO1["url"], FX_PHOTO2["url"]])
        texts = self._texts(view)
        self.assertTrue(any("👁 131,668" in t and "❤️ 333" in t and "🔁 32" in t for t in texts), texts)
        self.assertTrue(any("with photos" in t for t in texts), texts)

    def test_message_with_video_uses_playable_url(self):
        item = SnsItem(
            id="3002", title="with video", url="https://x.com/jack/status/3002",
            views=5, likes=0, reposts=0,
            media=(SnsMedia("video", FX_VIDEO["url"], FX_VIDEO["thumbnail_url"]),),
        )
        view = SnsNotifyMessage(self.SUB, item, None)
        self.assertEqual(self._gallery_urls(view), [FX_VIDEO["url"]])

    def test_plain_message_unchanged(self):
        item = SnsItem(id="1", title="plain post", url="https://x.com/jack/status/1")
        view = SnsNotifyMessage(self.SUB, item, None)
        self.assertEqual(self._gallery_urls(view), [])
        texts = self._texts(view)
        self.assertTrue(any("plain post" in t for t in texts), texts)
        self.assertFalse(any("👁" in t for t in texts), texts)


class ParseFxProfileTest(unittest.TestCase):
    def test_profile(self):
        uid, name = parse_fx_profile(PROFILE_PAYLOAD, "jack")
        self.assertEqual(uid, "12")
        self.assertEqual(name, "jack dorsey")

    def test_protected_raises(self):
        payload = {"code": 200, "user": {"id": "1", "name": "x", "protected": True}}
        with self.assertRaises(SnsError):
            parse_fx_profile(payload, "jack")

    def test_not_found_raises(self):
        with self.assertRaises(SnsError):
            parse_fx_profile({"code": 404, "message": "User not found"}, "jack")
        with self.assertRaises(SnsError):
            parse_fx_profile({"code": 200, "user": None}, "jack")


class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def read(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _FakeSession:
    """URLの一部で応答を振り分ける aiohttp セッションの代役。"""

    def __init__(self, routes):
        self.routes = routes  # list of (url_part, status, payload)

    def get(self, url, params=None, headers=None):
        for part, status, payload in self.routes:
            if part in url:
                body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                return _FakeResp(status, body)
        return _FakeResp(404, b'{"code":404,"message":"User not found"}')


class FxFetcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_lookup_returns_key_uid_name_items(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/statuses", 200, STATUSES_PAYLOAD),
            ("/2/profile/", 200, PROFILE_PAYLOAD),
        ]))
        found = await fetcher.lookup("x", "@Jack")
        self.assertEqual(found["key"], "jack")
        self.assertEqual(found["uid"], "12")
        self.assertEqual(found["name"], "jack dorsey")
        self.assertEqual([i.id for i in found["items"]], ["1001", "1004", "1005", "1006"])

    async def test_lookup_unknown_user_raises(self):
        fetcher = SnsFetcher(_FakeSession([]))
        with self.assertRaises(SnsError):
            await fetcher.lookup("x", "@nope_nope")

    async def test_poll_uses_statuses(self):
        fetcher = SnsFetcher(_FakeSession([("/statuses", 200, STATUSES_PAYLOAD)]))
        items, uid = await fetcher.poll({"platform": "x", "key": "jack"})
        self.assertIsNone(uid)
        self.assertEqual([i.id for i in items], ["1001", "1004", "1005", "1006"])

    async def test_rate_limit_raises(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/statuses", 429, {"code": 429, "message": "Rate limited"}),
        ]))
        with self.assertRaises(SnsError) as ctx:
            await fetcher.x_fx_posts("jack")
        self.assertIn("レート制限", str(ctx.exception))

    async def test_code_field_checked_even_on_http_200(self):
        fetcher = SnsFetcher(_FakeSession([
            ("/2/profile/", 200, {"code": 404, "message": "User not found"}),
        ]))
        with self.assertRaises(SnsError):
            await fetcher.x_fx_lookup_user("jack")


class FxBaseTest(unittest.TestCase):
    def test_default_base(self):
        old = os.environ.pop("FXTWITTER_API_BASE", None)
        try:
            self.assertEqual(_sns_fx_base(), "https://api.fxtwitter.com")
            os.environ["FXTWITTER_API_BASE"] = "http://localhost:8787/"
            self.assertEqual(_sns_fx_base(), "http://localhost:8787")
        finally:
            if old is None:
                os.environ.pop("FXTWITTER_API_BASE", None)
            else:
                os.environ["FXTWITTER_API_BASE"] = old


if __name__ == "__main__":
    unittest.main()
