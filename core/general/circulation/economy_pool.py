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

国庫は v1 では蓄積と残高保持のみだったが、次期仕様（S1）で出口を
持たせた: 週次で残高の 20% を採掘プールへ自動還流する（還流バッファ化）
ほか、残高が閾値を超えた分の一部を次回の宝くじ払戻へ上乗せする
（lottery_boost_amount / take_lottery_boost）。判定は常駐ループを持たず、
宝くじの lazy 決済の入口（cogs/circulation.py の settle_lottery）から
maybe_weekly_release / lottery_boost_amount を呼ぶ。残高は管理コマンド
（!all_stats）から参照できる。

保存は core/general/items/items.py と同じ流儀: 専用 JSON（既定 data/economy_pool.json、
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
from datetime import date, datetime
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths
from core.general.items.items import JST

logger = logging.getLogger(__name__)

#: 還流の内訳: 損失のうち採掘プールへ行く割合（残りは国庫）。
#: ユーザー指示（2026-11-06）の 70/30。端数は国庫側に寄せる。
#: 次期仕様 S5-1 でこの配分を確定とした（原典コードは 30/70 だった）。
POOL_SHARE = 0.7

# ---------------------------------------------------------------------------
# 国庫の出口（次期仕様 S1）: 還流バッファ化
# ---------------------------------------------------------------------------

#: 週次還流で国庫から採掘プールへ移す割合。
TREASURY_RELEASE_RATE = 0.20

#: 週次還流の間隔（日）。前回還流日からこの日数が経過したら還流する。
TREASURY_RELEASE_INTERVAL_DAYS = 7

#: 宝くじブーストが発動する国庫残高の閾値（暫定。S0 の実測で確定する）。
TREASURY_BOOST_THRESHOLD = 500_000

#: 閾値の超過分のうち宝くじへ回す割合。
TREASURY_BOOST_RATE = 0.50

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

_INT_KEYS = (
    "pool", "treasury", "total_recycled", "total_paid",
    "total_released", "total_boosted", "lottery_boost_pending",
    "total_house_paid",
)


def _empty_state() -> dict[str, Any]:
    return {
        "pool": 0, "treasury": 0, "total_recycled": 0, "total_paid": 0,
        "total_released": 0, "total_boosted": 0, "lottery_boost_pending": 0,
        "total_house_paid": 0,
        "last_release_date": None,
    }


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    for key in _INT_KEYS:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            state[key] = value
    last = raw.get("last_release_date")
    if isinstance(last, str):
        state["last_release_date"] = last
    return state


_DEFAULT_PATH = data_paths.data_path("economy_pool.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/economy_pool.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(Path(__file__).resolve().parent.parent / "economy_pool.py", "economy_pool.json")  # 旧保存先は収納前の深さ基準のため1階層上を渡す


def default_path() -> Path:
    return Path(os.environ.get("ECONOMY_POOL_DATA_PATH") or _DEFAULT_PATH)


class EconomyPoolStore(DirtyFlushMixin):
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
        raw = self._read_raw()
        if raw is None:
            return _empty_state()
        return _clean_state(raw)

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする。プール・国庫残高は単一の現在値なので、旧パス
        # のファイル全体 (最新) を正とする。環境変数や明示パスで保存先が
        # 指定されている場合は移行しない。
        if self._path == _DEFAULT_PATH:
            return data_paths.load_migrated(self._path, _STRAY_PATH, fill=False)
        return data_paths.read_json(self._path)

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


    # ------------------------------------------------------------------ 残高
    def pool_balance(self) -> int:
        with self._lock:
            return int(self._state["pool"])

    def treasury_balance(self) -> int:
        with self._lock:
            return int(self._state["treasury"])

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            result: dict[str, Any] = {
                key: int(self._state[key]) for key in _INT_KEYS}
            result["last_release_date"] = self._state.get("last_release_date")
            return result

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

    # ------------------------------------------------------------------
    # 胴元バンクロール（インフレ対策A案）: ギャンブル配当の利益分の原資
    # ------------------------------------------------------------------
    def pay_house(self, amount: int) -> dict[str, int]:
        """バンクロール（プール＋国庫）から支払い、内訳を返す。

        プールから先に引き、不足分を国庫から引く。残高が不足する場合は
        ある分だけ払う（双方とも負にならない）。配当の利益分を新規創出
        ではなく還流の蓄積から賄うための支払いで、支払累計は
        total_house_paid に積む（採掘の pay / total_paid とは別勘定）。
        """
        amount = int(amount)
        if amount <= 0:
            return {"paid": 0, "pool": 0, "treasury": 0}
        with self._lock:
            pool_part = min(amount, int(self._state["pool"]))
            treasury_part = min(
                amount - pool_part, int(self._state["treasury"]))
            paid = pool_part + treasury_part
            if paid <= 0:
                return {"paid": 0, "pool": 0, "treasury": 0}
            self._state["pool"] = int(self._state["pool"]) - pool_part
            self._state["treasury"] = (
                int(self._state["treasury"]) - treasury_part)
            self._state["total_house_paid"] = (
                int(self._state["total_house_paid"]) + paid)
            self._mark_dirty()
            return {"paid": paid, "pool": pool_part,
                    "treasury": treasury_part}

    def refund_house(self, breakdown: dict[str, int]) -> None:
        """pay_house で払った分を内訳どおりに戻す（受け手側の反映失敗時）。

        pool / treasury の各分を元の置き場へ戻し、total_house_paid を
        払った分だけ減らす（0未満にはしない）。
        """
        try:
            pool_part = max(0, int(breakdown.get("pool") or 0))
            treasury_part = max(0, int(breakdown.get("treasury") or 0))
        except (TypeError, ValueError):
            return
        if pool_part <= 0 and treasury_part <= 0:
            return
        with self._lock:
            self._state["pool"] = int(self._state["pool"]) + pool_part
            self._state["treasury"] = (
                int(self._state["treasury"]) + treasury_part)
            self._state["total_house_paid"] = max(
                0, int(self._state["total_house_paid"])
                - pool_part - treasury_part)
            self._mark_dirty()

    # ------------------------------------------------------------------ 国庫の出口（S1）
    def maybe_weekly_release(self, now: datetime | None = None) -> int:
        """週次還流: 前回から間隔が空いていれば国庫の 20% をプールへ移す。

        戻り値は実際に移した額。初回呼び出しでは基準日だけを記録して
        還流しない（配備直後にまとめて動くのを防ぐ）。基準日は状態に
        永続化するので、再起動を跨いでも同じ週に2回は走らない。
        移動は国庫→プールのゼロサムで、双方とも負にならない。
        """
        now = now or datetime.now(JST)
        today = now.astimezone(JST).date()
        with self._lock:
            last_raw = self._state.get("last_release_date")
            last: date | None = None
            if isinstance(last_raw, str):
                try:
                    last = date.fromisoformat(last_raw)
                except ValueError:
                    last = None
            if last is None:
                self._state["last_release_date"] = today.isoformat()
                self._mark_dirty()
                return 0
            if (today - last).days < TREASURY_RELEASE_INTERVAL_DAYS:
                return 0
            treasury = int(self._state["treasury"])
            amount = int(treasury * TREASURY_RELEASE_RATE)
            self._state["last_release_date"] = today.isoformat()
            if amount > 0:
                self._state["treasury"] = treasury - amount
                self._state["pool"] = int(self._state["pool"]) + amount
                self._state["total_released"] = (
                    int(self._state["total_released"]) + amount)
            self._mark_dirty()
            return amount

    def lottery_boost_amount(self, now: datetime | None = None) -> int:
        """宝くじブースト: 国庫が閾値を超えたら超過分の 50% を確保する。

        確保した分は国庫から差し引いて lottery_boost_pending に積み、
        take_lottery_boost で宝くじ側へ渡す。閾値未満なら何もしない。
        """
        with self._lock:
            treasury = int(self._state["treasury"])
            excess = treasury - TREASURY_BOOST_THRESHOLD
            if excess <= 0:
                return 0
            amount = int(excess * TREASURY_BOOST_RATE)
            if amount <= 0:
                return 0
            self._state["treasury"] = treasury - amount
            self._state["lottery_boost_pending"] = (
                int(self._state["lottery_boost_pending"]) + amount)
            self._state["total_boosted"] = (
                int(self._state["total_boosted"]) + amount)
            self._mark_dirty()
            return amount

    def take_lottery_boost(self) -> int:
        """確保済みの宝くじブーストを取り出す（取り出した分は消える）。"""
        with self._lock:
            amount = int(self._state["lottery_boost_pending"])
            if amount > 0:
                self._state["lottery_boost_pending"] = 0
                self._mark_dirty()
            return amount


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
