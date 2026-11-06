# -*- coding: utf-8 -*-
"""cogs/seizon.py（生存確認）のテスト（監査 #9）。

DB API には触らず、一時エラー判定・称号計算・ストリーク更新・
ステータス判定の境界など、純粋／差し替え可能な部分を固定する。
"""
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import cogs.seizon as seizon
from cogs.seizon import (
    FujoSurvival,
    _is_gateway_html_error,
    _is_transient_error,
    _parse_ts,
    altitude_band,
    altitude_boost,
    compute_altitude,
    hours_until_crash,
)

JST = seizon.JST


class _HtmlError(Exception):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details


class _ApiUnavailableError(Exception):
    code = "API_UNAVAILABLE"


def _named_exception(name, message="boom"):
    return type(name, (Exception,), {})(message)


class TransientErrorTests(unittest.TestCase):
    def test_api_unavailable_code_is_transient(self):
        self.assertTrue(_is_transient_error(_ApiUnavailableError("db pool")))

    def test_gateway_html_error(self):
        exc = _HtmlError("<html><title>cloudflare</title> 400 Bad Request</html>")
        self.assertTrue(_is_gateway_html_error(exc))
        self.assertTrue(_is_transient_error(exc))

    def test_gateway_html_in_details(self):
        exc = _HtmlError("JSON could not be generated", details="<html>error</html>")
        self.assertTrue(_is_gateway_html_error(exc))

    def test_plain_error_is_not_gateway_html(self):
        self.assertFalse(_is_gateway_html_error(ValueError("nope")))

    def test_transient_by_class_name(self):
        for name in ("ConnectionTerminated", "ConnectError", "ReadTimeout", "PoolTimeout"):
            self.assertTrue(_is_transient_error(_named_exception(name)), name)

    def test_transient_by_message_fallback(self):
        self.assertTrue(_is_transient_error(Exception("stream error: connection reset by peer")))
        self.assertTrue(_is_transient_error(Exception("RemoteProtocolError: Server disconnected")))

    def test_permanent_error_is_not_transient(self):
        self.assertFalse(_is_transient_error(ValueError("invalid input")))
        self.assertFalse(_is_transient_error(KeyError("user_id")))


class ParseTsTests(unittest.TestCase):
    def test_z_suffix_and_naive(self):
        dt = _parse_ts("2026-01-02T03:04:05Z")
        self.assertEqual(dt.tzinfo, timezone.utc)
        self.assertEqual((dt.hour, dt.minute), (3, 4))
        naive = _parse_ts("2026-01-02T03:04:05")
        self.assertEqual(naive.tzinfo, timezone.utc)


def _cog(users=None):
    cog = FujoSurvival.__new__(FujoSurvival)
    cog.bot = types.SimpleNamespace(get_user=lambda uid: None)
    cog.users = users if users is not None else {}
    cog.users_loaded = True
    cog._last_record = {}
    cog._bg_tasks = set()
    return cog


def _record(ts: datetime, signal="MESSAGE"):
    return {"detected_at": ts.isoformat(), "signal_type": signal}


class CalculateTitleTests(unittest.TestCase):
    def setUp(self):
        self.cog = _cog()
        # JST の昼間（夜行性判定に触れない時刻）
        self.noon = datetime(2026, 1, 5, 12, 0, tzinfo=JST)

    def test_few_records_is_general_survivor(self):
        self.assertEqual(self.cog.calculate_title([_record(self.noon)] * 4), "一般サバイバー")

    def test_night_owl(self):
        night = datetime(2026, 1, 5, 2, 0, tzinfo=JST)  # JST 2時 = 夜間
        records = [_record(night, "PRESENCE") for _ in range(10)]
        self.assertEqual(self.cog.calculate_title(records), "夜行性")

    def test_voice_heavy(self):
        records = [_record(self.noon, "VOICE") for _ in range(5)] + [_record(self.noon, "PRESENCE") for _ in range(5)]
        self.assertEqual(self.cog.calculate_title(records), "出会い厨")

    def test_message_heavy(self):
        records = [_record(self.noon, "MESSAGE") for _ in range(5)] + [_record(self.noon, "PRESENCE") for _ in range(5)]
        self.assertEqual(self.cog.calculate_title(records), "おしゃべりマシン")

    def test_presence_only_is_rom(self):
        records = [_record(self.noon, "PRESENCE") for _ in range(10)]
        self.assertEqual(self.cog.calculate_title(records), "永遠のROMラー")


class StreakUpdateTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, user_row):
        cog = _cog(users={7: dict(user_row)})
        cog._insert_activity_with_retry = AsyncMock(return_value=True)
        updates = []

        async def fake_update(user_id, values):
            updates.append(values)
            cog.users[user_id].update(values)

        cog._update_user = fake_update
        now = datetime.now(timezone.utc)
        await cog._record_activity_async(7, "MESSAGE", "online", now)
        return cog.users[7], updates

    async def test_first_activity_starts_streak(self):
        user, _ = await self._run({"streak_count": 0, "is_frozen": False, "last_streak_date": None})
        self.assertEqual(user["streak_count"], 1)
        self.assertEqual(user["last_streak_date"], seizon._today().isoformat())

    async def test_yesterday_continues_streak(self):
        today = seizon._today()
        user, _ = await self._run({
            "streak_count": 3, "is_frozen": False,
            "last_streak_date": (today - timedelta(days=1)).isoformat(),
        })
        self.assertEqual(user["streak_count"], 4)

    async def test_gap_resets_streak(self):
        today = seizon._today()
        user, _ = await self._run({
            "streak_count": 9, "is_frozen": False,
            "last_streak_date": (today - timedelta(days=3)).isoformat(),
        })
        self.assertEqual(user["streak_count"], 1)

    async def test_freeze_covers_one_day_gap_and_is_consumed(self):
        today = seizon._today()
        user, _ = await self._run({
            "streak_count": 5, "is_frozen": True,
            "last_streak_date": (today - timedelta(days=2)).isoformat(),
        })
        self.assertEqual(user["streak_count"], 6)
        self.assertFalse(user["is_frozen"])

    async def test_same_day_keeps_streak_and_clears_pester(self):
        today = seizon._today()
        user, updates = await self._run({
            "streak_count": 2, "is_frozen": False,
            "last_streak_date": today.isoformat(), "last_pester_level": 2,
        })
        self.assertEqual(user["streak_count"], 2)
        self.assertEqual(user["last_pester_level"], 0)
        self.assertTrue(any(u.get("last_pester_level") == 0 for u in updates))


class RecordActivityGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_unregistered_user_is_ignored(self):
        cog = _cog(users={})
        spawned = []
        cog._spawn = spawned.append
        await cog.record_activity(123, "MESSAGE", "online")
        self.assertEqual(spawned, [])

    async def test_throttled_within_interval(self):
        cog = _cog(users={5: {}})
        cog._last_record[5] = datetime.now(timezone.utc)
        spawned = []
        cog._spawn = spawned.append
        await cog.record_activity(5, "MESSAGE", "online")
        self.assertEqual(spawned, [])

    async def test_registered_user_is_spawned(self):
        cog = _cog(users={5: {}})
        spawned = []
        cog._spawn = spawned.append
        await cog.record_activity(5, "VOICE", "online")
        self.assertEqual(len(spawned), 1)
        spawned[0].close()


class StatusEmbedTests(unittest.IsolatedAsyncioTestCase):
    async def _embed_for_age_hours(self, hours):
        cog = _cog(users={7: {"streak_count": 3, "is_frozen": False}})
        latest_at = datetime.now(timezone.utc) - timedelta(hours=hours)
        cog._latest_activity = AsyncMock(return_value={
            "detected_at": latest_at.isoformat(), "signal_type": "MESSAGE", "status": "online",
        })
        cog._activities_since = AsyncMock(return_value=[])
        target = types.SimpleNamespace(
            id=7, display_name="誰か", mention="<@7>",
            display_avatar=types.SimpleNamespace(url="https://example.com/a.png"),
        )
        return await cog.status_embed_for(target)

    async def test_status_thresholds(self):
        cases = [
            (1, "良好"),
            (24, "注意"),
            (100, "警戒"),
            (300, "霊体化"),
            (1000, "化石化"),
        ]
        for hours, label in cases:
            embed = await self._embed_for_age_hours(hours)
            fields = {f.name: f.value for f in embed.fields}
            self.assertEqual(fields["判定"], label, f"{hours}h")

    async def test_unregistered_returns_none(self):
        cog = _cog(users={})
        target = types.SimpleNamespace(id=8, display_name="未登録", mention="<@8>",
                                       display_avatar=types.SimpleNamespace(url=""))
        self.assertIsNone(await cog.status_embed_for(target))

    async def test_no_activity_yet(self):
        cog = _cog(users={7: {}})
        cog._latest_activity = AsyncMock(return_value=None)
        target = types.SimpleNamespace(id=7, display_name="誰か", mention="<@7>",
                                       display_avatar=types.SimpleNamespace(url=""))
        embed = await cog.status_embed_for(target)
        self.assertEqual(embed.title, "データなし")


class AltitudeModelTests(unittest.TestCase):
    """高度モデル（指数減衰インパルス）の純関数テスト。時刻を注入して固定する。"""

    def setUp(self):
        self.now = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)

    def test_single_detection_gives_full_boost(self):
        # 検知した瞬間はブースト量そのものが高度になる
        self.assertAlmostEqual(compute_altitude([_record(self.now, "MESSAGE")], self.now), 90.0)
        self.assertAlmostEqual(compute_altitude([_record(self.now, "VOICE")], self.now), 120.0)
        self.assertAlmostEqual(compute_altitude([_record(self.now, "PRESENCE")], self.now), 30.0)

    def test_signal_weights_order(self):
        self.assertGreater(altitude_boost("VOICE"), altitude_boost("MESSAGE"))
        self.assertGreater(altitude_boost("MESSAGE"), altitude_boost("PRESENCE"))
        # 未知シグナルはデフォルトブースト
        self.assertEqual(altitude_boost("COMMAND"), seizon.ALTITUDE_DEFAULT_BOOST)
        self.assertEqual(altitude_boost(None), seizon.ALTITUDE_DEFAULT_BOOST)

    def test_decays_with_half_life(self):
        rec = [_record(self.now - timedelta(hours=seizon.ALTITUDE_HALF_LIFE_HOURS), "VOICE")]
        self.assertAlmostEqual(compute_altitude(rec, self.now), 60.0)
        rec2 = [_record(self.now - timedelta(hours=seizon.ALTITUDE_HALF_LIFE_HOURS * 2), "VOICE")]
        self.assertAlmostEqual(compute_altitude(rec2, self.now), 30.0)

    def test_long_inactivity_approaches_zero(self):
        rec = [_record(self.now - timedelta(days=13), "MESSAGE")]
        self.assertLess(compute_altitude(rec, self.now), 1.0)
        # 計算窓（14日）より古い記録は数えない
        old = [_record(self.now - timedelta(days=30), "MESSAGE")]
        self.assertEqual(compute_altitude(old, self.now), 0.0)

    def test_future_records_ignored(self):
        rec = [_record(self.now + timedelta(hours=1), "MESSAGE")]
        self.assertEqual(compute_altitude(rec, self.now), 0.0)

    def test_accumulates_multiple_events(self):
        recs = [_record(self.now, "MESSAGE"), _record(self.now, "VOICE")]
        self.assertAlmostEqual(compute_altitude(recs, self.now), 210.0)

    def test_band_labels(self):
        self.assertEqual(altitude_band(5000)[0], "成層圏")
        self.assertEqual(altitude_band(1500)[0], "巡航高度")
        self.assertEqual(altitude_band(400)[0], "低空飛行")
        self.assertEqual(altitude_band(100)[0], "降下中")
        self.assertEqual(altitude_band(10)[0], "墜落寸前")
        self.assertEqual(altitude_band(0.5)[0], "墜落")
        self.assertEqual(altitude_band(0)[0], "墜落")

    def test_hours_until_crash(self):
        self.assertIsNone(hours_until_crash(0.5))
        # 高度 2^(n) m なら墜落まで 半減期 × n 時間
        hl = seizon.ALTITUDE_HALF_LIFE_HOURS
        self.assertAlmostEqual(hours_until_crash(1024.0), hl * 10)
        self.assertAlmostEqual(hours_until_crash(1.0), 0.0)


class HindoAltitudeDisplayTests(unittest.IsolatedAsyncioTestCase):
    async def _run_hindo(self, records):
        cog = _cog(users={7: {"streak_count": 1, "is_frozen": False}})
        cog._activities_since = AsyncMock(return_value=records)
        cog._latest_activity = AsyncMock(return_value=None)
        replies = []

        async def fake_reply(interaction, embed, ephemeral=False, view=None):
            replies.append(embed)

        cog._reply = fake_reply
        target = types.SimpleNamespace(
            id=7, display_name="誰か", mention="<@7>",
            display_avatar=types.SimpleNamespace(url="https://example.com/a.png"),
        )
        interaction = types.SimpleNamespace(user=target)
        await cog.hindo(interaction, target)
        return replies

    async def test_shows_altitude_not_counts(self):
        now = datetime.now(timezone.utc)
        records = [_record(now, "VOICE"), _record(now, "MESSAGE")]
        replies = await self._run_hindo(records)
        self.assertEqual(len(replies), 1)
        embed = replies[0]
        self.assertEqual(embed.title, "現在の高度 - 誰か")
        fields = {f.name: f.value for f in embed.fields}
        self.assertIn("現在の高度", fields)
        self.assertIn("210 m", fields["現在の高度"])
        self.assertEqual(fields["状態"], "降下中")
        # 回数の生表示は出さない
        self.assertNotIn("直近 24 時間", fields)
        self.assertNotIn("直近 7 日", fields)
        self.assertNotIn("直近 30 日", fields)

    async def test_no_records_is_data_none(self):
        replies = await self._run_hindo([])
        self.assertEqual(replies[0].title, "データなし")


class RankingAltitudeTests(unittest.IsolatedAsyncioTestCase):
    async def test_active_ranking_uses_altitude(self):
        cog = _cog(users={7: {}, 8: {}})
        now = datetime.now(timezone.utc)
        rows = [
            {"user_id": 7, "detected_at": now.isoformat(), "signal_type": "VOICE"},
            {"user_id": 8, "detected_at": now.isoformat(), "signal_type": "PRESENCE"},
        ]
        cog._fetch_all = AsyncMock(return_value=rows)
        replies = []

        async def fake_reply(interaction, embed, ephemeral=False):
            replies.append(embed)

        cog._reply = fake_reply
        interaction = types.SimpleNamespace(
            guild=None,
            response=types.SimpleNamespace(defer=AsyncMock()),
        )
        await cog.ranking(interaction, "active")
        embed = replies[0]
        self.assertEqual(embed.title, "高度ランキング TOP5")
        self.assertIn("120 m", embed.description)
        self.assertIn("30 m", embed.description)
        # VOICE の方が上位
        self.assertLess(embed.description.index("120 m"), embed.description.index("30 m"))
        self.assertNotIn("回", embed.description)


class HourlyProfileTests(unittest.TestCase):
    """fujo分析の集計（日単位統計→1日平均）の純関数テスト。"""

    def setUp(self):
        from core.game.seizon import analysis

        self.analysis = analysis
        # 2026-11-07 12:00 JST を「今」とする（窓は 10/8〜11/6 の完了日）
        self.now = datetime(2026, 11, 7, 12, 0, tzinfo=JST).astimezone(timezone.utc)

    def _rec(self, jst_dt: datetime):
        return {"detected_at": jst_dt.astimezone(timezone.utc).isoformat()}

    def test_averages_from_daily_counts(self):
        a = self.analysis
        records = []
        # 11/6: 21時に3回、11/5: 21時に1回、11/4: 9時に2回
        for _ in range(3):
            records.append(self._rec(datetime(2026, 11, 6, 21, 30, tzinfo=JST)))
        records.append(self._rec(datetime(2026, 11, 5, 21, 5, tzinfo=JST)))
        for _ in range(2):
            records.append(self._rec(datetime(2026, 11, 4, 9, 15, tzinfo=JST)))
        profile = a.average_hourly_profile(records, self.now)
        self.assertIsNotNone(profile)
        self.assertEqual(profile.days, 3)
        self.assertEqual(profile.total, 6)
        self.assertEqual(len(profile.averages), 24)
        self.assertAlmostEqual(profile.averages[21], 4 / 3)
        self.assertAlmostEqual(profile.averages[9], 2 / 3)
        self.assertAlmostEqual(profile.averages[0], 0.0)
        self.assertEqual(profile.peak_hour, 21)
        self.assertEqual(profile.window_end.isoformat(), "2026-11-06")
        self.assertEqual(profile.window_start.isoformat(), "2026-10-08")

    def test_today_is_excluded_as_partial_day(self):
        a = self.analysis
        records = [self._rec(datetime(2026, 11, 7, 10, 0, tzinfo=JST)) for _ in range(5)]
        records += [self._rec(datetime(2026, 11, 6, 10, 0, tzinfo=JST)) for _ in range(2)]
        records += [self._rec(datetime(2026, 11, 5, 10, 0, tzinfo=JST))]
        records += [self._rec(datetime(2026, 11, 4, 10, 0, tzinfo=JST))]
        profile = a.average_hourly_profile(records, self.now)
        self.assertEqual(profile.days, 3)
        self.assertEqual(profile.total, 4)  # 今日の5件は数えない
        self.assertAlmostEqual(profile.averages[10], 4 / 3)

    def test_utc_records_convert_to_jst_hours(self):
        a = self.analysis
        records = []
        # UTC 16:00 = JST 翌日 1:00。JST の暦日で 11/6 扱いになる記録
        for day in (3, 4, 5):
            records.append({"detected_at": datetime(2026, 11, day, 16, 0, tzinfo=timezone.utc).isoformat()})
        profile = a.average_hourly_profile(records, self.now)
        self.assertIsNotNone(profile)
        self.assertEqual(profile.days, 3)
        self.assertAlmostEqual(profile.averages[1], 1.0)
        self.assertEqual(profile.peak_hour, 1)

    def test_old_and_future_records_ignored(self):
        a = self.analysis
        records = [self._rec(datetime(2026, 9, 1, 12, 0, tzinfo=JST)) for _ in range(3)]
        records += [self._rec(datetime(2026, 12, 1, 12, 0, tzinfo=JST)) for _ in range(3)]
        self.assertIsNone(a.average_hourly_profile(records, self.now))

    def test_insufficient_days_returns_none(self):
        a = self.analysis
        records = [self._rec(datetime(2026, 11, 6, 12, 0, tzinfo=JST)) for _ in range(10)]
        records += [self._rec(datetime(2026, 11, 5, 12, 0, tzinfo=JST)) for _ in range(10)]
        self.assertIsNone(a.average_hourly_profile(records, self.now))
        self.assertIsNone(a.average_hourly_profile([], self.now))

    def test_chart_renders_png(self):
        a = self.analysis
        records = []
        for day in (4, 5, 6):
            for _ in range(2):
                records.append(self._rec(datetime(2026, 11, day, 22, 45, tzinfo=JST)))
        profile = a.average_hourly_profile(records, self.now)
        png = a.render_hourly_chart(profile, title="fujo分析 - テスト")
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)


class AnalysisActionTests(unittest.IsolatedAsyncioTestCase):
    async def test_insufficient_data_branch(self):
        cog = _cog(users={7: {"streak_count": 1, "is_frozen": False}})
        cog._activities_since = AsyncMock(return_value=[])
        replies = []

        async def fake_reply(interaction, embed, ephemeral=False, view=None):
            replies.append((embed, ephemeral))

        cog._reply = fake_reply
        user = types.SimpleNamespace(id=7, display_name="誰か", mention="<@7>")
        interaction = types.SimpleNamespace(
            user=user,
            response=types.SimpleNamespace(is_done=lambda: True),
        )
        await cog.analysis(interaction)
        self.assertEqual(len(replies), 1)
        embed, ephemeral = replies[0]
        self.assertEqual(embed.title, "fujo分析")
        self.assertIn("まだデータが少ない", embed.description)
        self.assertTrue(ephemeral)

    async def test_chart_branch_sends_view_and_file(self):
        cog = _cog(users={7: {"streak_count": 1, "is_frozen": False}})
        now = datetime.now(timezone.utc)
        records = []
        for days_ago in (1, 2, 3):
            ts = now - timedelta(days=days_ago)
            records.append({"detected_at": ts.isoformat(), "signal_type": "MESSAGE"})
        cog._activities_since = AsyncMock(return_value=records)
        sent = {}

        async def fake_reply_view(interaction, view, file):
            sent["view"] = view
            sent["file"] = file

        cog._reply_view = fake_reply_view
        user = types.SimpleNamespace(id=7, display_name="誰か", mention="<@7>")
        interaction = types.SimpleNamespace(
            user=user,
            response=types.SimpleNamespace(is_done=lambda: True),
        )
        await cog.analysis(interaction)
        self.assertIn("view", sent)
        self.assertEqual(sent["file"].filename, "fujo_analysis.png")


class SimpleEmbedTests(unittest.TestCase):
    def test_footer_and_color(self):
        embed = FujoSurvival.create_simple_embed("題", "文", 0x123456)
        self.assertEqual(embed.title, "題")
        self.assertEqual(embed.footer.text, seizon.FOOTER)
        self.assertEqual(embed.color.value, 0x123456)


if __name__ == "__main__":
    unittest.main()
