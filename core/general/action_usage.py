"""アクションの利用履歴（ユーザ個人単位の「よく使う／最近使った」）。

集計範囲はギルド×ユーザの個人単位のみで、サーバー全体の人気集計はしない
（仕様書 D-2 の決定）。保存先は guild_settings ストアの新規セクション
``action_usage`` で、ユーザごとに ``{"recent": [...], "counts": {...}}`` を持つ。

- recent: 新しい順・重複なし・最大 ``MAX_RECENT`` 件の action id
- counts: レジストリ登録済み action id だけの利用回数。フットプリントは
  小さいため保持期間は設けない

記録が失敗しても呼び出し側（dispatch）を壊さないことが前提なので、
``record`` 側のエラーは呼び出し側で握る想定だが、このモジュール自体も
不正な action id を黙って捨てるなど防御的に作る。
"""
from __future__ import annotations

import asyncio
import copy
import logging
from typing import Any, Iterable

from core.general import action_registry

logger = logging.getLogger(__name__)

SECTION = "action_usage"
MAX_RECENT = 10


def _all(store, guild_id: int) -> dict[str, Any]:
    raw = store.get(guild_id, SECTION)
    return copy.deepcopy(raw) if isinstance(raw, dict) else {}


def _for_user(store, guild_id: int, user_id: int) -> dict[str, Any]:
    entry = _all(store, guild_id).get(str(user_id))
    if not isinstance(entry, dict):
        return {"recent": [], "counts": {}}
    recent = [x for x in entry.get("recent", []) if isinstance(x, str)]
    counts = {
        str(k): int(v)
        for k, v in (entry.get("counts") or {}).items()
        if isinstance(v, int) or (isinstance(v, str) and v.isdigit())
    }
    return {"recent": recent, "counts": counts}


async def record(store, guild_id: int, user_id: int, action_id: str) -> None:
    """アクションの利用を1回分記録する（recent の先頭へ移動＋回数を加算）。"""
    if guild_id is None or user_id is None:
        return
    if action_registry.default_registry().get(action_id) is None:
        # レジストリに無い id は保持しない（counts の対象を登録済みに限る）。
        return
    data = _all(store, guild_id)
    entry = _for_user(store, guild_id, user_id)
    recent = [x for x in entry["recent"] if x != action_id]
    recent.insert(0, action_id)
    entry["recent"] = recent[:MAX_RECENT]
    counts = dict(entry["counts"])
    counts[action_id] = counts.get(action_id, 0) + 1
    entry["counts"] = counts
    data[str(user_id)] = entry
    await store.update(guild_id, SECTION, **data)


def recent_for(store, guild_id: int, user_id: int) -> list[str]:
    """最近使った action id を新しい順（重複なし・最大10件）で返す。"""
    return _for_user(store, guild_id, user_id)["recent"][:MAX_RECENT]


def frequent_for(store, guild_id: int, user_id: int) -> list[tuple[str, int]]:
    """(action id, 利用回数) を回数の多い順に返す（同数は id 順で安定させる）。"""
    counts = _for_user(store, guild_id, user_id)["counts"]
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def history_panel_specs(
    store,
    guild_id: int,
    user_id: int,
    root: str,
    *,
    limit: int = 10,
    registry: action_registry.ActionRegistry | None = None,
) -> list[action_registry.ActionSpec]:
    """パネルの「よく使う／最近」用に、そのルートの ActionSpec を並べて返す。

    対象は surfaces に "panel" を含むアクションだけ。よく使う（frequent）上位を
    先に並べ、残りを最近使った順で補い、最大 limit 件にする。
    履歴が空（または対象が無い）ときは空リストを返す（呼び出し側は
    セクション自体を出さないことで従来の見た目を保つ）。
    """
    registry = registry or action_registry.default_registry()
    allowed: dict[str, action_registry.ActionSpec] = {}
    for action_id in {aid for aid, _count in frequent_for(store, guild_id, user_id)} | set(
        recent_for(store, guild_id, user_id)
    ):
        spec = registry.get(action_id)
        if spec is not None and spec.root == root and "panel" in spec.surfaces:
            allowed[action_id] = spec

    ordered: list[str] = []
    for action_id, _count in frequent_for(store, guild_id, user_id):
        if action_id in allowed and action_id not in ordered:
            ordered.append(action_id)
    for action_id in recent_for(store, guild_id, user_id):
        if action_id in allowed and action_id not in ordered:
            ordered.append(action_id)
    return [allowed[action_id] for action_id in ordered[:limit]]


async def record_safely(
    guild_id: int | None,
    user_id: int | None,
    action_id: str,
    *,
    store: Any = None,
) -> None:
    """dispatch 入口からの記録用ラッパ。失敗しても例外を外へ出さない。

    guild_settings の既定ストアを使う。dispatch の応答を妨げないため、
    保存（非同期）の失敗も含めてすべて握る。
    """
    try:
        if guild_id is None or user_id is None:
            return
        if store is None:
            from core.support import guild_settings

            store = guild_settings.get_store()
        await record(store, int(guild_id), int(user_id), action_id)
    except Exception:
        logger.debug("action usage record failed: %s", action_id, exc_info=True)


# 応答を待たせない記録タスクの保持場所（GC で消えないよう強参照で持つ）。
_background_tasks: set[asyncio.Task] = set()


def record_safely_in_background(
    guild_id: int | None,
    user_id: int | None,
    action_id: str,
    *,
    store: Any = None,
) -> asyncio.Task | None:
    """``record_safely`` をバックグラウンドで実行し、呼び出し側を待たせない。

    guild_settings の保存は KVStore 経由で自前APIへの書き込み（HTTP）を
    伴うため、dispatch の入口で await すると Raspberry Pi では
    panel_recovery の生存判定（RECOVERY_WAIT_SECONDS）を圧迫し、生存中の
    パネルが「死んだパネル」と誤判定される。記録の成否は応答に影響しない
    ので、パネル系 dispatch からはこちらを使う。実行中ループが無い場合は
    何もせず None を返す。
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    task = loop.create_task(record_safely(guild_id, user_id, action_id, store=store))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task
