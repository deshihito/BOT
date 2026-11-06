"""ユーザーごとのメッセージショートカット設定。"""
from __future__ import annotations

import copy
import re
from typing import Any

from core.support import guild_settings

SECTION = "message_shortcuts"
MAX_SHORTCUTS = 10
_TRIGGER_RE = re.compile(r"^\S{1,80}$")


def _all(store, guild_id: int) -> list[dict[str, Any]]:
    raw = store.get(guild_id, SECTION)
    rows = raw.get("items", []) if isinstance(raw, dict) else []
    return [copy.deepcopy(x) for x in rows if isinstance(x, dict)]


def for_user(store, guild_id: int, user_id: int) -> list[dict[str, Any]]:
    return [x for x in _all(store, guild_id) if int(x.get("user_id", 0)) == int(user_id)]


def effective_params(item: dict[str, Any]) -> dict[str, Any]:
    """保存済み item の実行時 params を正規化して返す。

    旧形式では game / help のオプションが action["options"] に保存されている。
    v2 の item["params"] があればそちらを正とし、options をその下にマージする
    （同じキーは params 側が優先）。
    """
    action = item.get("action") or {}
    params: dict[str, Any] = {}
    options = action.get("options")
    if isinstance(options, dict):
        params.update(options)
    own = item.get("params")
    if isinstance(own, dict):
        params.update(own)
    return params


def _validate_params(action: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    """vc アクションの params をレジストリの ParamSpec で検証する。

    vc は dispatch_voice_action の署名が固定なので ParamSpec が契約になる。
    game は start_game が **options をそのまま受け取る自由形式のため検証しない
    （従来動作の維持）。循環 import を避けるためレジストリは遅延 import する。
    """
    if not params or action.get("root") != "vc":
        return params
    from core.general import action_registry

    spec = action_registry.default_registry().get(f"vc:{action.get('value')}")
    if spec is None:
        return params
    return action_registry.validate_params(spec, params)


def validate_trigger(trigger: str) -> str:
    trigger = " ".join(str(trigger or "").strip().split())
    if not _TRIGGER_RE.fullmatch(trigger):
        raise ValueError("トリガーは空白を含まない1〜80文字で指定してください。")
    return trigger


async def add(store, guild_id: int, user_id: int, trigger: str, action: dict[str, Any],
              params: dict[str, Any] | None = None) -> dict[str, Any]:
    trigger = validate_trigger(trigger)
    rows = _all(store, guild_id)
    mine = [x for x in rows if int(x.get("user_id", 0)) == int(user_id)]
    if len(mine) >= MAX_SHORTCUTS:
        raise ValueError(f"ショートカットは1ユーザーにつき{MAX_SHORTCUTS}個までです。")
    if any(x.get("trigger") == trigger for x in mine):
        raise ValueError("同じトリガー名は既に登録されています。")
    item = {"id": f"{user_id}:{len(rows) + 1}", "user_id": int(user_id), "trigger": trigger,
            "action": copy.deepcopy(action)}
    if params:
        # v2: プリセット値は item["params"] に保存する（action は従来形式のまま）。
        item["params"] = copy.deepcopy(_validate_params(action, params))
    rows.append(item)
    await store.update(guild_id, SECTION, items=rows)
    return item


async def update(store, guild_id: int, user_id: int, item_id: str, trigger: str | None = None,
                 action: dict[str, Any] | None = None,
                 params: dict[str, Any] | None = None) -> dict[str, Any]:
    rows = _all(store, guild_id)
    for item in rows:
        if item.get("id") != item_id or int(item.get("user_id", 0)) != int(user_id):
            continue
        if trigger is not None:
            trigger = validate_trigger(trigger)
            if any(x.get("trigger") == trigger and x.get("id") != item_id for x in rows
                   if int(x.get("user_id", 0)) == int(user_id)):
                raise ValueError("同じトリガー名は既に登録されています。")
            item["trigger"] = trigger
        if action is not None:
            item["action"] = copy.deepcopy(action)
        if params is not None:
            # params={} は「プリセットを消す」の意味。None は変更しない。
            if params:
                base_action = action if action is not None else (item.get("action") or {})
                item["params"] = copy.deepcopy(_validate_params(base_action, params))
            else:
                item.pop("params", None)
        await store.update(guild_id, SECTION, items=rows)
        return item
    raise KeyError("ショートカットが見つかりません。")


async def remove(store, guild_id: int, user_id: int, item_id: str) -> bool:
    rows = _all(store, guild_id)
    kept = [x for x in rows if not (x.get("id") == item_id and int(x.get("user_id", 0)) == int(user_id))]
    if len(kept) == len(rows):
        return False
    await store.update(guild_id, SECTION, items=kept)
    return True


def matching(store, guild_id: int, trigger: str, user_id: int | None = None) -> list[dict[str, Any]]:
    """Return shortcuts matching a trigger, optionally restricted to an owner."""
    rows = [x for x in _all(store, guild_id) if x.get("trigger") == trigger]
    if user_id is None:
        return rows
    return [x for x in rows if int(x.get("user_id", 0)) == int(user_id)]
