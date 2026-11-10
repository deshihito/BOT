# -*- coding: utf-8 -*-
"""気象庁 bosai 予報JSONの取得とパース。

データ源: https://www.jma.go.jp/bosai/forecast/data/forecast/{office}.json
（無料・キー不要、発表官署ごとに 今日/明日/明後日 の詳細予報と
向こう7日の週間予報が入った2レポート構成）。

パースは純関数（parse_forecast）に寄せ、実APIに依存せずフィクスチャで
検証できるようにする。取得失敗は WeatherFetchError として呼び出し側に
返し、古いデータを最新と偽る経路は作らない（呼び出し側は取得時刻を
カードに明記する）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

#: 気象庁の予報は JST 基準（他機能の JST 定数と同じ定義）。
JST = timezone(timedelta(hours=9))

FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast/{code}.json"
USER_AGENT = "AGOBOT/1.0 (+https://agobot.app; weather)"
TIMEOUT = aiohttp.ClientTimeout(total=15)


class WeatherFetchError(RuntimeError):
    """予報JSONの取得・解釈に失敗した。"""


@dataclass(frozen=True)
class DayForecast:
    """短期予報（今日・明日・明後日）の1日分。"""

    date: str  # YYYY-MM-DD（JST）
    weather_code: str
    weather_text: str
    pop: int | None  # その日の降水確率（6時間値の最大、%）
    temp_min: int | None
    temp_max: int | None


@dataclass(frozen=True)
class WeeklyDay:
    """週間予報の1日分。"""

    date: str  # YYYY-MM-DD（JST）
    weather_code: str
    pop: int | None
    temp_min: int | None
    temp_max: int | None
    reliability: str = ""  # 信頼度 A/B/C（先頭日などは空）


@dataclass(frozen=True)
class AreaForecast:
    """1つの発表官署ぶんの予報（代表区域 = 先頭の一次細分区域）。"""

    office_code: str
    area_name: str  # 一次細分区域名（例: 東京地方）
    point_name: str  # 気温の代表地点名（例: 東京）
    publishing_office: str
    report_datetime: datetime | None
    fetched_at: datetime
    days: tuple[DayForecast, ...] = ()
    weekly: tuple[WeeklyDay, ...] = ()


def weather_kind(weather_code: str | None) -> str:
    """気象庁の天気コード（3桁）を大分類に寄せる。

    1xx=晴れ系 / 2xx=くもり系 / 3xx=雨系 / 4xx=雪系。先頭桁が
    その日の主たる天気を表す（313「雨のち晴れ」等も雨系に寄せる）。
    """
    code = str(weather_code or "").strip()
    if not code:
        return "unknown"
    return {"1": "sunny", "2": "cloudy", "3": "rain", "4": "snow"}.get(
        code[0], "unknown")


def _to_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _date_of(iso: str) -> str:
    return str(iso)[:10]


def _parse_dt(iso: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return None


def _series_with(report: dict, key: str) -> dict | None:
    for series in report.get("timeSeries", []):
        areas = series.get("areas") or []
        if areas and key in areas[0]:
            return series
    return None


def _area_by_code(series: dict | None, code: str) -> dict | None:
    if not series:
        return None
    for area in series.get("areas", []):
        if (area.get("area") or {}).get("code") == code:
            return area
    return None


def _daily_temps(series: dict | None, today: str | None = None) -> dict[str, dict[str, int | None]]:
    """短期の気温系列（地点別）を {日付: {"min":…, "max":…}} に畳む。

    気象庁の temps 系列は 00時/09時 の時刻定義で並ぶが、00時枠は
    「その日の最低気温」ではない。実測（2026-11-10 11時発表）:
    東京の 00時枠は 13 だが気象庁が同日に発表した東京の最低は 9℃、
    八丈島では 00時枠 18 が 09時枠 17 を上回る（最低>最高になり得る）。
    そのため当日ぶんは 09時枠を最高とし最低は出さない（None）。
    09時枠が最高なのは明日ぶんも同じで、明日は 00時枠=最低 /
    09時枠=最高が発表値と一致する（東京 8/15）。
    """
    result: dict[str, dict[str, int | None]] = {}
    if not series:
        return result
    areas = series.get("areas") or []
    if not areas:
        return result
    temps = areas[0].get("temps") or []
    for iso, value in zip(series.get("timeDefines", []), temps):
        moment = _parse_dt(iso)
        temp = _to_int(value)
        if moment is None or temp is None:
            continue
        date = _date_of(iso)
        slot = result.setdefault(date, {"min": None, "max": None})
        if date == today:
            # 当日: 09時枠が最高。00時枠は最低ではないので最低には使わず、
            # 最高の候補としてだけ見る（八丈島 17/18 のように 00時枠の方が
            # 高い場合、発表の最高はそちらに一致する）。
            slot["max"] = temp if slot["max"] is None else max(slot["max"], temp)
            slot["min"] = None
        elif moment.hour == 0:
            slot["min"] = temp
        elif moment.hour == 9:
            slot["max"] = temp
    return result


def _daily_pops(series: dict | None, area_code: str) -> dict[str, int]:
    """6時間ごとの降水確率を {日付: 最大値} に畳む（対象区域ぶん）。"""
    result: dict[str, int] = {}
    area = _area_by_code(series, area_code)
    if area is None:
        return result
    for iso, value in zip(series.get("timeDefines", []), area.get("pops") or []):
        pop = _to_int(value)
        if pop is None:
            continue
        date = _date_of(iso)
        result[date] = max(pop, result.get(date, -1))
    return result


def parse_forecast(payload: Any, office_code: str,
                   fetched_at: datetime) -> AreaForecast:
    """予報JSON（2レポートのリスト）を AreaForecast に変換する。

    構造が想定と違う場合は WeatherFetchError。代表区域は短期予報の
    先頭の一次細分区域、気温は先頭の地点を使う。
    """
    if not isinstance(payload, list) or not payload:
        raise WeatherFetchError("予報データの形式が想定と異なります")
    short = payload[0] if isinstance(payload[0], dict) else {}
    weather_series = _series_with(short, "weatherCodes")
    if weather_series is None or not weather_series.get("areas"):
        raise WeatherFetchError("予報データに天気系列がありません")
    head = weather_series["areas"][0]
    area_info = head.get("area") or {}
    area_code = str(area_info.get("code") or "")
    area_name = str(area_info.get("name") or "")

    pops = _daily_pops(_series_with(short, "pops"), area_code)
    temps_series = _series_with(short, "temps")
    # 短期予報の先頭日が「今日」。_daily_temps は当日ぶんの最低を出さない。
    _defines = weather_series.get("timeDefines") or []
    _today = _date_of(_defines[0]) if _defines else None
    temps = _daily_temps(temps_series, _today)
    point_name = ""
    if temps_series and temps_series.get("areas"):
        point_name = str((temps_series["areas"][0].get("area") or {}).get("name") or "")

    weekly: list[WeeklyDay] = []
    if len(payload) > 1 and isinstance(payload[1], dict):
        weekly = _parse_weekly(payload[1], area_code)
    weekly_by_date = {day.date: day for day in weekly}

    days: list[DayForecast] = []
    codes = head.get("weatherCodes") or []
    texts = head.get("weathers") or []
    for index, iso in enumerate(weather_series.get("timeDefines", [])):
        date = _date_of(iso)
        slot = temps.get(date, {})
        # 短期の気温・降水系列は明後日ぶんが無い（今日・明日まで）。
        # 欠けた要素は同日付の週間予報で補う（気象庁サイトの3日表示と同じ）。
        fill = weekly_by_date.get(date)
        # 当日ぶんの最低は週間予報からも補わない。週間（11時発表）の
        # 先頭日は当日を含み、その tempsMin は最高と同値になる等、
        # 当日の最低として信用できない（実測で 13°/13° になった）。
        # _daily_temps の方針（当日は最低を出さない）を通す。
        _tmin = slot.get("min") if slot.get("min") is not None \
            else (fill.temp_min if fill and date != _today else None)
        _tmax = slot.get("max") if slot.get("max") is not None \
            else (fill.temp_max if fill else None)
        # 最低>最高は表示としてあり得ない（八丈島の旧バグでは 17°/18° が
        # 逆転していた）。どちらが悪いか断定できないので最低側を落とし、
        # 最高だけを出す。
        if _tmin is not None and _tmax is not None and _tmin > _tmax:
            _tmin = None
        days.append(DayForecast(
            date=date,
            weather_code=str(codes[index]) if index < len(codes) else "",
            weather_text=str(texts[index]) if index < len(texts) else "",
            pop=pops.get(date) if pops.get(date) is not None
            else (fill.pop if fill else None),
            temp_min=_tmin,
            temp_max=_tmax,
        ))

    return AreaForecast(
        office_code=str(office_code),
        area_name=area_name,
        point_name=point_name,
        publishing_office=str(short.get("publishingOffice") or ""),
        report_datetime=_parse_dt(short.get("reportDatetime")),
        fetched_at=fetched_at,
        days=tuple(days),
        weekly=tuple(weekly),
    )


def _parse_weekly(report: dict, area_code: str) -> list[WeeklyDay]:
    weather_series = _series_with(report, "weatherCodes")
    temps_series = _series_with(report, "tempsMin")
    weather_area = _area_by_code(weather_series, area_code)
    if weather_series is None or weather_area is None:
        return []
    temps_area = None
    if temps_series and temps_series.get("areas"):
        temps_area = temps_series["areas"][0]
    codes = weather_area.get("weatherCodes") or []
    pops = weather_area.get("pops") or []
    reliabilities = weather_area.get("reliabilities") or []
    temps_min = (temps_area or {}).get("tempsMin") or []
    temps_max = (temps_area or {}).get("tempsMax") or []

    def _at(values: list, index: int):
        return _to_int(values[index]) if index < len(values) else None

    result: list[WeeklyDay] = []
    for index, iso in enumerate(weather_series.get("timeDefines", [])):
        result.append(WeeklyDay(
            date=_date_of(iso),
            weather_code=str(codes[index]) if index < len(codes) else "",
            pop=_at(pops, index),
            temp_min=_at(temps_min, index),
            temp_max=_at(temps_max, index),
            reliability=str(reliabilities[index]) if index < len(reliabilities) else "",
        ))
    return result


async def fetch_forecast(office_code: str, *,
                         session: aiohttp.ClientSession | None = None,
                         now: datetime | None = None) -> AreaForecast:
    """発表官署コードの予報を取得してパースする（失敗は WeatherFetchError）。"""
    fetched_at = now or datetime.now(JST)
    url = FORECAST_URL.format(code=office_code)
    owns_session = session is None
    if owns_session:
        session = aiohttp.ClientSession(timeout=TIMEOUT)
    try:
        async with session.get(url, headers={"User-Agent": USER_AGENT}) as resp:
            if resp.status != 200:
                raise WeatherFetchError(f"気象庁への接続に失敗しました（HTTP {resp.status}）")
            payload = await resp.json(content_type=None)
    except WeatherFetchError:
        raise
    except Exception as exc:
        raise WeatherFetchError(f"気象庁への接続に失敗しました（{type(exc).__name__}）") from exc
    finally:
        if owns_session and session is not None:
            await session.close()
    return parse_forecast(payload, office_code, fetched_at)
