"""ユーザーごとのAIモデル設定。"""
from __future__ import annotations

from core.storage import KVStore

_store = KVStore("ai_preferences")
_image_store = KVStore("image_preferences")
_reasoning_store = KVStore("reasoning_preferences")


async def ensure_loaded() -> None:
    await _store.load_all()
    await _image_store.load_all()
    await _reasoning_store.load_all()


def get_model(user_id: int) -> str | None:
    value = _store.load_local().get(str(user_id))
    return value if isinstance(value, str) and value.strip() else None


async def set_model(user_id: int, model: str) -> None:
    await _store.set(str(user_id), model)


async def clear_model(user_id: int) -> None:
    await _store.delete(str(user_id))


def get_image_model(user_id: int) -> str | None:
    value = _image_store.load_local().get(str(user_id))
    return value if isinstance(value, str) and value.strip() else None


async def set_image_model(user_id: int, model: str) -> None:
    await _image_store.set(str(user_id), model)


async def clear_image_model(user_id: int) -> None:
    await _image_store.delete(str(user_id))


def get_reasoning_effort(user_id: int) -> str | None:
    value = _reasoning_store.load_local().get(str(user_id))
    return value if isinstance(value, str) and value.strip() else None


async def set_reasoning_effort(user_id: int, effort: str) -> None:
    await _reasoning_store.set(str(user_id), effort)


async def clear_reasoning_effort(user_id: int) -> None:
    await _reasoning_store.delete(str(user_id))


def set_store_for_tests(store) -> None:
    global _store
    _store = store
