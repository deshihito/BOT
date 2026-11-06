# -*- coding: utf-8 -*-
"""宝くじ（日次ラッフル）の単一の置き場。

パンBot 資産移植 Phase 4（構成案 第4層）。コインの sink とグローバルな
賞金プールを兼ねる日次宝くじ。仕組みは番号選択式ではなく、チケットの
口数で重み付けするラッフル方式（v1 では番号選択は採用しない）。

分配ルール（定義として固定する）:
- プールはチケット売上の集積＋前回からの繰越で構成する。
- 抽選時にプールの 90% を賞金に充て、残り 10% はシンクとして消却する。
- 賞金は当選者数に応じた配分率で分ける: 当選候補が3人以上なら
  1等 50% / 2等 30% / 3等 20%、2人なら 65% / 35%、1人なら全額。
  当選者は重み付き抽選で重複なく選ぶ。各賞金は整数への切り捨てで、
  端数は次回プールへ繰り越す（90% の払戻は端数分も含めて守る）。
- 購入がゼロだった回は抽選を行わず、プール全額を次回へ繰り越す。

抽選タイミングは毎日 JST 21:00（定数 DRAW_HOUR）。常駐タスクは持たず、
市場 tick と同じ流儀の時刻チェック＋ lazy 決済: 期限を過ぎた回は
次回アクセス／定期チェックで確定する。賞金のコイン実移動は呼び出し側
（cogs/circulation.py）が wallet の安全な経路で行う。

保存は core/workshop.py と同じ流儀: 専用 JSON（既定 data/lottery.json、
環境変数 LOTTERY_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from core.general.items import JST, ItemError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（Phase 4 の暫定値。価格・上限の絶対値は AGO のコイン分布の
# 実測後に調整する）
# ---------------------------------------------------------------------------

#: チケット1枚の価格（AGO）。
TICKET_PRICE = 100

#: 1人あたり・1回（1日）あたりの購入上限（枚）。
MAX_TICKETS_PER_USER = 10

#: 払戻率。プールのこの割合を賞金に充て、残りはシンクとして消却する。
PAYOUT_RATE = 0.90

#: 抽選時刻（JST の時。毎日この時刻に締め切る）。
DRAW_HOUR = 21

#: 当選者数ごとの賞金配分率（合計は必ず1.0）。キーは当選者数で、
#: 候補者がこれより多い場合は3人分を使う。
PRIZE_SHARES: dict[int, tuple[float, ...]] = {
    1: (1.0,),
    2: (0.65, 0.35),
    3: (0.5, 0.3, 0.2),
}

#: 保持する過去結果の件数。
HISTORY_LIMIT = 30

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def next_draw_time(after: datetime) -> datetime:
    """after の次に来る抽選時刻（JST、その日の DRAW_HOUR、過ぎていれば翌日）。"""
    after = after.astimezone(JST)
    candidate = after.replace(hour=DRAW_HOUR, minute=0, second=0, microsecond=0)
    if candidate <= after:
        candidate += timedelta(days=1)
    return candidate


def _empty_state() -> dict[str, Any]:
    return {"round": None, "history": []}


def _clean_round(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    round_id = raw.get("id")
    pool = raw.get("pool")
    closes_at = raw.get("closes_at")
    tickets_raw = raw.get("tickets")
    if not (isinstance(round_id, int) and isinstance(pool, int)
            and isinstance(closes_at, str) and isinstance(tickets_raw, dict)):
        return None
    tickets = {}
    for uid, count in tickets_raw.items():
        if isinstance(count, int) and count > 0:
            tickets[str(uid)] = int(count)
    boost = raw.get("boost")
    return {"id": round_id, "pool": max(0, pool), "tickets": tickets,
            "closes_at": closes_at,
            "boost": int(boost) if isinstance(boost, int) and boost > 0 else 0}


def _clean_history(raw: Any) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return history
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        winners = []
        for winner in entry.get("winners") or []:
            if (isinstance(winner, dict) and isinstance(winner.get("user_id"), str)
                    and isinstance(winner.get("prize"), int)):
                winners.append({
                    "user_id": winner["user_id"],
                    "tickets": int(winner.get("tickets") or 0),
                    "prize": int(winner["prize"]),
                })
        history.append({
            "round_id": int(entry.get("round_id") or 0),
            "drawn_at": str(entry.get("drawn_at") or ""),
            "pool": int(entry.get("pool") or 0),
            "payout": int(entry.get("payout") or 0),
            "burned": int(entry.get("burned") or 0),
            "carryover": int(entry.get("carryover") or 0),
            "boost": int(entry.get("boost") or 0),
            "winners": winners,
        })
    return history[-HISTORY_LIMIT:]


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    state["round"] = _clean_round(raw.get("round"))
    state["history"] = _clean_history(raw.get("history"))
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "lottery.json"


def default_path() -> Path:
    return Path(os.environ.get("LOTTERY_DATA_PATH") or _DEFAULT_PATH)


class LotteryStore:
    """宝くじの現行ラウンド・チケット・抽選履歴と JSON 保存。"""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        rng: random.Random | None = None,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
        self._rng = rng if rng is not None else random.Random()
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
            logger.exception("lottery: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ ラウンド
    def _round_locked(self, now: datetime) -> dict[str, Any]:
        current = self._state["round"]
        if current is None:
            current = {
                "id": 1, "pool": 0, "tickets": {}, "boost": 0,
                "closes_at": next_draw_time(now).isoformat(),
            }
            self._state["round"] = current
        return current

    def add_to_pool(self, amount: int, now: datetime | None = None) -> int:
        """現行ラウンドのプールへ外部から上乗せする（国庫ブースト用）。

        チケット売上ではないため口数は増えない。上乗せ後のプール残高
        を返す。0 以下は無視する。
        """
        amount = int(amount)
        if amount <= 0:
            return 0
        now = now or datetime.now(JST)
        with self._lock:
            current = self._round_locked(now)
            current["pool"] = int(current["pool"]) + amount
            current["boost"] = int(current.get("boost") or 0) + amount
            self._mark_dirty()
            return int(current["pool"])

    def current_round(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(JST)
        with self._lock:
            return copy.deepcopy(self._round_locked(now))

    def tickets_of(self, user_id: str, now: datetime | None = None) -> int:
        now = now or datetime.now(JST)
        with self._lock:
            return int(self._round_locked(now)["tickets"].get(str(user_id), 0))

    def total_tickets(self, now: datetime | None = None) -> int:
        now = now or datetime.now(JST)
        with self._lock:
            return sum(self._round_locked(now)["tickets"].values())

    def remaining_allowance(self, user_id: str, now: datetime | None = None) -> int:
        return max(0, MAX_TICKETS_PER_USER - self.tickets_of(user_id, now))

    def history(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._state["history"])

    def last_result(self) -> dict[str, Any] | None:
        with self._lock:
            if not self._state["history"]:
                return None
            return copy.deepcopy(self._state["history"][-1])

    # ------------------------------------------------------------------ 購入
    def add_tickets(self, user_id: str, count: int, now: datetime | None = None) -> int:
        """チケットを加える。購入上限を超える場合は ItemError（状態は不変）。

        戻り値は購入後のそのユーザーの総口数。コインの実移動は呼び出し側が
        先に済ませる前提で、ここで失敗したら呼び出し側が返金する。
        """
        now = now or datetime.now(JST)
        if count <= 0:
            raise ItemError("購入枚数は1枚以上で指定してください。")
        uid = str(user_id)
        with self._lock:
            current = self._round_locked(now)
            owned = int(current["tickets"].get(uid, 0))
            if owned + count > MAX_TICKETS_PER_USER:
                raise ItemError(
                    f"チケットは1人{MAX_TICKETS_PER_USER}枚までです"
                    f"（現在 {owned} 枚購入済み）。")
            current["tickets"][uid] = owned + count
            current["pool"] = int(current["pool"]) + TICKET_PRICE * count
            self._mark_dirty()
            return owned + count

    # ------------------------------------------------------------------ 抽選
    def _pick_winners(self, tickets: dict[str, int], count: int) -> list[str]:
        """口数で重み付けし、重複なく当選者を選ぶ。"""
        pool = {uid: int(n) for uid, n in tickets.items() if n > 0}
        winners: list[str] = []
        for _ in range(min(count, len(pool))):
            total = sum(pool.values())
            pick = self._rng.random() * total
            cumulative = 0.0
            chosen = None
            for uid in sorted(pool):
                cumulative += pool[uid]
                if pick < cumulative:
                    chosen = uid
                    break
            if chosen is None:
                chosen = sorted(pool)[-1]
            winners.append(chosen)
            del pool[chosen]
        return winners

    def settle_if_due(self, now: datetime | None = None) -> dict[str, Any] | None:
        """締切を過ぎていれば現行ラウンドを確定し、結果を返す。

        未抽選分（購入ゼロの回）はプール全額を次回へ繰り越す。
        賞金の実移動は呼び出し側が戻り値の winners を見て行う。
        締切前なら None。Bot が止まっていた期間の回も、過ぎた分は
        1回だけ確定し、次の締切は now の次の抽選時刻に置く（欠落した
        日の回は作らない）。
        """
        now = now or datetime.now(JST)
        with self._lock:
            current = self._round_locked(now)
            try:
                closes_at = datetime.fromisoformat(current["closes_at"])
            except ValueError:
                closes_at = now
            if now < closes_at:
                return None
            pool = int(current["pool"])
            tickets = dict(current["tickets"])
            total = sum(tickets.values())
            if total <= 0:
                result = {
                    "round_id": int(current["id"]), "drawn_at": now.astimezone(JST).isoformat(),
                    "pool": pool, "payout": 0, "burned": 0,
                    "carryover": pool, "boost": int(current.get("boost") or 0),
                    "winners": [],
                }
            else:
                payout_total = int(pool * PAYOUT_RATE)
                burned = pool - payout_total
                holders = len(tickets)
                shares = PRIZE_SHARES[min(holders, 3)]
                winner_ids = self._pick_winners(tickets, len(shares))
                winners = []
                paid = 0
                for index, uid in enumerate(winner_ids):
                    prize = int(payout_total * shares[index])
                    paid += prize
                    winners.append({
                        "user_id": uid, "tickets": int(tickets[uid]), "prize": prize})
                result = {
                    "round_id": int(current["id"]), "drawn_at": now.astimezone(JST).isoformat(),
                    "pool": pool, "payout": paid, "burned": burned,
                    "carryover": payout_total - paid,
                    "boost": int(current.get("boost") or 0),
                    "winners": winners,
                }
            self._state["history"] = (
                self._state["history"] + [result])[-HISTORY_LIMIT:]
            self._state["round"] = {
                "id": int(current["id"]) + 1,
                "pool": int(result["carryover"]),
                "tickets": {}, "boost": 0,
                "closes_at": next_draw_time(now).isoformat(),
            }
            self._mark_dirty()
            return copy.deepcopy(result)
