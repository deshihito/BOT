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
from cogs.seizon import FujoSurvival, _is_gateway_html_error, _is_transient_error, _parse_ts

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


class SimpleEmbedTests(unittest.TestCase):
    def test_footer_and_color(self):
        embed = FujoSurvival.create_simple_embed("題", "文", 0x123456)
        self.assertEqual(embed.title, "題")
        self.assertEqual(embed.footer.text, seizon.FOOTER)
        self.assertEqual(embed.color.value, 0x123456)


if __name__ == "__main__":
    unittest.main()
