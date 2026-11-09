# -*- coding: utf-8 -*-
"""サーバー分析（日次メタ集計）の収集・集計・描画・登録のテスト。

収集は本文を保存せず件数・時間帯・絵文字種別だけを数えること、
OFF ギルド・Bot・DM・webhook を記録しないこと、日次ロールオーバーと
保持期間の pruning、ヒートマップ行列の曜日振り分けを固定する。
"""
import sys
import tempfile
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.support.server_analytics import metrics, render  # noqa: E402
from core.support.server_analytics import store as sa_store  # noqa: E402
from core.support.server_analytics.cog import (  # noqa: E402
    ServerAnalyticsCog,
    ServerAnalyticsView,
)

JST = timezone(timedelta(hours=9))
# 2026-11-09 は月曜日。JST 19:00 = UTC 10:00。
MON_19_JST = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
TUE_00_JST = datetime(2026, 11, 9, 15, 30, tzinfo=timezone.utc)  # JST 11/10 0:30


def make_user(user_id, bot=False):
    return types.SimpleNamespace(id=user_id, bot=bot)


def make_message(*, guild_id=1, author_id=10, author_bot=False,
                 webhook_id=None, msg_type=discord.MessageType.default,
                 mentions=(), content="", created_at=MON_19_JST):
    return types.SimpleNamespace(
        guild=(types.SimpleNamespace(id=guild_id)
               if guild_id is not None else None),
        author=make_user(author_id, bot=author_bot),
        webhook_id=webhook_id,
        type=msg_type,
        reference=None,
        mentions=list(mentions),
        content=content,
        created_at=created_at,
    )


class ExtractEmojisTest(unittest.TestCase):
    def test_custom_and_unicode(self):
        keys = sa_store.extract_emojis("hi <:party:123> 🎉 <a:wave:456> 👍")
        self.assertEqual(keys.count(":party:"), 1)
        self.assertEqual(keys.count(":wave:"), 1)
        self.assertIn("🎉", keys)
        self.assertIn("👍", keys)

    def test_plain_text_has_none(self):
        self.assertEqual(sa_store.extract_emojis("ただの文章です"), [])
        self.assertEqual(sa_store.extract_emojis(""), [])
        self.assertEqual(sa_store.extract_emojis(None), [])


class StoreRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = sa_store.ServerAnalyticsStore(
            Path(self.tmp.name) / "analytics.json")

    def test_message_aggregation(self):
        self.store.record_message(1, 10, [20], ["🎉"], now=MON_19_JST)
        self.store.record_message(1, 10, [], ["🎉", "🎉"], now=MON_19_JST)
        self.store.record_message(1, 20, [10], [], now=MON_19_JST)
        snapshot = self.store.guild_snapshot(1)
        day = snapshot["days"]["2026-11-09"]
        self.assertEqual(day["messages"], 3)
        self.assertEqual(day["users"], {10: 2, 20: 1})
        self.assertEqual(day["mentioned"], {20: 1, 10: 1})
        self.assertEqual(day["emojis"], {"🎉": 3})
        self.assertEqual(day["hours"][19], 3)
        self.assertEqual(sum(day["hours"]), 3)

    def test_day_rollover_by_jst(self):
        self.store.record_message(1, 10, [], [], now=MON_19_JST)
        self.store.record_message(1, 10, [], [], now=TUE_00_JST)
        snapshot = self.store.guild_snapshot(1)
        self.assertEqual(snapshot["days"]["2026-11-09"]["messages"], 1)
        self.assertEqual(snapshot["days"]["2026-11-10"]["messages"], 1)
        self.assertEqual(snapshot["days"]["2026-11-10"]["hours"][0], 1)

    def test_reaction_join_vc(self):
        self.store.record_reaction(1, 10, now=MON_19_JST)
        self.store.record_reaction(1, 10, now=MON_19_JST)
        self.store.record_member_join(1, now=MON_19_JST)
        self.store.record_vc_seconds(1, 10, 3600, now=MON_19_JST)
        self.store.record_vc_seconds(1, 10, 0, now=MON_19_JST)
        day = self.store.guild_snapshot(1)["days"]["2026-11-09"]
        self.assertEqual(day["reacted"], {10: 2})
        self.assertEqual(day["new_members"], 1)
        self.assertEqual(day["vc_seconds"], {10: 3600})

    def test_retention_prunes_old_days(self):
        old = MON_19_JST - timedelta(days=sa_store.RETENTION_DAYS + 5)
        self.store.record_message(1, 10, [], [], now=old)
        self.store.record_message(1, 10, [], [], now=MON_19_JST)
        snapshot = self.store.guild_snapshot(1)
        old_key = old.astimezone(JST).date().isoformat()
        self.assertNotIn(old_key, snapshot["days"])
        self.assertIn("2026-11-09", snapshot["days"])

    def test_flush_roundtrip(self):
        self.store.record_message(1, 10, [20], ["👍"], now=MON_19_JST)
        self.store.flush()
        reloaded = sa_store.ServerAnalyticsStore(self.store._path)
        snapshot = reloaded.guild_snapshot(1)
        self.assertEqual(snapshot["days"]["2026-11-09"]["messages"], 1)
        self.assertTrue(snapshot["started_at"])

    def test_enabled_toggle_default_off(self):
        class FakeSettings:
            def __init__(self, value):
                self.value = value

            def get(self, guild_id, section):
                return self.value

        self.assertFalse(sa_store.server_analytics_enabled(
            FakeSettings({}), 1))
        self.assertFalse(sa_store.server_analytics_enabled(
            FakeSettings({"enabled": "yes"}), 1))
        self.assertTrue(sa_store.server_analytics_enabled(
            FakeSettings({"enabled": True}), 1))
        self.assertFalse(sa_store.server_analytics_enabled(
            FakeSettings({"enabled": True}), None))


def _day(messages=0, users=None, hours=None, **extra):
    day = {
        "messages": messages,
        "users": users or {},
        "vc_seconds": {},
        "new_members": 0,
        "emojis": {},
        "reacted": {},
        "mentioned": {},
        "hours": hours if hours is not None else [0] * 24,
    }
    day.update(extra)
    return day


class MetricsTest(unittest.TestCase):
    def test_overview_window_and_tops(self):
        snapshot = {"started_at": "", "days": {
            # 期間外（15日前）は含めない。
            "2026-10-26": _day(messages=999, users={99: 999}),
            "2026-11-08": _day(messages=3, users={10: 2, 20: 1},
                                emojis={"🎉": 2}, reacted={20: 4},
                                mentioned={30: 1}, new_members=1,
                                vc_seconds={10: 7200}),
            "2026-11-09": _day(messages=5, users={10: 5},
                                emojis={"🎉": 1, "👍": 7}, reacted={10: 2},
                                mentioned={30: 2}),
        }}
        ov = metrics.build_overview(snapshot, end=date(2026, 11, 9), days=14)
        self.assertEqual(ov.total_messages, 8)
        self.assertEqual(ov.active_users, 2)
        self.assertEqual(ov.voice_seconds, 7200)
        self.assertEqual(ov.new_members, 1)
        self.assertEqual(ov.top_users[0], (10, 7))
        self.assertEqual(ov.top_emojis[0], ("👍", 7))
        self.assertEqual(ov.top_reacted[0], (20, 4))
        self.assertEqual(ov.top_mentioned[0], (30, 3))
        self.assertEqual(len(ov.daily), 14)
        self.assertEqual(ov.daily[-1], (date(2026, 11, 9), 5))
        self.assertEqual(ov.recorded_days, 2)

    def test_heatmap_weekday_rows(self):
        monday_hours = [0] * 24
        monday_hours[19] = 4
        sunday_hours = [0] * 24
        sunday_hours[3] = 2
        snapshot = {"started_at": "", "days": {
            "2026-11-09": _day(messages=4, hours=monday_hours),   # 月曜
            "2026-11-08": _day(messages=2, hours=sunday_hours),   # 日曜
        }}
        matrix = metrics.build_heatmap(snapshot, end=date(2026, 11, 9),
                                       days=14)
        self.assertEqual(matrix[0][19], 4)   # 月曜19時
        self.assertEqual(matrix[6][3], 2)    # 日曜3時
        self.assertEqual(sum(sum(row) for row in matrix), 6)


class RenderTest(unittest.TestCase):
    def _overview_data(self, snapshot):
        ov = metrics.build_overview(snapshot, end=date(2026, 11, 9), days=14)
        return render.OverviewImage(
            server_name="テストサーバー", member_count=42,
            started_at="2026-11-01T00:00:00+09:00", overview=ov,
            top_user_names={10: "ユーザー10"})

    def test_overview_png(self):
        snapshot = {"started_at": "", "days": {
            "2026-11-09": _day(messages=5, users={10: 5}, emojis={"🎉": 3}),
        }}
        png = render.render_overview_png(self._overview_data(snapshot))
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)

    def test_overview_empty_png(self):
        png = render.render_overview_png(
            self._overview_data({"started_at": "", "days": {}}))
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_heatmap_png(self):
        matrix = metrics.build_heatmap(
            {"started_at": "", "days": {
                "2026-11-09": _day(messages=1, hours=[1] + [0] * 23)}},
            end=date(2026, 11, 9), days=14)
        data = render.HeatmapImage(
            server_name="テストサーバー", started_at="",
            period_start="10/27", period_end="11/9", matrix=matrix)
        png = render.render_heatmap_png(data)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)


class CogCollectionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = sa_store.ServerAnalyticsStore(
            Path(self.tmp.name) / "analytics.json")
        self.cog = ServerAnalyticsCog.__new__(ServerAnalyticsCog)
        self.cog.bot = None
        self.cog.store = self.store
        self.cog._vc_since = {}

    async def _run_message(self, message, enabled=True):
        fake_settings = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            get=lambda guild_id, section: {"enabled": enabled},
        )
        from core.support import guild_settings as gs_module
        with patch.object(gs_module, "get_store",
                          return_value=fake_settings):
            await self.cog.on_message(message)

    async def test_message_recorded_when_enabled(self):
        await self._run_message(make_message(
            mentions=[make_user(20)], content="やった 🎉"))
        day = self.store.guild_snapshot(1)["days"]["2026-11-09"]
        self.assertEqual(day["messages"], 1)
        self.assertEqual(day["mentioned"], {20: 1})
        self.assertEqual(day["emojis"], {"🎉": 1})

    async def test_message_skipped_when_disabled(self):
        await self._run_message(make_message(), enabled=False)
        self.assertFalse(self.store.has_data(1))

    async def test_bot_and_dm_and_webhook_skipped(self):
        await self._run_message(make_message(author_bot=True))
        await self._run_message(make_message(guild_id=None))
        await self._run_message(make_message(webhook_id=999))
        self.assertFalse(self.store.has_data(1))


class RegistrationTest(unittest.TestCase):
    def test_action_registered_and_ai_excluded(self):
        from core.general.action_registry import (
            SUPPORT_AI_EXCLUDED_VALUES,
            default_registry,
        )
        spec = default_registry().get("support:server_analytics")
        self.assertIsNotNone(spec)
        self.assertIn("server_analytics", SUPPORT_AI_EXCLUDED_VALUES)

    def test_genre_membership(self):
        from core.support.common import SUPPORT_ACTIONS_BY_GENRE
        values = [value for _name, value in
                  SUPPORT_ACTIONS_BY_GENRE["analysis"]]
        self.assertIn("server_analytics", values)


if __name__ == "__main__":
    unittest.main()
