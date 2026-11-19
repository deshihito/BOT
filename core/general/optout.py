# -*- coding: utf-8 -*-
"""個人オプトアウト設定（される側の拒否）。

「自分の発言を対象にしないでほしい」というユーザー単位の設定。
サーバー単位の BOT fixer（管理者の制限）とは別物で、こちらは本人が
自分の発言についてだけ決める。

- commentgacha: コメントガチャで自分の発言が掘り返されない
- imakita: 今北産業の要約材料に自分の発言が入らない

MIQ の引用拒否は既存の MIQ 設定（miq prefs の refuse）が正で、
ここには含めない（パネル側は同じ prefs を読み書きする）。

保存は他の個人設定（翻訳・AIモデル）と同じ KVStore 方式:
読み取りは load_local からの同期参照、書き込みは set。
"""
from __future__ import annotations

from typing import Any

from core.support.storage import KVStore

OPTOUT_NAMESPACE = "optout_preferences"

FEATURE_COMMENTGACHA = "commentgacha"
FEATURE_IMAKITA = "imakita"
FEATURES = (FEATURE_COMMENTGACHA, FEATURE_IMAKITA)
FEATURE_LABELS = {
    FEATURE_COMMENTGACHA: "コメントガチャで掘り返さない",
    FEATURE_IMAKITA: "今北産業の要約に使わない",
}

_store = KVStore(OPTOUT_NAMESPACE)


async def ensure_loaded() -> None:
    """保存済みの個人設定を読み込む（起動時と Cog 読込時）。"""
    await _store.load_all()


def _raw(user_id: int, store=None) -> dict[str, Any]:
    store = store or _store
    if hasattr(store, "get"):
        raw = store.get(str(user_id), {})
    else:
        raw = store.load_local().get(str(user_id), {})
    return raw if isinstance(raw, dict) else {}


def get_optouts(user_id: int, store=None) -> dict[str, bool]:
    """そのユーザーのオプトアウト状態（未設定は全て False＝対象になる）。"""
    raw = _raw(user_id, store)
    return {feature: raw.get(feature) is True for feature in FEATURES}


def is_opted_out(user_id: int | None, feature: str, store=None) -> bool:
    """そのユーザーが feature の対象から外れているか。"""
    if user_id is None or feature not in FEATURES:
        return False
    return get_optouts(user_id, store)[feature]


async def set_optout(user_id: int, feature: str, value: bool, store=None) -> dict[str, bool]:
    """オプトアウトを1件更新して保存する。全て既定（False）なら記録を消す。"""
    if feature not in FEATURES:
        raise ValueError(f"未知のオプトアウト対象です: {feature}")
    store = store or _store
    current = _raw(user_id, store)
    values = {name: current.get(name) is True for name in FEATURES}
    values[feature] = bool(value)
    if any(values.values()):
        await store.set(str(user_id), values)
    elif hasattr(store, "delete"):
        await store.delete(str(user_id))
    else:
        await store.set(str(user_id), values)
    return values


def set_store_for_tests(store) -> None:
    global _store
    _store = store
