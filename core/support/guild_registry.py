"""Bot が参加しているサーバーの一覧（Web ダッシュボードの導入判定用）。

core/support/storage.py（自前API の bot_kv、namespace "guild_registry"）に、サーバーごとに
``{"name": ..., "member_count": ..., "icon": ..., "updated_at": ...}`` を保存する。
Web ダッシュボードはこの一覧を「Bot が導入されているサーバー」の正として読む
（設定の有無では判定できないため）。

加えて、ダッシュボードのチャンネル/ロール選択UIのために、サーバー構造の
スナップショット（channels / roles / bots / bot: ID・名前・種別・並び順のみ。
メッセージ内容や一般メンバーの個人情報は載せない）も同じ値に含める。

起動時（on_ready）に全件を書き直し、参加・退出のたびに 1 件だけ更新する。
構造の定期更新は公開ランキング Cog の1時間ループが sync_all を兼ねる。
書き込みはすべて background（失敗しても Bot の動作は止めない。次回起動時に直る）。
"""
from __future__ import annotations

import datetime
import logging
from typing import Any, Optional

from core.support.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "guild_registry"
HISTORY_NAMESPACE = "guild_history"


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def count_recent_joins(events: Any, *, now: datetime.datetime, days: int) -> int:
    """履歴イベントの一覧から、直近 days 日以内の joined 件数を数える（純粋関数）。"""
    if not isinstance(events, (list, tuple)):
        return 0
    cutoff = now - datetime.timedelta(days=days)
    total = 0
    for event in events:
        if not isinstance(event, dict) or event.get("event") != "joined":
            continue
        at = event.get("at")
        if not isinstance(at, str):
            continue
        try:
            when = datetime.datetime.fromisoformat(at)
        except ValueError:
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        if when >= cutoff:
            total += 1
    return total


def _structure(guild: Any) -> dict[str, Any]:
    """ダッシュボードのセレクタ用に、サーバー構造の最小スナップショットを作る。

    載せるのは ID・名前・種別・並び順のみ（チャンネル種別は discord.py の
    ChannelType の数値）。bots はメンバーキャッシュに居る bot アカウントの
    ベストエフォート（キャッシュが不完全な環境では欠けることがある）。
    """
    channels: list[dict[str, Any]] = []
    for channel in getattr(guild, "channels", None) or []:
        channel_id = getattr(channel, "id", None)
        if not isinstance(channel_id, int) or isinstance(channel_id, bool):
            continue
        ctype = getattr(channel, "type", None)
        channels.append({
            "id": str(channel_id),
            "name": str(getattr(channel, "name", "") or ""),
            "type": int(getattr(ctype, "value", 0) or 0),
            "position": int(getattr(channel, "position", 0) or 0),
        })
    channels.sort(key=lambda item: (item["position"], int(item["id"])))

    roles: list[dict[str, Any]] = []
    for role in getattr(guild, "roles", None) or []:
        role_id = getattr(role, "id", None)
        if not isinstance(role_id, int) or isinstance(role_id, bool):
            continue
        roles.append({
            "id": str(role_id),
            "name": str(getattr(role, "name", "") or ""),
            "position": int(getattr(role, "position", 0) or 0),
        })
    roles.sort(key=lambda item: (-item["position"], int(item["id"])))

    bots: list[dict[str, str]] = []
    for member in getattr(guild, "members", None) or []:
        member_id = getattr(member, "id", None)
        if not getattr(member, "bot", False):
            continue
        if not isinstance(member_id, int) or isinstance(member_id, bool):
            continue
        bots.append({
            "id": str(member_id),
            "name": str(getattr(member, "display_name", None) or getattr(member, "name", "") or ""),
        })
    bots.sort(key=lambda item: int(item["id"]))

    me = getattr(guild, "me", None)
    me_id = getattr(me, "id", None) if me is not None else None
    bot_info = None
    if isinstance(me_id, int) and not isinstance(me_id, bool):
        bot_info = {
            "id": str(me_id),
            "name": str(getattr(me, "display_name", None) or getattr(me, "name", "") or ""),
        }

    return {"channels": channels, "roles": roles, "bots": bots, "bot": bot_info}


def _guild_value(guild: Any) -> dict[str, Any]:
    icon = getattr(guild, "icon", None)
    icon_key = getattr(icon, "key", None) if icon is not None else None
    return {
        "name": str(getattr(guild, "name", "") or ""),
        "member_count": int(getattr(guild, "member_count", 0) or 0),
        "icon": icon_key if isinstance(icon_key, str) else None,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **_structure(guild),
    }


class GuildRegistry:
    def __init__(self, kv: Optional[KVStore] = None, history_kv: Optional[KVStore] = None):
        self.kv = kv or KVStore(NAMESPACE)
        self.history_kv = history_kv or KVStore(HISTORY_NAMESPACE)

    async def record(self, guild: Any) -> None:
        try:
            await self.kv.set(str(int(guild.id)), _guild_value(guild), wait=False)
        except Exception:
            logger.exception("サーバー一覧への登録に失敗しました: guild=%s", getattr(guild, "id", "?"))

    async def record_event(self, guild: Any, event: str) -> None:
        """導入履歴にイベントを追記する（スナップショットとは別 namespace）。

        履歴はこの機能のデプロイ時点から始まる。on_guild_remove でも消さない
        （導入数と継続数の両方を見るため）。event は "joined" / "removed"。
        """
        if event not in ("joined", "removed"):
            return
        try:
            at = _now_iso()
            guild_id = str(int(guild.id))
            value = _guild_value(guild)
            key = f"{at}:{guild_id}:{event}"
            await self.history_kv.set(key, {
                "guild_id": guild_id,
                "name": value["name"],
                "member_count": value["member_count"],
                "event": event,
                "at": at,
            }, wait=False)
        except Exception:
            logger.exception("導入履歴への記録に失敗しました: guild=%s event=%s", getattr(guild, "id", "?"), event)

    async def load_history(self) -> list[dict[str, Any]]:
        try:
            rows = await self.history_kv.load_all()
        except Exception:
            logger.exception("導入履歴を読み込めませんでした")
            return []
        return [value for value in rows.values() if isinstance(value, dict)]

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
