"""Bot が参加しているサーバーの一覧（Web ダッシュボードの導入判定用）。

core/storage.py（自前API の bot_kv、namespace "guild_registry"）に、サーバーごとに
``{"name": ..., "member_count": ..., "icon": ..., "updated_at": ...}`` を保存する。
Web ダッシュボードはこの一覧を「Bot が導入されているサーバー」の正として読む
（設定の有無では判定できないため）。

起動時（on_ready）に全件を書き直し、参加・退出のたびに 1 件だけ更新する。
書き込みはすべて background（失敗しても Bot の動作は止めない。次回起動時に直る）。
"""
from __future__ import annotations

import datetime
import logging
from typing import Any, Optional

from core.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "guild_registry"


def _guild_value(guild: Any) -> dict[str, Any]:
    icon = getattr(guild, "icon", None)
    icon_key = getattr(icon, "key", None) if icon is not None else None
    return {
        "name": str(getattr(guild, "name", "") or ""),
        "member_count": int(getattr(guild, "member_count", 0) or 0),
        "icon": icon_key if isinstance(icon_key, str) else None,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


class GuildRegistry:
    def __init__(self, kv: Optional[KVStore] = None):
        self.kv = kv or KVStore(NAMESPACE)

    async def record(self, guild: Any) -> None:
        try:
            await self.kv.set(str(int(guild.id)), _guild_value(guild), wait=False)
        except Exception:
            logger.exception("サーバー一覧への登録に失敗しました: guild=%s", getattr(guild, "id", "?"))

    async def remove(self, guild_id: int) -> None:
        try:
            await self.kv.delete(str(int(guild_id)), wait=False)
        except Exception:
            logger.exception("サーバー一覧からの削除に失敗しました: guild=%s", guild_id)

    async def sync_all(self, guilds: Any) -> None:
        """参加中サーバーの全件を書き直し、一覧に残っている抜けたサーバーを消す。"""
        try:
            current = await self.kv.load_all()
        except Exception:
            logger.exception("サーバー一覧を読み込めませんでした（登録だけ続けます）")
            current = {}
        seen: set[str] = set()
        for guild in guilds:
            guild_id = getattr(guild, "id", None)
            if not isinstance(guild_id, int) or isinstance(guild_id, bool):
                continue
            seen.add(str(guild_id))
            await self.record(guild)
        for key in list(current):
            if key not in seen:
                await self.remove(int(key))


_registry: Optional[GuildRegistry] = None


def get_registry() -> GuildRegistry:
    global _registry
    if _registry is None:
        _registry = GuildRegistry()
    return _registry


def set_registry(registry: Optional[GuildRegistry]) -> None:
    """テスト用: 保存先を差し替える（None で既定に戻す）。"""
    global _registry
    _registry = registry
