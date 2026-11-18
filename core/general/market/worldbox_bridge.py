# -*- coding: utf-8 -*-
"""WorldBox 取引所と /general アゴトークン市場の橋渡し（bot 側）。

WorldBox（Web）は bot 側の市場状態（market.json）に直接触れないため、
売買は bot_kv の専用名前空間 `worldbox_market` を経由する:

- Web がオプ（buy / sell / convert）を status="pending" で書く。
- MarketCog のループが拾って市場の正規経路（execute と同じ検証・
  手数料・プール・コイン移動）で適用し、結果を同じレコードへ返す。
- 市場スナップショット（レート・履歴・停止状態・全員の保有量）を
  キー "snapshot" へ定期公開し、Web は表示と残高参照に使う。

適用は MarketCog のプロセス内でのみ行う（市場ストアの所有者は
MarketCog だけ）。二重適用の防止は economy ワーカーと同じ流儀:
適用前に status="processing" + claim を書いて再読込で自分の claim か
確認する。processing のまま古くなったオプは「中断」として failed に
倒す（買い・売りは冪等ではないため、再試行はしない）。
"""
from __future__ import annotations

import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))

#: bot_kv の名前空間（Web 側 web/lib/worldbox/market-online.ts と一致）。
NAMESPACE = "worldbox_market"
#: スナップショットのキー（オプのキーと衝突しない固定名）。
SNAPSHOT_KEY = "snapshot"

OP_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
DISCORD_ID_RE = re.compile(r"^\d{5,25}$")

#: 1 回のポーリングで処理するオプの上限。
MAX_BATCH = 10
#: processing のまま、このミリ秒を超えたら中断とみなす。
PROCESSING_STALE_MS = 60_000
#: スナップショットへ載せるレート履歴の件数（5 分 tick で 2 時間分）。
SNAPSHOT_HISTORY = 24

KIND_BUY = "buy"
KIND_SELL = "sell"
KIND_CONVERT = "convert"
_KINDS = (KIND_BUY, KIND_SELL, KIND_CONVERT)


def _now_ms() -> int:
    return int(time.time() * 1000)


def parse_market_op(raw: Any) -> Optional[dict[str, Any]]:
    """Web が書いたオプを検証して正規化する。不正なら None。"""
    if not isinstance(raw, dict):
        return None
    op_id = raw.get("id")
    if not isinstance(op_id, str) or not OP_ID_RE.match(op_id):
        return None
    kind = raw.get("kind")
    if kind not in _KINDS:
        return None
    user_id = raw.get("userId")
    if not isinstance(user_id, str) or not DISCORD_ID_RE.match(user_id):
        return None
    op: dict[str, Any] = {"id": op_id, "kind": kind, "userId": user_id}
    if kind == KIND_BUY:
        amount = raw.get("amountAga")
        if isinstance(amount, bool) or not isinstance(amount, int):
            return None
        if amount < 1 or amount > 1_000_000:
            return None
        op["amountAga"] = amount
    elif kind == KIND_SELL:
        amount = raw.get("tokenAmount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            return None
        amount = float(amount)
        if not (amount > 0) or amount > 1_000_000:
            return None
        op["tokenAmount"] = amount
    else:  # convert
        count = raw.get("count")
        if isinstance(count, bool) or not isinstance(count, int):
            return None
        if count < 1 or count > 100_000:
            return None
        op["count"] = count
    return op


def build_snapshot(store: Any, now: datetime | None = None) -> dict[str, Any]:
    """市場の表示用スナップショット（Web の取引所タブが読む）。"""
    now = now or datetime.now(JST)
    state = store.snapshot()
    halted, reason = store.halt_status(now)
    history = [
        {"t": str(entry.get("t") or ""), "rate": float(entry.get("rate") or 0)}
        for entry in state.get("history", [])[-SNAPSHOT_HISTORY:]
    ]
    return {
        "rate": float(state.get("rate") or 0),
        "history": history,
        "halted": halted,
        "haltReason": reason if halted else "",
        "tradeCapAga": store.trade_cap_aga(),
        "balances": {
            str(user_id): float(amount)
            for user_id, amount in (state.get("balances") or {}).items()
        },
        "updatedAt": now.astimezone(JST).isoformat(),
    }


#: 実行側（MarketCog）の構造化売買。成功/失敗を dict で返す。
BuyFn = Callable[[int, int], Awaitable[dict[str, Any]]]
SellFn = Callable[[int, float], Awaitable[dict[str, Any]]]
ConvertFn = Callable[[int, int], Awaitable[dict[str, Any]]]
SnapshotFn = Callable[[], dict[str, Any]]


class WorldBoxMarketBridge:
    """bot_kv のオプを市場の正規経路へ適用し、結果とスナップショットを返す。"""

    def __init__(
        self,
        *,
        kv: Any,
        buy: BuyFn,
        sell: SellFn,
        convert: ConvertFn,
        snapshot: SnapshotFn,
    ) -> None:
        self._kv = kv
        self._buy = buy
        self._sell = sell
        self._convert = convert
        self._snapshot = snapshot

    async def publish_snapshot(self) -> None:
        await self._kv.set(SNAPSHOT_KEY, self._snapshot(), wait=True)

    async def poll_once(self, limit: int = MAX_BATCH) -> int:
        """pending オプを処理し、処理件数を返す。"""
        records = await self._kv.load_all()
        if not isinstance(records, dict):
            return 0
        handled = 0
        for key, raw in records.items():
            if handled >= limit:
                break
            if key == SNAPSHOT_KEY or not isinstance(raw, dict):
                continue
            status = raw.get("status")
            if status == "pending":
                if await self._process_one(key, raw):
                    handled += 1
            elif status == "processing":
                started = raw.get("processingAt")
                if isinstance(started, (int, float)) and _now_ms() - int(started) > PROCESSING_STALE_MS:
                    await self._kv.set(key, {
                        **raw,
                        "status": "failed",
                        "error": "取引が中断されました。時間をおいて再試行してください。",
                        "appliedAt": _now_ms(),
                    }, wait=True)
                    handled += 1
        if handled:
            try:
                await self.publish_snapshot()
            except Exception:
                logger.exception("worldbox market: スナップショットの公開に失敗しました")
        return handled

    async def _process_one(self, key: str, raw: dict[str, Any]) -> bool:
        op = parse_market_op(raw)
        if op is None or op["id"] != key:
            await self._kv.set(key, {
                **raw,
                "status": "failed",
                "error": "取引の形式が正しくありません。",
                "appliedAt": _now_ms(),
            }, wait=True)
            return True
        # claim: processing を書いて再読込し、自分の claim のときだけ適用する。
        claim = secrets.token_hex(8)
        await self._kv.set(key, {
            **raw,
            "status": "processing",
            "claim": claim,
            "processingAt": _now_ms(),
        }, wait=True)
        current = await self._kv.load_one(key)
        if not isinstance(current, dict) or current.get("claim") != claim:
            return False
        user_id = int(op["userId"])
        try:
            if op["kind"] == KIND_BUY:
                result = await self._buy(user_id, int(op["amountAga"]))
            elif op["kind"] == KIND_SELL:
                result = await self._sell(user_id, float(op["tokenAmount"]))
            else:
                result = await self._convert(user_id, int(op["count"]))
        except Exception:
            logger.exception("worldbox market: 適用に失敗 op=%s", op["id"])
            result = {"ok": False, "error": "取引中にエラーが発生しました。時間をおいて再試行してください。"}
        if result.get("ok"):
            record = {**raw, "status": "done", "result": result, "appliedAt": _now_ms()}
        else:
            record = {
                **raw,
                "status": "failed",
                "error": str(result.get("error") or "取引できませんでした。"),
                "appliedAt": _now_ms(),
            }
        await self._kv.set(key, record, wait=True)
        return True
