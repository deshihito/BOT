# -*- coding: utf-8 -*-
"""損失還流プール＋国庫（経済系の共有カウンタ）の単一の置き場。

原典（パンBot）の mining の核だった仕組み: ユーザーの経済的損失が
消えて終わりにならず、その一部が「採掘プール」にチャージされ、
残りが「国庫」に積み上がる。採掘のコインは新規創出ではなく
このプールから支払われる（原典の global_pool / economy_coin）。

AGO での内訳（ユーザー指示 2026-11-06）: 損失の 70% を採掘プール、
30% を国庫へ（定数 POOL_SHARE）。端数は国庫側に寄せ、還流の前後で
合計が保存されるようにする。なお原典コードの実装は double /
blackjack の損失で 30% プール / 70% 国庫だった（ダイスは 30% のみ
プール、スロットのペナルティ・没収は一部のみ還流）。AGO では
ユーザー指示の 70/30 に統一し、対象の損失の範囲は原典に寄せる。

還流の発生源（cogs 側から add_loss を呼ぶ）:
- ギャンブル: スロットのセッション純損失・ペナルティ・全額没収、
  ダブルアップのベット喪失、ブラックジャックのベット喪失、
  ダイスのベット喪失（cogs/gambling.py）
- 市場の手数料の消却分（cogs/market.py）
- 宝くじの消却分（cogs/circulation.py の抽選確定）

国庫は v1 では蓄積と残高保持のみ（使い道は将来用）。残高は
管理コマンド（!all_stats）から参照できる。

保存は core/general/items.py と同じ流儀: 専用 JSON（既定 data/economy_pool.json、
環境変数 ECONOMY_POOL_DATA_PATH で変更可）にメモリ主体＋
バッチフラッシュ＋原子差し替え。複数 cog が同じ状態を触るため、
プロセス内で共有する単一インスタンスを shared_store() で返す。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: 還流の内訳: 損失のうち採掘プールへ行く割合（残りは国庫）。
#: ユーザー指示（2026-11-06）の 70/30。端数は国庫側に寄せる。
POOL_SHARE = 0.7

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _empty_state() -> dict[str, Any]:
    return {"pool": 0, "treasury": 0, "total_recycled": 0, "total_paid": 0}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    for key in state:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            state[key] = value
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "economy_pool.json"


def default_path() -> Path:
    return Path(os.environ.get("ECONOMY_POOL_DATA_PATH") or _DEFAULT_PATH)


class EconomyPoolStore:
    """採掘プールと国庫の残高（同期 API、メモリ主体＋バッチフラッシュ）。"""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
        self._flush_every = max(1, int(flush_every))
        self._flush_interval = float(flush_interval)
        self._lock = threading.RLock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._state = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return _empty_state()
        return _clean_state(raw)

    def flush(self) -> None:
        with self._lock:
            payload = copy.deepcopy(self._state)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("economy_pool: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 残高
    def pool_balance(self) -> int:
        with self._lock:
            return int(self._state["pool"])

    def treasury_balance(self) -> int:
        with self._lock:
            return int(self._state["treasury"])

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {key: int(value) for key, value in self._state.items()}

    # ------------------------------------------------------------------ 還流
    def add_loss(self, amount: int) -> dict[str, int]:
        """損失を還流する。プール分と国庫分に分けて加算し、内訳を返す。

        0 以下は無視する。プール分＋国庫分は元の損失額と一致する
        （端数は国庫側）。新規創出ではなく、消えた分の再配置。
        """
        amount = int(amount)
        if amount <= 0:
            return {"pool": 0, "treasury": 0}
        pool_part = int(amount * POOL_SHARE)
        treasury_part = amount - pool_part
        with self._lock:
            self._state["pool"] = int(self._state["pool"]) + pool_part
            self._state["treasury"] = int(self._state["treasury"]) + treasury_part
            self._state["total_recycled"] = (
                int(self._state["total_recycled"]) + amount)
            self._mark_dirty()
        return {"pool": pool_part, "treasury": treasury_part}

    def pay(self, amount: int) -> int:
        """プールから支払う。残高が不足する場合はある分だけ払い、実額を返す。"""
        amount = int(amount)
        if amount <= 0:
            return 0
        with self._lock:
            paid = min(amount, int(self._state["pool"]))
            if paid <= 0:
                return 0
            self._state["pool"] = int(self._state["pool"]) - paid
            self._state["total_paid"] = int(self._state["total_paid"]) + paid
            self._mark_dirty()
            return paid

    def refund(self, amount: int) -> None:
        """支払った分をプールへ戻す（受け手側の反映に失敗したとき用）。"""
        amount = int(amount)
        if amount <= 0:
            return
        with self._lock:
            self._state["pool"] = int(self._state["pool"]) + amount
            self._state["total_paid"] = max(
                0, int(self._state["total_paid"]) - amount)
            self._mark_dirty()


_shared_store: EconomyPoolStore | None = None
_shared_lock = threading.Lock()


def shared_store() -> EconomyPoolStore:
    """プロセス共有の単一インスタンス（複数 cog が同じ残高を触るため）。"""
    global _shared_store
    if _shared_store is None:
        with _shared_lock:
            if _shared_store is None:
                _shared_store = EconomyPoolStore()
    return _shared_store
