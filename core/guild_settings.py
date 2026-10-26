"""サーバーごとの保存済み設定（以前は /setup で決めていたもの）。

core/storage.py（Supabase の bot_kv、namespace "guild_settings"）に、サーバーごとに 1 件
``{"<section>": {...}}`` の形で保存する。Supabase が使えないときはローカルの bot_kv.json に保存される。

読むときはメモリ上の写しから同期的に読む（``get``）。Supabase からの読み直しは、最初に必要になったとき
必要な処理から ``await ensure_loaded()`` で 1 回だけ読み込む。

    store = get_store()
    await store.ensure_loaded()
    store.get(guild_id, "auth")                 # -> {"role_id": ..., ...}
    await store.update(guild_id, "auth", role_id=123)
"""
from __future__ import annotations

import asyncio
import copy
import logging
from typing import Any, Optional

from core.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "guild_settings"


class GuildSettings:
    def __init__(self, kv: Optional[KVStore] = None):
        self.kv = kv or KVStore(NAMESPACE)
        self._data: dict[str, dict[str, dict[str, Any]]] = self._clean(self.kv.load_local())
        self._loaded = False
        self._lock: Optional[asyncio.Lock] = None

    @staticmethod
    def _clean(data: dict) -> dict:
        return {str(k): v for k, v in (data or {}).items() if isinstance(v, dict)}

    async def ensure_loaded(self) -> None:
        """Supabase から 1 回だけ読み直す（失敗したらローカルの控えのまま続ける）。"""
        if self._loaded:
            return
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._loaded:
                return
            try:
                self._data = self._clean(await self.kv.load_all())
            except Exception:
                logger.exception("サーバー設定を読み直せませんでした（ローカルの控えで続けます）")
            self._loaded = True

    def get(self, guild_id: int, section: str) -> dict[str, Any]:
        """設定の写しを返す（未設定なら空の dict）。"""
        return copy.deepcopy(self._data.get(str(guild_id), {}).get(section, {}))

    async def update(self, guild_id: int, section: str, *, background: bool = False,
                     **values: Any) -> dict[str, Any]:
        """値を書き換えて保存する。値に None を渡すとその項目を消す。"""
        await self.ensure_loaded()
        key = str(guild_id)
        guild = self._data.setdefault(key, {})
        current = guild.setdefault(section, {})
        for name, value in values.items():
            if value is None:
                current.pop(name, None)
            else:
                current[name] = value
        if not current:
            guild.pop(section, None)
        if guild:
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


# ---------------------------------------------------------------- 放置したプレイヤーの代打ち（core/autoplay.py）
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
