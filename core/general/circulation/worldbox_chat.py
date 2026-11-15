"""AGO WORLD BOX のユニオンチャット → Discord チャンネル連携ワーカー。

Web が bot_kv の名前空間 ``worldbox_chat_outbox`` に積んだ送信箱を読み、
連携先チャンネルへ投稿してエントリを削除する。経済ワーカー
（worldbox_economy）と同じ「Web は積むだけ、Bot が適用する」形で、
メンションは一切許可しない（allowed_mentions は呼び出し側で全無効化する）。
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

NAMESPACE = "worldbox_chat_outbox"
POLL_SECONDS = 15.0
MAX_BATCH = 20
# 送信に失敗し続けるエントリを無限に抱えないための保持上限（秒）。
ENTRY_MAX_AGE_SECONDS = 24 * 60 * 60

_CHANNEL_ID_RE = re.compile(r"^\d{17,20}$")


def _now_seconds() -> float:
    return time.time()


def parse_outbox_entry(raw: Any) -> dict[str, Any] | None:
    """送信箱の1件を検証して返す。壊れていれば None。"""
    if isinstance(raw, str):
        import json

        try:
            raw = json.loads(raw)
        except Exception:
            return None
    if not isinstance(raw, dict):
        return None
    entry_id = raw.get("id")
    channel_id = raw.get("channelId")
    name = raw.get("name")
    text = raw.get("text")
    at = raw.get("at")
    if not isinstance(entry_id, str) or not entry_id:
        return None
    if not isinstance(channel_id, str) or not _CHANNEL_ID_RE.match(channel_id):
        return None
    if not isinstance(name, str) or not isinstance(text, str) or not text:
        return None
    if not isinstance(at, (int, float)) or at <= 0:
        return None
    if raw.get("status") not in (None, "pending"):
        return None
    return {
        "id": entry_id,
        "channelId": channel_id,
        "name": name[:24],
        "text": text[:120],
        "at": float(at),
    }


def select_pending(
    records: dict[str, Any], now_seconds: float, limit: int = MAX_BATCH
) -> list[tuple[str, dict[str, Any]]]:
    """投稿すべきエントリを古い順に選ぶ。期限切れは (key, None) で返す。"""
    chosen: list[tuple[str, dict[str, Any] | None]] = []
    for key, raw in records.items():
        entry = parse_outbox_entry(raw)
        if entry is None:
            # 壊れた/送信済み表記のものは掃除対象（古ければ削除する判定は呼び出し側）
            chosen.append((key, None))
            continue
        if now_seconds - entry["at"] / 1000.0 > ENTRY_MAX_AGE_SECONDS:
            chosen.append((key, None))
            continue
        chosen.append((key, entry))
    chosen.sort(key=lambda kv: (kv[1]["at"] if kv[1] else 0.0))
    return [(k, v) for k, v in chosen[:limit]]  # type: ignore[misc]


class WorldBoxChatWorker:
    """送信箱を読み、チャンネル解決関数経由で投稿するワーカー。"""

    def __init__(
        self,
        *,
        kv: Any,
        channel_sender: Callable[[str, str, str], Awaitable[bool]],
    ) -> None:
        # kv: core.support.storage.KVStore（load_all / delete を使う）
        self._kv = kv
        # channel_sender(channel_id, name, text) -> 投稿できたら True
        self._channel_sender = channel_sender
        self._remote_down = False

    async def poll_once(self) -> int:
        """送信箱を1バッチ処理する。投稿（終端化）した件数を返す。

        kv の読み取りに失敗したら 0 を返して次回に回す（例外は外へ出さない）。
        """
        try:
            records = await self._kv.load_all()
        except Exception:
            if not self._remote_down:
                logger.warning("worldbox chat: bot_kv の読み取りに失敗しました（次回再試行）")
            self._remote_down = True
            return 0
        if self._remote_down:
            logger.info("worldbox chat: bot_kv への接続が回復しました")
            self._remote_down = False
        if not isinstance(records, dict) or not records:
            return 0
        handled = 0
        for key, entry in select_pending(records, _now_seconds()):
            try:
                if entry is None:
                    # 壊れた/期限切れエントリは削除して掃除する
                    await self._kv.delete(key)
                    handled += 1
                    continue
                ok = await self._channel_sender(entry["channelId"], entry["name"], entry["text"])
                if ok:
                    await self._kv.delete(key)
                    handled += 1
                # 投稿できなければ残して次回再試行（保持上限で掃除される）
            except Exception:
                logger.exception("worldbox chat: 投稿処理で予期しない例外（key=%s）", key)
        return handled
