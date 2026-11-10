# -*- coding: utf-8 -*-
"""地震情報フィードのテスト。

フィクスチャは P2P地震情報 API v2（codes=551）の実レスポンス形状に
基づく。静的サンプルは 2026/11/10 06:16 橘湾の地震（DetailScale、
実 API から取得した実データの一部）を使う。
"""
import asyncio
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.support import guild_settings  # noqa: E402
from core.support.earthquake import badge as badge_mod  # noqa: E402
from core.support.earthquake import feed, render, store as eq_store  # noqa: E402
from core.support.earthquake.cog import EarthquakeCog  # noqa: E402

JST = feed.JST


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y/%m/%d %H:%M:%S")


def make_report(*, occurred: datetime, issued: datetime, issue_type: str,
                name="橘湾", magnitude=3.3, depth=10, max_scale=20,
                tsunami="None", points=None, code=551):
    return {
        "code": code,
        "id": "test-" + issue_type,
        "issue": {"correct": "None", "source": "気象庁",
                  "time": _fmt(issued), "type": issue_type},
        "earthquake": {
            "time": _fmt(occurred),
            "hypocenter": {"name": name, "magnitude": magnitude,
                           "depth": depth, "latitude": 32.7,
                           "longitude": 130.1},
            "maxScale": max_scale,
            "domesticTsunami": tsunami,
            "foreignTsunami": "Unknown",
        },
        "points": points if points is not None else [
            {"addr": "長崎市元町", "isArea": False, "pref": "長崎県", "scale": 20},
            {"addr": "諫早市東小路町", "isArea": False, "pref": "長崎県", "scale": 20},
            {"addr": "長崎市南山手", "isArea": False, "pref": "長崎県", "scale": 10},
            {"addr": "天草市有明町", "isArea": False, "pref": "熊本県", "scale": 10},
        ],
        "time": _fmt(issued),
    }


# 実 API から取得した DetailScale の実データ（要点のみ抜粋）。
REAL_DETAIL_SCALE = {
    "code": 551,
    "id": "6af238e5e88ee598246bf4a0",
    "issue": {"correct": "None", "source": "気象庁",
              "time": "2026/11/10 06:19:32", "type": "DetailScale"},
    "earthquake": {
        "time": "2026/11/10 06:16:00",
        "hypocenter": {"depth": 10, "latitude": 32.7, "longitude": 130.1,
                       "magnitude": 3.3, "name": "橘湾"},
        "maxScale": 20,
        "domesticTsunami": "None",
        "foreignTsunami": "Unknown",
    },
    "points": [
        {"addr": "長崎市元町", "isArea": False, "pref": "長崎県", "scale": 20},
        {"addr": "諫早市東小路町", "isArea": False, "pref": "長崎県", "scale": 20},
        {"addr": "長崎市南山手", "isArea": False, "pref": "長崎県", "scale": 10},
    ],
    "time": "2026/11/10 06:19:33.299",
}


class ParseTest(unittest.TestCase):
    def test_parse_real_detail_scale(self):
        event = feed.parse_report(REAL_DETAIL_SCALE)
        self.assertIsNotNone(event)
        self.assertEqual(event.key, "2026/11/10 06:16:00")
        self.assertEqual(event.hypocenter_name, "橘湾")
        self.assertEqual(event.magnitude, 3.3)
        self.assertEqual(event.depth_km, 10)
        self.assertEqual(event.max_scale, 20)
        self.assertEqual(event.domestic_tsunami, "None")
        self.assertEqual(event.level, 3)
        self.assertEqual(len(event.points), 3)
        self.assertEqual(event.occurred_at.hour, 6)

    def test_parse_rejects_other_codes_and_garbage(self):
        now = datetime.now(JST)
        foreign = make_report(occurred=now, issued=now, issue_type="Foreign",
                              code=552)
        self.assertIsNone(feed.parse_report(foreign))
        self.assertIsNone(feed.parse_report(None))
        self.assertIsNone(feed.parse_report({"code": 551}))
        self.assertEqual(feed.parse_history({"not": "a list"}), [])
        self.assertEqual(feed.parse_history([REAL_DETAIL_SCALE])[0].key,
                         "2026/11/10 06:16:00")

    def test_missing_hypocenter_becomes_none(self):
        now = datetime.now(JST)
        report = make_report(occurred=now, issued=now,
                             issue_type="ScalePrompt",
                             magnitude=-1, depth=-1, max_scale=30)
        event = feed.parse_report(report)
        self.assertIsNone(event.magnitude)
        self.assertIsNone(event.depth_km)
        self.assertEqual(event.max_scale, 30)
        self.assertEqual(feed.format_magnitude(event.magnitude), "―")
        self.assertEqual(feed.format_depth(event.depth_km), "―")
        self.assertEqual(feed.format_depth(0), "ごく浅い")


class ScaleAndTsunamiTest(unittest.TestCase):
    def test_scale_labels_and_colors(self):
        self.assertEqual(feed.scale_label(45), "5弱")
        self.assertEqual(feed.scale_label(60), "6強")
        self.assertEqual(feed.scale_label(70), "7")
        self.assertEqual(feed.scale_label(-1), "不明")
        # 気象庁の配色設定指針（表2-2）の公式色。
        self.assertEqual(feed.scale_color(70), (180, 0, 104))
        self.assertEqual(feed.scale_color(20), (0, 170, 255))
        self.assertEqual(feed.scale_color(45), (255, 230, 0))

    def test_tsunami_texts(self):
        self.assertIn("心配はありません", feed.tsunami_text("None"))
        self.assertIn("津波注意報", feed.tsunami_text("Watch"))
        self.assertIn("津波警報", feed.tsunami_text("Warning"))
        self.assertEqual(feed.tsunami_text("Unknown"), "")
        self.assertEqual(feed.tsunami_text(None), "")
        self.assertEqual(feed.tsunami_text(""), "")


class PlanPostsTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(JST).replace(microsecond=0)
        self.occurred = self.now - timedelta(minutes=3)

    def _events(self, *types_):
        return feed.parse_history([
            make_report(occurred=self.occurred,
                        issued=self.now - timedelta(minutes=1),
                        issue_type=t)
            for t in types_
        ])

    def test_prompt_alone_does_not_post_then_destination_posts_once(self):
        posts, state = feed.plan_posts(
            self._events("ScalePrompt"), {}, now=self.now, baseline=False)
        self.assertEqual(posts, [])
        posts, state = feed.plan_posts(
            self._events("ScaleAndDestination"), state,
            now=self.now, baseline=False)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].max_scale, 20)
        # 詳細報が来ても二重投稿しない。
        posts, state = feed.plan_posts(
            self._events("DetailScale"), state, now=self.now, baseline=False)
        self.assertEqual(posts, [])

    def test_baseline_never_posts(self):
        events = self._events("DetailScale")
        posts, state = feed.plan_posts(
            events, {}, now=self.now, baseline=True)
        self.assertEqual(posts, [])
        self.assertEqual(state[events[0].key]["level"], 3)
        self.assertFalse(state[events[0].key]["posted"])

    def test_stale_event_does_not_post(self):
        occurred = self.now - timedelta(hours=2)
        events = feed.parse_history([make_report(
            occurred=occurred, issued=self.now - timedelta(hours=2),
            issue_type="DetailScale")])
        posts, _state = feed.plan_posts(events, {}, now=self.now,
                                        baseline=False)
        self.assertEqual(posts, [])

    def test_unknown_scale_does_not_post(self):
        events = feed.parse_history([make_report(
            occurred=self.occurred, issued=self.now,
            issue_type="ScaleAndDestination", max_scale=-1)])
        posts, _state = feed.plan_posts(events, {}, now=self.now,
                                        baseline=False)
        self.assertEqual(posts, [])

    def test_prune_state(self):
        old = (self.now - timedelta(days=3)).isoformat()
        fresh = self.now.isoformat()
        state = {"a": {"level": 3, "posted": True, "issue_time": old},
                 "b": {"level": 3, "posted": True, "issue_time": fresh}}
        pruned = feed.prune_state(state, now=self.now)
        self.assertEqual(list(pruned), ["b"])


class GroupPointsTest(unittest.TestCase):
    def test_station_points_grouped_top_by_addr_lower_by_pref(self):
        now = datetime.now(JST)
        event = feed.parse_report(make_report(
            occurred=now, issued=now, issue_type="DetailScale"))
        groups = feed.group_points(event.points)
        self.assertEqual(groups[0][0], 20)
        self.assertIn("長崎市元町", groups[0][1])
        self.assertEqual(groups[1][0], 10)
        # 最大震度以外は都道府県へ丸める。
        self.assertEqual(set(groups[1][1]), {"長崎県", "熊本県"})

    def test_area_points_use_area_names(self):
        points = [
            feed.QuakePoint(pref="長崎県", addr="長崎県北部", scale=20,
                            is_area=True),
            feed.QuakePoint(pref="熊本県", addr="天草・芦北", scale=10,
                            is_area=True),
        ]
        groups = feed.group_points(points)
        self.assertEqual(groups[0][1], ["長崎県北部"])
        self.assertEqual(groups[1][1], ["天草・芦北"])


class SettingsStoreTest(unittest.TestCase):
    class FakeStore:
        def __init__(self, data):
            self._data = data

        def get(self, guild_id, section):
            return self._data.get((guild_id, section), {})

    def test_defaults_off_and_threshold_default(self):
        settings = eq_store.get_earthquake_settings(self.FakeStore({}), 1)
        self.assertEqual(settings, {"enabled": False, "channel_id": None,
                                    "min_scale": 30})

    def test_invalid_values_normalized(self):
        store = self.FakeStore({(7, "earthquake"): {
            "enabled": True, "channel_id": 555, "min_scale": 33}})
        settings = eq_store.get_earthquake_settings(store, 7)
        self.assertEqual(settings["min_scale"], 30)  # 不正値は既定へ
        self.assertEqual(settings["channel_id"], 555)
        store2 = self.FakeStore({(7, "earthquake"): {
            "enabled": True, "channel_id": 555, "min_scale": 45}})
        self.assertEqual(
            eq_store.get_earthquake_settings(store2, 7)["min_scale"], 45)

    def test_posted_events_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "eq.json"
            store = eq_store.PostedEvents(path)
            self.assertEqual(store.load(), {})
            state = {"2026/11/10 06:16:00": {
                "level": 3, "posted": True,
                "issue_time": "2026-11-10T06:19:32+09:00"}}
            store.save(state)
            reloaded = eq_store.PostedEvents(path)
            self.assertEqual(reloaded.load(), state)


class RenderTest(unittest.TestCase):
    def setUp(self):
        now = datetime.now(JST)
        self.event = feed.parse_report(make_report(
            occurred=now - timedelta(minutes=3), issued=now,
            issue_type="DetailScale", tsunami="Watch"))

    def test_post_lines(self):
        text = "\n".join(render.post_lines(self.event))
        self.assertIn("地震情報", text)
        self.assertIn("最大震度 **2**", text)
        self.assertIn("震源: 橘湾", text)
        self.assertIn("M3.3", text)
        self.assertIn("深さ: 10km", text)
        self.assertIn("津波注意報", text)

    def test_areas_text(self):
        text = render.areas_text(self.event)
        self.assertIn("震度2", text)
        self.assertIn("長崎市元町", text)

    def test_badge_png(self):
        png = badge_mod.render_badge_png(45)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)

    def test_post_view_accent_matches_jma_color(self):
        view = render.build_post_view(self.event, badge_png=b"png")
        container = view.children[0]
        color = feed.scale_color(20)
        self.assertEqual(container.accent_colour,
                         (color[0] << 16) | (color[1] << 8) | color[2])


class FakeSettingsStore:
    """guild_settings の差し替え用（メモリ内）。"""

    def __init__(self):
        self.data: dict[str, dict] = {}

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return dict(self.data.get(str(guild_id), {}).get(section, {}))

    def all_sections(self, section):
        return {gid: dict(sections[section])
                for gid, sections in self.data.items()
                if isinstance(sections.get(section), dict)}

    async def update(self, guild_id, section, **values):
        guild = self.data.setdefault(str(guild_id), {})
        current = guild.setdefault(section, {})
        for name, value in values.items():
            if value is None:
                current.pop(name, None)
            else:
                current[name] = value
        return dict(current)


class CogPollTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake_settings = FakeSettingsStore()
        guild_settings.set_store(self.fake_settings)
        self.addCleanup(guild_settings.set_store, None)

        self.sent: list[dict] = []
        channel = mock.MagicMock(spec=discord.TextChannel)
        channel.id = 999

        async def _send(**kwargs):
            self.sent.append(kwargs)
            return None

        channel.send = _send
        channel.permissions_for = lambda me: types.SimpleNamespace(
            view_channel=True, send_messages=True, attach_files=True)
        guild = types.SimpleNamespace(
            id=42, me=types.SimpleNamespace(),
            get_channel=lambda cid: channel if cid == 999 else None)
        bot = types.SimpleNamespace(guilds=[guild])
        self.cog = EarthquakeCog(bot)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cog.posted = eq_store.PostedEvents(
            Path(self.tmp.name) / "eq.json")
        await self.fake_settings.update(
            42, eq_store.EARTHQUAKE_SECTION,
            enabled=True, channel_id=999, min_scale=30)

        self.now = datetime.now(JST).replace(microsecond=0)
        self.occurred = self.now - timedelta(minutes=3)

    async def asyncTearDown(self):
        if self.cog._http is not None:
            await self.cog._http.close()

    def _reports(self, *types_):
        return feed.parse_history([
            make_report(occurred=self.occurred,
                        issued=self.now - timedelta(minutes=1),
                        issue_type=t)
            for t in types_
        ])

    async def test_baseline_then_new_event_posts_and_dedupes(self):
        # 起動直後（ベースライン）は既存の地震を流さない。
        self.cog._fetch_events = lambda: asyncio.sleep(
            0, result=self._reports("DetailScale"))
        posts = await self.cog._poll_once()
        self.assertEqual(posts, [])
        self.assertEqual(self.sent, [])

        # 別の新しい地震（震度4）が来たら投稿される。
        occurred2 = self.now - timedelta(minutes=1)
        reports2 = feed.parse_history([make_report(
            occurred=occurred2, issued=self.now, max_scale=40,
            issue_type="ScaleAndDestination")])
        self.cog._fetch_events = lambda: asyncio.sleep(0, result=reports2)
        posts = await self.cog._poll_once()
        self.assertEqual(len(posts), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.sent[0]["files"]), 1)  # バッジ添付

        # 同じ地震の続報では再投稿しない（しきい値 震度3 でも）。
        self.cog._fetch_events = lambda: asyncio.sleep(
            0, result=self._reports("DetailScale"))
        posts = await self.cog._poll_once()
        self.assertEqual(self.sent.__len__(), 1)

    async def test_below_guild_threshold_not_delivered(self):
        # ベースラインを終えた状態にする。
        self.cog._baseline_done = True
        reports = feed.parse_history([make_report(
            occurred=self.occurred, issued=self.now, max_scale=20,
            issue_type="ScaleAndDestination")])
        self.cog._fetch_events = lambda: asyncio.sleep(0, result=reports)
        posts = await self.cog._poll_once()
        self.assertEqual(len(posts), 1)      # 投稿判定は立つ
        self.assertEqual(self.sent, [])      # 震度2 < しきい値震度3 で不達


if __name__ == "__main__":
    unittest.main()
