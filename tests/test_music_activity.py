import unittest

from core.music_activity import build_music_activity_snapshot, extract_youtube_video_id

VIDEO_ID = "dQw4w9WgXcQ"


class YouTubeVideoIdTest(unittest.TestCase):
    def test_supported_page_urls(self):
        urls = [
            f"https://www.youtube.com/watch?v={VIDEO_ID}&list=PL123",
            f"https://youtu.be/{VIDEO_ID}?t=3",
            f"https://youtube.com/shorts/{VIDEO_ID}",
            f"https://m.youtube.com/live/{VIDEO_ID}",
            f"https://www.youtube-nocookie.com/embed/{VIDEO_ID}",
        ]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(extract_youtube_video_id(url), VIDEO_ID)

    def test_rejects_untrusted_or_invalid_urls(self):
        self.assertIsNone(extract_youtube_video_id(f"https://youtube.com.evil.test/watch?v={VIDEO_ID}"))
        self.assertIsNone(extract_youtube_video_id(f"https://example.com/watch?v={VIDEO_ID}"))
        self.assertIsNone(extract_youtube_video_id("https://youtu.be/not-an-id"))
        self.assertIsNone(extract_youtube_video_id("not a URL"))
        self.assertIsNone(extract_youtube_video_id("https://youtube.com/" + "a" * 2049))


class MusicActivitySnapshotTest(unittest.TestCase):
    def make_state(self, **overrides):
        state = {
            "current_track": ("private-stream-url", "Example title", 300, "internal-id", True),
            "current_yt_page_url": f"https://www.youtube.com/watch?v={VIDEO_ID}",
            "elapsed_offset": 20,
            "start_time": 100,
            "speed": 1.5,
            "is_paused": False,
        }
        state.update(overrides)
        return state

    def test_playing_position_includes_elapsed_time_and_rate(self):
        snapshot = build_music_activity_snapshot(self.make_state(), is_playing=True, now=110)
        self.assertEqual(snapshot["status"], "playing")
        self.assertEqual(snapshot["positionSeconds"], 35)
        self.assertEqual(snapshot["playbackRate"], 1.5)
        self.assertEqual(snapshot["videoId"], VIDEO_ID)
        self.assertNotIn("private-stream-url", str(snapshot))
        self.assertNotIn("internal-id", str(snapshot))

    def test_paused_position_does_not_advance(self):
        snapshot = build_music_activity_snapshot(
            self.make_state(is_paused=True), is_playing=False, now=110
        )
        self.assertEqual(snapshot["status"], "paused")
        self.assertEqual(snapshot["positionSeconds"], 20)

    def test_non_youtube_and_invalid_youtube_links_are_unsupported(self):
        local_track = ("local-file", "Uploaded audio", 12, "id", False)
        snapshot = build_music_activity_snapshot(
            {"current_track": local_track}, is_playing=True, now=100
        )
        self.assertEqual(snapshot["status"], "unsupported")
        self.assertNotIn("videoId", snapshot)

        invalid = build_music_activity_snapshot(
            self.make_state(current_yt_page_url="https://example.com/video"),
            is_playing=True,
            now=100,
        )
        self.assertEqual(invalid["status"], "unsupported")
        self.assertNotIn("videoId", invalid)

    def test_idle_loading_and_duration_bounds(self):
        self.assertEqual(
            build_music_activity_snapshot({}, is_playing=False, now=100),
            {"status": "idle", "serverTime": 100},
        )
        loading = build_music_activity_snapshot(self.make_state(), is_playing=False, now=110)
        self.assertEqual(loading["status"], "loading")
        bounded = build_music_activity_snapshot(
            self.make_state(elapsed_offset=400, start_time=0), is_playing=False, now=110
        )
        self.assertEqual(bounded["positionSeconds"], 300)


if __name__ == "__main__":
    unittest.main()
