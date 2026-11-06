"""ゲーム用の公開操作パネルをチャンネルごとに置き換える。"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)
_active: dict[tuple[int, str], object] = {}


async def _delete(message) -> None:
    if message is None:
        return
    try:
        await message.delete()
    except Exception:
        # 既に削除済み、権限不足、テスト用の偽メッセージなどは無視する。
        log.debug("game panel deletion failed", exc_info=True)


async def replace(channel, key: str, *args, **kwargs):
    """同じチャンネル・キーの旧パネルを削除してから新しいパネルを送る。"""
    channel_id = getattr(channel, "id", None)
    if channel_id is not None:
        await _delete(_active.pop((channel_id, key), None))
    message = await channel.send(*args, **kwargs)
    if channel_id is not None:
        _active[(channel_id, key)] = message
    return message


async def clear(channel, key: str) -> None:
    """追跡中のパネルを削除する。"""
    channel_id = getattr(channel, "id", None)
    if channel_id is not None:
        await _delete(_active.pop((channel_id, key), None))
