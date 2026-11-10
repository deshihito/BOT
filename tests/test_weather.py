# -*- coding: utf-8 -*-
"""天気（core/general/weather）のテスト。

予報のパースは気象庁の実レスポンスを保存したフィクスチャで検証し、
実APIには依存しない。取得は差し替え可能な fetcher 経由。
"""
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

from PIL import Image

from core.general.weather import areas, forecast as fc, render
from core.general.weather.store import WeatherUserStore
from core.support import guild_settings
from core.support.storage import KVStore

FIXTURES = Path(__file__).resolve().parent / "fixtures"
JST = timezone(timedelta(hours=9))
FETCHED = datetime(2026, 11, 10, 12, 5, tzinfo=JST)


def load_fixture(code: str):
    return json.loads((FIXTURES / f"weather_forecast_{code}.json")
                      .read_text(encoding="utf-8"))


def use_temp_settings(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    guild_settings.set_store(guild_settings.GuildSettings(
        KVStore("guild_settings", client=None,
                path=os.path.join(tmp.name, "kv.json"))))
    test.addCleanup(guild_settings.set_store, None)


class AreasTest(unittest.TestCase):
    def test_table_integrity(self):
        self.assertEqual(len(areas.BLOCKS), 11)
        self.assertEqual(len(areas.OFFICE_NAMES), 58)
        for block, _label, offices in areas.BLOCKS:
            self.assertTrue(offices)
            for code, _name in offices:
                self.assertEqual(areas.OFFICE_BLOCK[code], block)
                self.assertEqual(len(code), 6)

    def test_resolve_area(self):
        self.assertEqual(areas.resolve_area("130000"), "130000")
        self.assertEqual(areas.resolve_area("東京都"), "130000")
        self.assertEqual(areas.resolve_area("東京"), "130000")
        self.assertEqual(areas.resolve_area("大阪府"), "270000")
        self.assertIsNone(areas.resolve_area("存在しない場所"))
        self.assertIsNone(areas.resolve_area(""))
        self.assertIsNone(areas.resolve_area(None))

    def test_offices_of_block(self):
        offices = areas.offices_of_block("010300")
        self.assertIn(("130000", "東京都"), offices)
        self.assertEqual(areas.offices_of_block("999999"), ())


class ParseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parsed = fc.parse_forecast(load_fixture("130000"), "130000", FETCHED)

    def test_headline(self):
        self.assertEqual(self.parsed.area_name, "東京地方")
        self.assertEqual(self.parsed.point_name, "東京")
        self.assertEqual(self.parsed.publishing_office, "気象庁")
        self.assertEqual(self.parsed.report_datetime.hour, 11)

    def test_short_days(self):
        days = self.parsed.days
        self.assertEqual(len(days), 3)
        self.assertEqual(days[0].date, "2026-11-10")
        self.assertEqual(days[1].date, "2026-11-11")
        self.assertEqual(days[2].date, "2026-11-12")
        self.assertIn("雨", days[0].weather_text)
        # 気温系列の畳み込み。今日ぶんは 00時枠が最低気温ではないため
        # 最低は出さず最高だけ（気象庁発表の東京 13℃/9℃ と照合済み。
        # 旧実装は 00時枠 13 を最低として 13°/13° を出していた）
        self.assertIsNone(days[0].temp_min)
        self.assertEqual(days[0].temp_max, 13)
        self.assertEqual(days[1].temp_min, 8)
        self.assertEqual(days[1].temp_max, 15)
        # 降水確率は6時間値の最大（11/10 は 20 と 0 → 20）
        self.assertEqual(days[0].pop, 20)
        self.assertEqual(days[1].pop, 0)
        # 明後日は短期の気温・降水系列が無いため、同日付の週間予報で補完される
        self.assertEqual(days[2].temp_max, 18)
        self.assertEqual(days[2].temp_min, 8)
        self.assertEqual(days[2].pop, 10)

    def test_today_min_never_from_midnight_slot(self):
        # 八丈島型: 今日の 00時枠(18)が 09時枠(17)を上回っても、
        # 最低は出さず最高は両枠の大きい方(18)を取る
        payload = load_fixture("130000")
        payload[0]["timeSeries"][2]["areas"][0]["temps"] = ["17", "18", "15", "18"]
        parsed = fc.parse_forecast(payload, "130000", FETCHED)
        self.assertIsNone(parsed.days[0].temp_min)
        self.assertEqual(parsed.days[0].temp_max, 18)
        self.assertEqual(parsed.days[1].temp_min, 15)
        self.assertEqual(parsed.days[1].temp_max, 18)

    def test_today_min_never_filled_from_weekly(self):
        # 週間予報（11時発表）の先頭日が当日を含み、その最低が最高と
        # 同値でも、当日ぶんの最低は週間から補完しない（13°/13° 対策）
        payload = load_fixture("130000")
        weekly = payload[1]["timeSeries"]
        for series in weekly:
            series["timeDefines"] = ["2026-11-10T00:00:00+09:00"] + list(series["timeDefines"])
            area = series["areas"][0]
            for key in ("weatherCodes", "pops", "reliabilities",
                        "tempsMin", "tempsMax"):
                if key in area:
                    area[key] = [area[key][0]] + list(area[key])
            if "tempsMin" in area:
                area["tempsMin"][0] = "13"
                area["tempsMax"][0] = "13"
        parsed = fc.parse_forecast(payload, "130000", FETCHED)
        self.assertIsNone(parsed.days[0].temp_min)
        self.assertEqual(parsed.days[0].temp_max, 13)

    def test_inverted_min_max_drops_min(self):
        # 明日ぶんで最低>最高になる異常値は最低側を落として最高だけ出す
        payload = load_fixture("130000")
        payload[0]["timeSeries"][2]["areas"][0]["temps"] = ["13", "13", "18", "15"]
        parsed = fc.parse_forecast(payload, "130000", FETCHED)
        self.assertIsNone(parsed.days[1].temp_min)
        self.assertEqual(parsed.days[1].temp_max, 15)

    def test_weekly(self):
        weekly = self.parsed.weekly
        self.assertEqual(len(weekly), 7)
        self.assertEqual(weekly[0].date, "2026-11-11")
        self.assertIsNone(weekly[0].pop)       # 先頭日は空文字 → None
        self.assertIsNone(weekly[0].temp_min)
        self.assertEqual(weekly[1].pop, 10)
        self.assertEqual(weekly[1].temp_min, 8)
        self.assertEqual(weekly[1].temp_max, 18)
        self.assertEqual(weekly[2].reliability, "A")

    def test_weather_kind(self):
        self.assertEqual(fc.weather_kind("100"), "sunny")
        self.assertEqual(fc.weather_kind("202"), "cloudy")
        self.assertEqual(fc.weather_kind("313"), "rain")
        self.assertEqual(fc.weather_kind("400"), "snow")
        self.assertEqual(fc.weather_kind(""), "unknown")
        self.assertEqual(fc.weather_kind(None), "unknown")

    def test_invalid_payload(self):
        with self.assertRaises(fc.WeatherFetchError):
            fc.parse_forecast({}, "130000", FETCHED)
        with self.assertRaises(fc.WeatherFetchError):
            fc.parse_forecast([], "130000", FETCHED)
        with self.assertRaises(fc.WeatherFetchError):
            fc.parse_forecast([{"timeSeries": []}], "130000", FETCHED)


class RenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parsed = fc.parse_forecast(load_fixture("130000"), "130000", FETCHED)

    def test_forecast_card_png(self):
        png = render.render_forecast_png(self.parsed, "東京都")
        self.assertTrue(png.startswith(b"\x89PNG"))
        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.width, 1000)
        self.assertGreater(image.height, 600)

    def test_national_card_png(self):
        entries = [("東京", self.parsed), ("大阪", self.parsed)]
        png = render.render_national_png(entries, FETCHED)
        self.assertTrue(png.startswith(b"\x89PNG"))
        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.width, 1000)


class UserStoreTest(unittest.TestCase):
    def test_remember_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "weather_users.json"
            store = WeatherUserStore(path)
            self.assertIsNone(store.last_area(123))
            store.remember(123, "270000")
            self.assertEqual(store.last_area(123), "270000")
            reloaded = WeatherUserStore(path)
            self.assertEqual(reloaded.last_area(123), "270000")


class SettingsTest(unittest.TestCase):
    def setUp(self):
        use_temp_settings(self)

    def test_defaults(self):
        settings = guild_settings.weather_settings(555)
        self.assertIsNone(settings["default_area"])
        self.assertFalse(settings["post_enabled"])
        self.assertIsNone(settings["post_channel_id"])
        self.assertIsNone(settings["post_time"])

    def test_post_due(self):
        async def scenario():
            store = guild_settings.get_store()
            await store.update(555, guild_settings.WEATHER_SECTION,
                               post_enabled=True, post_channel_id=999,
                               post_time="07:30")
            before = datetime(2026, 11, 10, 7, 29, tzinfo=JST)
            at = datetime(2026, 11, 10, 7, 30, tzinfo=JST)
            later = datetime(2026, 11, 10, 12, 0, tzinfo=JST)
            self.assertIsNone(guild_settings.weather_post_due(555, before))
            self.assertEqual(guild_settings.weather_post_due(555, at), 999)
            self.assertEqual(guild_settings.weather_post_due(555, later), 999)
            await store.update(555, guild_settings.WEATHER_SECTION,
                               posted_date="2026-11-10")
            self.assertIsNone(guild_settings.weather_post_due(555, later))
            await store.update(555, guild_settings.WEATHER_SECTION,
                               post_enabled=False)
            self.assertIsNone(guild_settings.weather_post_due(555, later))

        import asyncio
        asyncio.run(scenario())


class CogFetchTest(unittest.IsolatedAsyncioTestCase):
    async def test_cache_and_error(self):
        from core.general.weather.cog import WeatherCog

        parsed = fc.parse_forecast(load_fixture("130000"), "130000", FETCHED)
        fetcher = AsyncMock(return_value=parsed)
        cog = WeatherCog.__new__(WeatherCog)
        cog.bot = None
        cog.store = WeatherUserStore(Path(tempfile.mkdtemp()) / "u.json")
        cog._fetcher = fetcher
        cog._cache = {}
        first = await cog.get_forecast("130000")
        second = await cog.get_forecast("130000")
        self.assertIs(first, second)
        fetcher.assert_awaited_once()

        failing = AsyncMock(side_effect=fc.WeatherFetchError("接続失敗"))
        cog._fetcher = failing
        with self.assertRaises(fc.WeatherFetchError):
            await cog.get_forecast("270000")


if __name__ == "__main__":
    unittest.main()
