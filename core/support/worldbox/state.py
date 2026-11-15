"""WORLD BOX 状態パネルの表示行を作る純粋ロジック（discord 非依存）。

Web が bot_kv に書いたレコード（worldbox_profiles / worldbox_presence /
worldbox_save / worldbox_nations）から、Discord パネルの表示行を組み立てる。
"""

from __future__ import annotations

import json
from typing import Any, Optional

PROFILES_NS = "worldbox_profiles"
PRESENCE_NS = "worldbox_presence"
SAVE_NS = "worldbox_save"
NATIONS_NS = "worldbox_nations"

ROLE_NAMES = {
    "free": "自由人",
    "blade": "剣士",
    "guard": "守護",
    "scout": "斥候",
    "miner": "採掘者",
    "medic": "薬師",
}


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


def build_state_lines(
    *,
    user_id: str,
    balance: Optional[int],
    profile: Optional[dict[str, Any]],
    presence: Optional[dict[str, Any]],
    save: Optional[dict[str, Any]],
    nation_name: Optional[str],
    nation_role: Optional[str],
) -> list[str]:
    """パネルの表示行を作る（純粋関数）。データが無い項目は「なし」と出す。"""
    lines = [f"## WORLD BOX 状態: {user_id}"]
    lines.append(f"残高: {balance:,} コイン" if balance is not None else "残高: 取得できませんでした")
    if profile is None:
        lines.append("プロフィール: なし（未プレイ）")
        return lines
    hp = profile.get("hp", 100)
    hunger = profile.get("hunger", 100)
    role = ROLE_NAMES.get(str(profile.get("role", "free")), "自由人")
    mastery = profile.get("mastery") or {}
    rank = 1
    if isinstance(mastery, dict):
        entry = mastery.get(str(profile.get("role", "free")))
        if isinstance(entry, dict):
            xp = entry.get("xp", 0)
            rank = 1 + sum(1 for t in (30, 80, 160, 300) if isinstance(xp, (int, float)) and xp >= t)
    lines.append(f"HP {hp} / 空腹 {hunger} / 役職 {role}（熟練ランク {rank}）")
    items = profile.get("items") or {}
    total = 0
    top: list[tuple[str, int]] = []
    if isinstance(items, dict):
        for item_id, count in items.items():
            if isinstance(count, (int, float)) and count > 0:
                total += int(count)
                top.append((str(item_id), int(count)))
    top.sort(key=lambda kv: -kv[1])
    top_text = "、".join(f"{item_id}×{count}" for item_id, count in top[:5])
    lines.append(f"所持品: 計 {total} 個" + (f"（{top_text}）" if top_text else ""))
    if presence is not None:
        lines.append(
            f"現在地: {presence.get('space', '?')} ({presence.get('x', '?')}, {presence.get('y', '?')})"
        )
    elif save is not None:
        lines.append(
            f"最終位置: {save.get('space', '?')} ({save.get('x', '?')}, {save.get('y', '?')})"
        )
    else:
        lines.append("現在地: 不明")
    if nation_name:
        lines.append(f"所属ユニオン: {nation_name}（{nation_role or '国民'}）")
    else:
        lines.append("所属ユニオン: なし")
    return lines


