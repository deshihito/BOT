"""WORLD BOX の Discord チャンネル連携設定の純粋ロジック（discord 非依存）。

連携レコードは Web 側（web/lib/worldbox/chat-online.ts の
loadUnionChatSettings / storeUnionChatSettings）と同一の bot_kv
名前空間 ``worldbox_union_settings``（キー = ギルド ID）に置き、
保存形式も Web と厳密に一致させる:

    {"mode": "global" | "channel" | "none",
     "channelId": "<17〜20桁の文字列>" | null,
     "updatedAt": <ミリ秒エポック>}

を JSON 文字列化したもの。解釈規則は Web の parseUnionChatSettings
（および Bot ワーカー core/general/circulation/worldbox_discord.py の
parse_union_link）と揃える: mode "global" / "none" は channelId を
持たず、mode "channel" は正しい形式の channelId が必須、旧形式
{ chatChannelId } は mode "channel" として移行読込する。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

UNION_SETTINGS_NS = "worldbox_union_settings"
NATIONS_NS = "worldbox_nations"

LINK_MODES = ("global", "channel", "none")

_CHANNEL_ID_RE = re.compile(r"^\d{17,20}$")


def _as_dict(raw: Any) -> Optional[dict[str, Any]]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def is_channel_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_CHANNEL_ID_RE.match(value))


def parse_union_link(raw: Any) -> tuple[str, Optional[str]]:
    """連携設定を (mode, channelId) に解釈する。旧形式 chatChannelId も読む。

    Web の parseUnionChatSettings と同じ規則。不正・未保存は ("none", None)。
    """
    data = _as_dict(raw)
    if data is None:
        return ("none", None)
    mode = data.get("mode")
    if mode == "global":
        return ("global", None)
    if mode == "channel":
        channel_id = data.get("channelId")
        if is_channel_id(channel_id):
            return ("channel", channel_id)
        return ("none", None)
    if mode == "none":
        return ("none", None)
    legacy = data.get("chatChannelId")
    if is_channel_id(legacy):
        return ("channel", legacy)
    return ("none", None)


def build_union_settings_record(
    mode: str, channel_id: Optional[str], now_ms: int
) -> str:
    """保存用レコード（JSON 文字列）を Web の storeUnionChatSettings と
    同じ形で組み立てる。

    mode "global" / "none" では channelId は常に null。mode "channel" は
    正しい形式の channel_id が必須で、無ければ ValueError。
    """
    if mode not in LINK_MODES:
        raise ValueError(f"未知の連携モードです: {mode!r}")
    if mode == "channel":
        if not is_channel_id(channel_id):
            raise ValueError("mode 'channel' には正しい形式の channelId が必要です")
        stored_id: Optional[str] = channel_id
    else:
        stored_id = None
    return json.dumps(
        {"mode": mode, "channelId": stored_id, "updatedAt": int(now_ms)},
        ensure_ascii=False,
    )


def parse_nation_guild_ids(raw: Any) -> set[str]:
    """worldbox_nations の "nations" 値から国が存在するギルド ID 集合を取る。

    Bot ワーカー（worldbox_discord.parse_nation_guild_ids）と同じ規則。
    """
    data = _as_dict(raw)
    if data is None:
        return set()
    inner = data.get("nations")
    if not isinstance(inner, dict):
        return set()
    return {key for key in inner if isinstance(key, str) and key.isdigit()}


def global_reuse_channel_id(guild_channel_ids: list[int], global_channel_ids) -> Optional[int]:
    """このサーバーのグローバルチャット連携チャンネル ID（無ければ None）。

    guild_channel_ids はサーバー内のチャンネル ID、global_channel_ids は
    グローバルチャットに接続中のチャンネル ID 集合（int / str 混在可）。
    """
    global_set = {str(cid) for cid in (global_channel_ids or ())}
    for channel_id in guild_channel_ids:
        if str(channel_id) in global_set:
            return int(channel_id)
    return None


def build_link_status_fields(
    *,
    mode: str,
    channel_id: Optional[str],
    channel_name: Optional[str],
    global_channel_name: Optional[str],
    has_nation: bool,
    missing_bot_permissions: list[str],
) -> list[tuple[str, str]]:
    """パネルの状態表示フィールドを組み立てる（純粋関数）。

    channel_name は連携先（mode "channel"）をサーバー内で解決できた場合の
    チャンネル名。解決できなければ None で「見つからない」表示にする。
    global_channel_name はグローバルチャット流用時の解決先チャンネル名。
    """
    fields: list[tuple[str, str]] = []
    if mode == "channel":
        if channel_name:
            fields.append(("状態", f"専用チャンネル連携中: #{channel_name}"))
        else:
            fields.append((
                "状態",
                "専用チャンネル連携中（連携先チャンネルが見つかりません。"
                "削除された可能性があります）",
            ))
    elif mode == "global":
        if global_channel_name:
            fields.append(("状態", f"グローバルチャット流用中: #{global_channel_name}"))
        else:
            fields.append((
                "状態",
                "グローバルチャット流用中（このサーバーのグローバルチャット"
                "連携チャンネルが見つかりません）",
            ))
    else:
        fields.append(("状態", "未連携"))
    if not has_nation:
        fields.append((
            "WORLD BOX の国",
            "まだ建国されていません（連携設定は保存され、建国後にそのまま有効になります）",
        ))
    if missing_bot_permissions:
        fields.append((
            "Bot の権限",
            "連携先チャンネルで足りない権限: " + "、".join(missing_bot_permissions),
        ))
    return fields
