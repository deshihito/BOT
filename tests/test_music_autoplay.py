"""自動再生 v1（履歴記録＋キュー自動補充）のテスト。

- MusicHistoryStore の記録・集計・上限・永続化
- select_autoplay_candidate の優先順・ローテーション・除外（純粋関数）
- AutoplayMixin.maybe_autoplay_refill の発動条件
- スナップショットへの autoplay_enabled の含有
- パネル末尾の自動再生トグル行
"""
import asyncio
import random
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import discord

from core.vc.music import history
from core.vc.music.autoplay import AutoplayMixin, MAX_CONSECUTIVE_AUTO
from core.vc.music.loader import LoaderMixin
from core.vc.music.restore import RestoreMixin
from core.vc.music.ui import AutoplayToggleButton, build_music_panel_layout


def _track(key, *, count=1, title=None, source_input=None, is_yt=True, b62_id=None):
    return {
        "key": key,
        "input": source_input if source_input is not None else f"https://example.com/{key}",
        "title": title or key,
        "artist": None,
        "source": "youtube" if is_yt else "file",
        "is_yt": is_yt,
        "b62_id": b62_id,
        "count": count,
        "completed": 0,
        "skipped": 0,
        "first_played": 0.0,
        "last_played": 0.0,
    }


class TrackKeyTest(unittest.TestCase):
    def test_b62_wins_over_url(self):
        self.assertEqual(history.track_key("https://cdn.example.com/a.mp3", "Ab12", False), "att:Ab12")

    def test_url_key(self):
        self.assertEqual(
            history.track_key("https://www.youtube.com/watch?v=x", None, True),
            "src:https://www.youtube.com/watch?v=x",
        )

    def test_source_kind(self):
        self.assertEqual(history.source_kind("https://soundcloud.com/a/b", None, True), "soundcloud")
        self.assertEqual(history.source_kind("https://www.nicovideo.jp/watch/sm1", None, True), "niconico")
        self.assertEqual(history.source_kind("ytsearch1:hello", None, True), "youtube")
        self.assertEqual(history.source_kind("https://example.com/x.mp3", "zz", False), "file")


class HistoryStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "music_history.json"
        self.store = history.MusicHistoryStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def _play(self, user, key, title=None, at=1000.0):
        self.store.record_play(
            user, key=key, source_input=f"https://example.com/{key}",
            title=title or key, source="youtube", is_yt=True, at=at,
        )

    def test_record_play_aggregates(self):
        self._play(1, "k1")
        self._play(1, "k1", at=1001.0)
        self._play(1, "k2")
        self._play(2, "k1")
        tracks = self.store.user_tracks(1)
        self.assertEqual([t["key"] for t in tracks], ["k1", "k2"])
        self.assertEqual(tracks[0]["count"], 2)
        self.assertEqual(tracks[0]["last_played"], 1001.0)

    def test_record_outcome(self):
        self._play(1, "k1")
        self.store.record_outcome(1, "k1", completed=True)
        self.store.record_outcome(1, "k1", completed=False)
        self.store.record_outcome(1, "missing", completed=True)  # no-op
        self.store.record_outcome(999, "k1", completed=True)  # no-op
        track = self.store.user_tracks(1)[0]
        self.assertEqual(track["completed"], 1)
        self.assertEqual(track["skipped"], 1)

    def test_caps_evict_oldest(self):
        with patch.object(history, "MAX_TRACKS_PER_USER", 3), \
                patch.object(history, "MAX_RECENT_PER_USER", 2):
            for i in range(5):
                self._play(1, f"k{i}", at=1000.0 + i)
        tracks = self.store.user_tracks(1)
        self.assertEqual(len(tracks), 3)
        self.assertEqual({t["key"] for t in tracks}, {"k2", "k3", "k4"})

    def test_all_tracks_aggregates_across_users(self):
        self._play(1, "k1")
        self._play(1, "k1")
        self._play(2, "k1")
        self._play(2, "k2")
        merged = {t["key"]: t["count"] for t in self.store.all_tracks()}
        self.assertEqual(merged, {"k1": 3, "k2": 1})

    def test_clear_user(self):
        self._play(1, "k1")
        self.assertTrue(self.store.clear_user(1))
        self.assertEqual(self.store.user_tracks(1), [])
        self.assertFalse(self.store.clear_user(1))

    def test_persistence_roundtrip(self):
        self._play(7, "k1")
        self.store.flush()
        loaded = history.MusicHistoryStore(self.path)
        self.assertEqual(loaded.user_tracks(7)[0]["key"], "k1")

    def test_corrupt_file_starts_empty(self):
        self.path.write_text("{not json", encoding="utf-8")
        loaded = history.MusicHistoryStore(self.path)
        self.assertEqual(loaded.user_tracks(1), [])


class SelectCandidateTest(unittest.TestCase):
    def test_history_beats_related_and_global(self):
        picked, kind = history.select_autoplay_candidate(
            histories={10: [_track("h1", count=3)]},
            related=[_track("r1")],
            global_pool=[_track("g1", count=99)],
            rng=random.Random(0),
        )
        self.assertEqual(kind, "history")
        self.assertEqual(picked["key"], "h1")
        self.assertEqual(picked["user_id"], 10)

    def test_rotation_moves_to_next_user(self):
        histories = {10: [_track("a")], 20: [_track("b")]}
        picked, kind = history.select_autoplay_candidate(
            histories=histories, rng=random.Random(0), last_user_id=10)
        self.assertEqual((picked["key"], picked["user_id"]), ("b", 20))
        picked, kind = history.select_autoplay_candidate(
            histories=histories, rng=random.Random(0), last_user_id=20)
        self.assertEqual((picked["key"], picked["user_id"]), ("a", 10))

    def test_excluded_history_falls_through_to_related(self):
        picked, kind = history.select_autoplay_candidate(
            histories={10: [_track("h1")]},
            related=[_track("r1"), _track("r2")],
            exclude_keys={"h1", "r1"},
            rng=random.Random(0),
        )
        self.assertEqual((picked["key"], kind), ("r2", "related"))

    def test_global_fallback(self):
        picked, kind = history.select_autoplay_candidate(
            histories={}, related=[], global_pool=[_track("g1", count=5)],
            rng=random.Random(0),
        )
        self.assertEqual((picked["key"], kind), ("g1", "global"))

    def test_all_excluded_returns_none(self):
        self.assertIsNone(history.select_autoplay_candidate(
            histories={10: [_track("h1")]}, related=[_track("r1")],
            global_pool=[_track("g1")],
            exclude_keys={"h1", "r1", "g1"}, rng=random.Random(0),
        ))

    def test_weighted_pick_prefers_heavier_with_seed(self):
        items = [_track("light", count=1), _track("heavy", count=1000)]
        picked = history._weighted_pick(items, random.Random(42))
        self.assertEqual(picked["key"], "heavy")


def _member(user_id, *, bot=False, name=None):
    return types.SimpleNamespace(
        id=user_id, bot=bot,
        display_name=name or f"user{user_id}", name=name or f"user{user_id}",
    )


class _RefillCog(AutoplayMixin, LoaderMixin):
    def __init__(self, members):
        self.states = {}
        channel = types.SimpleNamespace(members=members)
        vc = types.SimpleNamespace(is_connected=lambda: True, channel=channel)
        guild = types.SimpleNamespace(voice_client=vc)
        self.bot = types.SimpleNamespace(get_guild=lambda gid: guild)

    def get_state(self, guild_id):
        if guild_id not in self.states:
            self.states[guild_id] = {
                'queue': asyncio.Queue(maxsize=50),
                'queue_requesters': [],
                'autoplay_enabled': True,
                'autoplay_stopped': False,
                'autoplay_auto_count': 0,
                'autoplay_notice_sent': False,
                'autoplay_last_user_id': None,
                'current_history_key': None,
                'session_recent_keys': [],
                'last_seed': None,
                'related_cache': {},
            }
        return self.states[guild_id]

    def _save_music_snapshot(self, guild_id):
        pass

    async def _fetch_related_tracks(self, guild_id, state):
        return []

    async def update_panel(self, guild_id):
        pass


class AutoplayRefillTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old_store = history._store
        history._store = history.MusicHistoryStore(Path(self.tmp.name) / "h.json")

    def tearDown(self):
        history._store = self._old_store
        self.tmp.cleanup()

    def _seed_history(self, user_id, key="song1"):
        history.get_store().record_play(
            user_id, key=f"src:https://youtube.com/watch?v={key}",
            source_input=f"https://youtube.com/watch?v={key}",
            title=key, source="youtube", is_yt=True,
        )

    async def test_refill_from_member_history(self):
        self._seed_history(10)
        cog = _RefillCog([_member(10), _member(20)])
        self.assertTrue(await cog.maybe_autoplay_refill(1))
        state = cog.get_state(1)
        self.assertEqual(state['queue'].qsize(), 1)
        self.assertEqual(state['autoplay_auto_count'], 1)
        meta = state['queue_requesters'][0]
        self.assertEqual(meta['user_id'], 10)
        self.assertEqual(meta['auto']['kind'], 'history')

    async def test_refill_requires_autoplay_on(self):
        self._seed_history(10)
        cog = _RefillCog([_member(10)])
        cog.get_state(1)['autoplay_enabled'] = False
        self.assertFalse(await cog.maybe_autoplay_refill(1))

    async def test_refill_requires_humans(self):
        self._seed_history(10)
        cog = _RefillCog([_member(999, bot=True)])
        self.assertFalse(await cog.maybe_autoplay_refill(1))

    async def test_refill_stops_when_stopped_flag(self):
        self._seed_history(10)
        cog = _RefillCog([_member(10)])
        cog.get_state(1)['autoplay_stopped'] = True
        self.assertFalse(await cog.maybe_autoplay_refill(1))

    async def test_refill_cap_notifies_once(self):
        self._seed_history(10)
        cog = _RefillCog([_member(10)])
        state = cog.get_state(1)
        state['autoplay_auto_count'] = MAX_CONSECUTIVE_AUTO
        cog._send_message = AsyncMock()
        self.assertFalse(await cog.maybe_autoplay_refill(1))
        self.assertTrue(state['autoplay_notice_sent'])
        self.assertFalse(await cog.maybe_autoplay_refill(1))
        self.assertEqual(cog._send_message.await_count, 0)  # 送信先が無いので通知は送られない

    async def test_refill_excludes_recently_played(self):
        self._seed_history(10)
        cog = _RefillCog([_member(10)])
        state = cog.get_state(1)
        state['session_recent_keys'] = ["src:https://youtube.com/watch?v=song1"]
        self.assertFalse(await cog.maybe_autoplay_refill(1))


class SnapshotAutoplayTest(unittest.TestCase):
    def _cog(self, state):
        cog = object.__new__(RestoreMixin)
        cog.states = {1: state}
        cog.voice_sessions = types.SimpleNamespace(get=lambda gid: None)
        cog.default_volume = 1.0
        cog.default_speed = 1.0
        cog.default_eq = "flat"
        return cog

    def _state(self, **overrides):
        state = {
            'queue': asyncio.Queue(maxsize=50),
            'current_track': None,
            'is_paused': False,
            'elapsed_offset': 0,
            'current_yt_page_url': None,
            'panel_message': None,
            'autoplay_enabled': False,
        }
        state.update(overrides)
        return state

    def test_idle_without_autoplay_has_no_snapshot(self):
        self.assertIsNone(self._cog(self._state())._serialize_music_state(1))

    def test_idle_with_autoplay_keeps_snapshot_with_flag(self):
        snapshot = self._cog(self._state(autoplay_enabled=True))._serialize_music_state(1)
        self.assertIsNotNone(snapshot)
        self.assertTrue(snapshot["autoplay_enabled"])


class AutoplayPanelRowTest(unittest.TestCase):
    def _fake_cog(self, enabled):
        state = {
            "speed": 1.0, "volume": 0.5, "eq": "default", "custom_eq_filter": None,
            "loop_mode": "off", "shuffle_enabled": False, "is_paused": False,
            "current_track": None, "queue": None, "autoplay_enabled": enabled,
        }
        return types.SimpleNamespace(get_state=lambda guild_id: state)

    def test_layout_has_autoplay_toggle_row_at_end(self):
        layout = build_music_panel_layout(self._fake_cog(False), 1, "panel text")
        container = layout.children[0]
        last_row = container.children[-1]
        self.assertIsInstance(last_row, discord.ui.ActionRow)
        button = last_row.children[0]
        self.assertIsInstance(button, AutoplayToggleButton)
        self.assertEqual(button.label, "自動再生: OFF")

    def test_layout_toggle_label_reflects_state(self):
        layout = build_music_panel_layout(self._fake_cog(True), 1, "panel text")
        button = layout.children[0].children[-1].children[0]
        self.assertEqual(button.label, "自動再生: ON")


if __name__ == "__main__":
    unittest.main()
