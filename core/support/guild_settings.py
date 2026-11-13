"""サーバーごとの保存済み設定（以前は /setup で決めていたもの）。

core/support/storage.py（Supabase の bot_kv、namespace "guild_settings"）に、サーバーごとに 1 件
``{"<section>": {...}}`` の形で保存する。Supabase が使えないときはローカルの bot_kv.json に保存される。

読むときはメモリ上の写しから同期的に読む（``get``）。保存先からの読み直しは、最初に必要になったときと、
前回の読み直しから ``RELOAD_INTERVAL`` 秒が過ぎたときに ``await ensure_loaded()`` で行う。
Web ダッシュボードから書き換えた設定も、この再読込で遅くとも間隔分だけ遅れて届く。
保存（``update``）のときは間隔を待たず、そのギルドの最新を読み直してから変更を重ねる。
古い写しを丸ごと書き戻して Web 側の保存を巻き戻さないため。

    store = get_store()
    await store.ensure_loaded()
    store.get(guild_id, "auth")                 # -> {"role_id": ..., ...}
    await store.update(guild_id, "auth", role_id=123)
"""
from __future__ import annotations

import asyncio
import copy
import logging
import time
from typing import Any, Optional

from core.support.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "guild_settings"

# Web ダッシュボードなど Bot の外から書き換えた設定を取り込む間隔（秒）。
RELOAD_INTERVAL = 60.0


class GuildSettings:
    def __init__(self, kv: Optional[KVStore] = None):
        self.kv = kv or KVStore(NAMESPACE)
        self._data: dict[str, dict[str, dict[str, Any]]] = self._clean(self.kv.load_local())
        self._loaded = False
        self._loaded_at: Optional[float] = None
        self._lock: Optional[asyncio.Lock] = None
        self._update_locks: dict[str, asyncio.Lock] = {}
        self.reload_interval = RELOAD_INTERVAL

    @staticmethod
    def _clean(data: dict) -> dict:
        return {str(k): v for k, v in (data or {}).items() if isinstance(v, dict)}

    def _is_fresh(self) -> bool:
        if not self._loaded or self._loaded_at is None:
            return False
        return (time.monotonic() - self._loaded_at) < self.reload_interval

    async def ensure_loaded(self) -> None:
        """保存先から読み直す（失敗したら手元の控えのまま続ける）。

        初回と、前回の読み直しから ``reload_interval`` 秒が過ぎたときだけ読み直す。
        KVStore.load_all() は未送信のローカル変更を遠隔値より優先して返すため、
        再読込で自分の書き込み途中の値を打ち消すことはない。
        """
        if self._is_fresh():
            return
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._is_fresh():
                return
            try:
                self._data = self._clean(await self.kv.load_all())
            except Exception:
                logger.exception("サーバー設定を読み直せませんでした（ローカルの控えで続けます）")
            self._loaded = True
            self._loaded_at = time.monotonic()

    def get(self, guild_id: int, section: str) -> dict[str, Any]:
        """設定の写しを返す（未設定なら空の dict）。"""
        return copy.deepcopy(self._data.get(str(guild_id), {}).get(section, {}))

    def all_sections(self, section: str) -> dict[str, dict[str, Any]]:
        """全サーバー分の1セクションを {guild_id: 設定} で返す（全サーバー集計用）。"""
        return {
            guild_id: copy.deepcopy(sections[section])
            for guild_id, sections in self._data.items()
            if isinstance(sections.get(section), dict)
        }

    async def _read_latest(self, key: str) -> dict[str, Any]:
        """保存先にあるこのギルドの最新の写し（再読込間隔のキャッシュを通さない）。

        KVStore.load_one があればそれで1件だけ読み直す。読めなければ手元の写しで続ける。
        手元の写しと違っていたら、外部（Web ダッシュボード等）がその間に保存した変更を
        取り込んだことになるので、その旨を記録する。
        """
        try:
            load_one = getattr(self.kv, "load_one", None)
            if load_one is not None:
                value = await load_one(key)
            else:
                value = (await self.kv.load_all()).get(key)
        except Exception:
            logger.exception("サーバー設定の最新を読み直せませんでした（手元の写しで続けます）")
            return copy.deepcopy(self._data.get(key, {}))
        latest = copy.deepcopy(value) if isinstance(value, dict) else {}
        if latest != self._data.get(key, {}):
            logger.info("サーバー設定 %s は外部で更新されていたため、最新に合わせて保存します", key)
        return latest

    async def update(self, guild_id: int, section: str, *, background: bool = False,
                     **values: Any) -> dict[str, Any]:
        """値を書き換えて保存する。値に None を渡すとその項目を消す。

        保存の直前に保存先の最新を読み直し、その上にこの変更だけを重ねて書き戻す。
        手元の写し（最大で再読込間隔ぶん古い）を丸ごと書き戻すと、その間に Web
        ダッシュボードが保存した変更まで巻き戻してしまう（lost update）ため。
        同じギルドへの保存はロックで1本に並べ、読み直しから書き戻しまでを割らせない。
        """
        await self.ensure_loaded()
        key = str(guild_id)
        lock = self._update_locks.get(key)
        if lock is None:
            lock = self._update_locks[key] = asyncio.Lock()
        async with lock:
            guild = await self._read_latest(key)
            current = guild.get(section)
            if not isinstance(current, dict):
                current = guild[section] = {}
            for name, value in values.items():
                if value is None:
                    current.pop(name, None)
                else:
                    current[name] = value
            if not current:
                guild.pop(section, None)
            if guild:
                self._data[key] = guild
                await self.kv.set(key, copy.deepcopy(guild), wait=not background)
            else:
                self._data.pop(key, None)
                await self.kv.delete(key, wait=not background)
            return copy.deepcopy(current)


_store: Optional[GuildSettings] = None


def get_store() -> GuildSettings:
    global _store
    if _store is None:
        _store = GuildSettings()
    return _store


def set_store(store: Optional[GuildSettings]) -> None:
    """テスト用: 保存先を差し替える（None で既定に戻す）。"""
    global _store
    _store = store


# ---------------------------------------------------------------- 国づくり設定
NATION_SECTION = "nation"
NOTIFY_MAJOR = "major"   # 大きな出来事だけ
NOTIFY_ALL = "all"       # 全部
NOTIFY_LEVELS = {NOTIFY_MAJOR: "大きな出来事だけ", NOTIFY_ALL: "全部"}
NATION_DEFAULTS = {"enabled": True, "channel_id": None, "notify": NOTIFY_MAJOR}


def nation_settings(guild_id: int) -> dict[str, Any]:
    """このサーバーの国づくりの設定を、既定値で補って返す。

    戻り値: {"enabled": 参加するか, "channel_id": お知らせチャンネル ID か None,
             "notify": "major"（大きな出来事だけ）か "all"（全部）}
    """
    raw = get_store().get(guild_id, NATION_SECTION)
    result = dict(NATION_DEFAULTS)
    if isinstance(raw.get("enabled"), bool):
        result["enabled"] = raw["enabled"]
    if isinstance(raw.get("channel_id"), int):
        result["channel_id"] = raw["channel_id"]
    if raw.get("notify") in NOTIFY_LEVELS:
        result["notify"] = raw["notify"]
    return result


def nation_should_notify(guild_id: int, *, major: bool) -> Optional[int]:
    """お知らせを送るべきならチャンネル ID を、送らないなら None を返す。

    major=True は建国・戦争などの大きな出来事。notify が "major" のサーバーには、major=False の出来事は送らない。
    """
    s = nation_settings(guild_id)
    if not s["enabled"] or s["channel_id"] is None:
        return None
    if not major and s["notify"] != NOTIFY_ALL:
        return None
    return s["channel_id"]


# ---------------------------------------------------------------- 放置したプレイヤーの代打ち（core/game/game/autoplay.py）
AUTOPLAY_SECTION = "autoplay"
AUTOPLAY_DEFAULTS = {"enabled": True}


def autoplay_enabled(guild_id: Optional[int]) -> bool:
    """このサーバーで放置したプレイヤーの番を代わりに進めるか（既定はオン）。

    切り替え: ``await get_store().update(guild_id, AUTOPLAY_SECTION, enabled=False)``
    """
    if guild_id is None:
        return AUTOPLAY_DEFAULTS["enabled"]
    try:
        raw = get_store().get(guild_id, AUTOPLAY_SECTION)
    except Exception:
        return AUTOPLAY_DEFAULTS["enabled"]
    value = raw.get("enabled")
    return value if isinstance(value, bool) else AUTOPLAY_DEFAULTS["enabled"]


# ---------------------------------------------------------------- 天気（core/general/weather）
WEATHER_SECTION = "weather"
WEATHER_DEFAULTS: dict[str, Any] = {
    "default_area": None,    # サーバーの既定地域（気象庁の発表官署コード）
    "post_enabled": False,   # 全国の天気の定時投稿をするか（既定はオフ）
    "post_channel_id": None,  # 定時投稿先チャンネル ID
    "post_time": None,       # 定時投稿の時刻 "HH:MM"（JST）
    "posted_date": None,     # 最後に定時投稿した日 "YYYY-MM-DD"（二重投稿防止）
}


def weather_settings(guild_id: int) -> dict[str, Any]:
    """このサーバーの天気設定を、既定値で補って返す。"""
    raw = get_store().get(guild_id, WEATHER_SECTION)
    result = dict(WEATHER_DEFAULTS)
    if isinstance(raw.get("default_area"), str) and raw["default_area"]:
        result["default_area"] = raw["default_area"]
    if isinstance(raw.get("post_enabled"), bool):
        result["post_enabled"] = raw["post_enabled"]
    if isinstance(raw.get("post_channel_id"), int):
        result["post_channel_id"] = raw["post_channel_id"]
    if isinstance(raw.get("post_time"), str) and raw["post_time"]:
        result["post_time"] = raw["post_time"]
    if isinstance(raw.get("posted_date"), str) and raw["posted_date"]:
        result["posted_date"] = raw["posted_date"]
    return result


def weather_post_due(guild_id: int, now) -> Optional[int]:
    """定時投稿すべきなら投稿先チャンネル ID を、そうでなければ None を返す。

    now は JST の datetime。設定時刻を過ぎていて、その日まだ投稿して
    いなければ対象（起動遅延や再起動で時刻ちょうどを逃しても、その日の
    うちに1回は届く）。
    """
    settings = weather_settings(guild_id)
    if not settings["post_enabled"]:
        return None
    channel_id = settings["post_channel_id"]
    post_time = settings["post_time"]
    if channel_id is None or not post_time:
        return None
    if settings["posted_date"] == now.strftime("%Y-%m-%d"):
        return None
    try:
        hour, minute = (int(part) for part in str(post_time).split(":"))
    except (TypeError, ValueError):
        return None
    if (now.hour, now.minute) < (hour, minute):
        return None
    return channel_id


NEWS_SECTION = "news"
NEWS_DEFAULTS: dict[str, Any] = {
    "enabled": False,        # ニュース通知をするか（既定はオフ）
    "channel_id": None,      # 投稿先チャンネル ID
    "feeds": ["top"],        # 購読するトピック（core.general.news.feeds.TOPICS のキー）
    "seen": [],              # 投稿済み記事のリンク（古い順・最大60件、二重投稿防止）
    "custom_feeds": [],      # 任意のRSS/Atomフィード（{"name","url"}、最大3件）
    "custom_seen": [],       # カスタムフィードの投稿済みリンク（最大60件）
    "custom_seeded": [],     # 初回シード済みのフィードURL（登録直後の大量投稿防止）
}
NEWS_SEEN_LIMIT = 60
MAX_CUSTOM_FEEDS = 3  # 1サーバーに登録できるカスタムフィードの上限


def news_settings(guild_id: int) -> dict[str, Any]:
    """このサーバーのニュース通知設定を、既定値で補って返す。"""
    raw = get_store().get(guild_id, NEWS_SECTION)
    result = dict(NEWS_DEFAULTS)
    result["feeds"] = list(NEWS_DEFAULTS["feeds"])
    result["seen"] = []
    result["custom_feeds"] = []
    result["custom_seen"] = []
    result["custom_seeded"] = []
    if isinstance(raw.get("enabled"), bool):
        result["enabled"] = raw["enabled"]
    if isinstance(raw.get("channel_id"), int):
        result["channel_id"] = raw["channel_id"]
    feeds = raw.get("feeds")
    if isinstance(feeds, list):
        cleaned = [key for key in feeds if isinstance(key, str) and key]
        if cleaned:
            result["feeds"] = cleaned
    seen = raw.get("seen")
    if isinstance(seen, list):
        result["seen"] = [link for link in seen
                           if isinstance(link, str) and link][-NEWS_SEEN_LIMIT:]
    raw_feeds = raw.get("custom_feeds")
    if isinstance(raw_feeds, list):
        cleaned_feeds = []
        for entry in raw_feeds:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            url = entry.get("url")
            if (isinstance(name, str) and name.strip()
                    and isinstance(url, str)
                    and url.startswith(("https://", "http://"))):
                cleaned_feeds.append(
                    {"name": name.strip()[:50], "url": url.strip()[:500]})
            if len(cleaned_feeds) >= MAX_CUSTOM_FEEDS:
                break
        result["custom_feeds"] = cleaned_feeds
    custom_seen = raw.get("custom_seen")
    if isinstance(custom_seen, list):
        result["custom_seen"] = [link for link in custom_seen
                                  if isinstance(link, str) and link][-NEWS_SEEN_LIMIT:]
    custom_seeded = raw.get("custom_seeded")
    if isinstance(custom_seeded, list):
        result["custom_seeded"] = [u for u in custom_seeded
                                    if isinstance(u, str) and u][:MAX_CUSTOM_FEEDS]
    return result
