"""AGO WORLD BOX のユニオンチャット → Discord チャンネル連携ワーカー。

Web が bot_kv の名前空間 ``worldbox_chat_outbox`` に積んだ送信箱を読み、
連携先チャンネルへ投稿してエントリを削除する。経済ワーカー
（worldbox_economy）と同じ「Web は積むだけ、Bot が適用する」形で、
メンションは一切許可しない（allowed_mentions は呼び出し側で全無効化する）。

二重投稿の防止: 送信前に claim（status "sending" + トークン + 時刻）を
書き込み、再読込で自分の claim か確認してから投稿する。投稿成功と削除の
あいだに死んでも、次回ポーリングは新鮮な claim を見て再送しない。claim
だけ古く残ったエントリは「投稿済みか不明」なので再送せず破棄する
（安全側。チャット1行の欠落より二重投稿の害が大きい）。
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

NAMESPACE = "worldbox_chat_outbox"
POLL_SECONDS = 15.0
MAX_BATCH = 20
# 送信に失敗し続けるエントリを無限に抱えないための保持上限（秒）。
ENTRY_MAX_AGE_SECONDS = 24 * 60 * 60
#: claim がこの秒数を超えたら放棄されたものとして扱う（経済ワーカーと同じ値）。
CLAIM_STALE_SECONDS = 90.0

_CHANNEL_ID_RE = re.compile(r"^\d{17,20}$")


def _now_seconds() -> float:
    return time.time()


def _now_ms() -> int:
    return int(time.time() * 1000)


def parse_outbox_entry(raw: Any) -> dict[str, Any] | None:
    """送信箱の1件を検証して返す。壊れていれば None。

    status "sending"（claim 済み・未送信）も受理し、status と claim を
    そのまま返す。送信済み表記（"sent" 等）は受理しない。
    """
    if isinstance(raw, str):
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
    status = raw.get("status")
    if status not in (None, "pending", "sending"):
        return None
    claim = raw.get("claim")
    return {
        "id": entry_id,
        "channelId": channel_id,
        "name": name[:24],
        "text": text[:120],
        "at": float(at),
        "status": status or "pending",
        "claim": claim if isinstance(claim, dict) else None,
    }


def claim_is_fresh(claim: Any, now_seconds: float) -> bool:
    """claim（{"token", "at"(ms)}）が失効前かどうか。"""
    if not isinstance(claim, dict):
        return False
    at = claim.get("at")
    if not isinstance(at, (int, float)) or at <= 0:
        return False
    return now_seconds * 1000.0 - float(at) < CLAIM_STALE_SECONDS * 1000


def is_stale_sending_claim(raw: Any, now_seconds: float) -> bool:
    """古い claim だけが残った送信中エントリかどうか（再送せず破棄するもの）。"""
    entry = parse_outbox_entry(raw)
    if entry is None or entry.get("status") != "sending":
        return False
    return not claim_is_fresh(entry.get("claim"), now_seconds)


def select_pending(
    records: dict[str, Any], now_seconds: float, limit: int = MAX_BATCH
) -> list[tuple[str, dict[str, Any] | None]]:
    """投稿すべきエントリを古い順に選ぶ。期限切れは (key, None) で返す。

    新鮮な claim が付いたエントリ（他のワーカー／前回の自分が送信中）は
    選ばない。claim だけ古く残ったものは (key, None) で返し、呼び出し側が
    再送せず破棄する。
    """
    chosen: list[tuple[str, dict[str, Any] | None]] = []
    for key, raw in records.items():
        entry = parse_outbox_entry(raw)
        if entry is None:
            # 壊れた/送信済み表記のものは掃除対象（古ければ削除する判定は呼び出し側）
            chosen.append((key, None))
            continue
        if entry.get("status") == "sending":
            if claim_is_fresh(entry.get("claim"), now_seconds):
                continue
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
        now_seconds = _now_seconds()
        for key, entry in select_pending(records, now_seconds):
            try:
                if entry is None:
                    # 壊れた/期限切れエントリは削除して掃除する。古い claim だけが
                    # 残ったものは投稿済みか不明のため、再送せず破棄する。
                    if is_stale_sending_claim(records.get(key), now_seconds):
                        logger.warning(
                            "worldbox chat: 送信済みか不明なエントリを再送せず破棄します（key=%s）",
                            key,
                        )
                    await self._kv.delete(key)
                    handled += 1
                    continue
                token = await self._claim(key, entry)
                if token is None:
                    continue
                ok = await self._channel_sender(entry["channelId"], entry["name"], entry["text"])
                if ok:
                    try:
                        await self._kv.delete(key)
                    except Exception:
                        # 投稿は済んだが削除に失敗した。エントリは claim 付きで
                        # 残るため、claim が新鮮なあいだ再送は起きない。古くなれば
                        # 破棄される（再送はしない）。
                        logger.exception(
                            "worldbox chat: 投稿済みエントリの削除に失敗しました（key=%s）",
                            key,
                        )
                        continue
                    handled += 1
                else:
                    # 投稿できなければ claim を外して pending へ戻し、次回再試行する。
                    try:
                        released = dict(entry)
                        released["status"] = "pending"
                        released.pop("claim", None)
                        await self._kv.set(key, released)
                    except Exception:
                        logger.warning(
                            "worldbox chat: 送信失敗エントリの claim 解放に失敗しました"
                            "（key=%s）。claim が古くなれば破棄されます",
                            key,
                        )
            except Exception:
                logger.exception("worldbox chat: 投稿処理で予期しない例外（key=%s）", key)
        return handled

    async def _claim(self, key: str, entry: dict[str, Any]) -> str | None:
        """送信前に claim を書き込み、再読込で自分の claim か確認する。

        書き込み・再読込に失敗したら None（次回ポーリングに回す）。
        他のワーカーが先に claim していた場合も None。
        """
        token = uuid.uuid4().hex
        claimed = dict(entry)
        claimed["status"] = "sending"
        claimed["claim"] = {"token": token, "at": _now_ms()}
        try:
            await self._kv.set(key, claimed)
            current = await self._kv.load_one(key)
        except Exception:
            logger.warning("worldbox chat: claim の書き込みに失敗しました（key=%s）", key)
            return None
        current_entry = parse_outbox_entry(current)
        claim = current_entry.get("claim") if current_entry else None
        if (
            current_entry is None
            or current_entry.get("status") != "sending"
            or not isinstance(claim, dict)
            or claim.get("token") != token
        ):
            return None  # 他のワーカーが先に claim した / 状態が変わった
        return token
