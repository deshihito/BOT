# -*- coding: utf-8 -*-
"""採掘（mining）の単一の置き場。

パンBot 資産移植 Phase 4 で AGO 流に組み直したものを、2026-11-06 の
ユーザー指示（「軸足は本家に合わせて」＋「マイニングの核は損失還流
プール」）で原典準拠に再仕様した。原典（main.py の MiningView）の形:

- パネル（セッション）を開くと、そのセッションで掘れる回数が
  1〜20 回の抽選で決まる。セッション開始のクールダウンは60秒
- 1掘りの産出はコイン 10〜500（基本額の抽選）。20% で失敗して0
- 10% で「大量採掘」が発動し、プール残高の 1〜10% が上乗せされる
- コインは新規創出ではなく共有プール（core/general/economy_pool.py）から
  支払われ、プールにある分までしか出ない。プールは経済系の損失の
  還流でチャージされる（還流の発生源は economy_pool 側を参照）

旧 AGO 仕様（素材中心・コインEV約4・個人10回/日・日次グローバル
供給キャップ）は原典の手触りと別物だったため廃止した。素材の供給は
ショップ・宝箱・工房が担う。安全弁として残したのは「支払いは
プール残高の範囲内」という原典自身の制約だけで、日次キャップ類は
置かない（プールが枯れれば掘れなくなるのが原典の調整弁）。

このモジュールが持つのはセッション状態・クールダウン・産出の抽選
まで。プールの支払いと wallet への反映は呼び出し側
（cogs/circulation.py）が economy_pool と wallet の経路で行い、
失敗したら巻き戻す。保存は core/general/workshop.py と同じ流儀: 専用 JSON
（既定 data/mining.json、環境変数 MINING_DATA_PATH で変更可）に
メモリ主体＋バッチフラッシュ＋原子差し替え。
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

from core.support import data_paths
from core.general.items import JST, ItemError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（原典準拠の値。絶対額は AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: セッション開始のクールダウン（秒）。原典 MINING_COOLDOWN = 60。
COOLDOWN_SECONDS = 60

#: 掘り同士の最小間隔（秒、E-15 の最小手当て）。セッション内の掘りは
#: 原典どおり即座に実行できる（1掘りごとの確率・回数・産出は不変）が、
#: この間隔より速く掘った分は「間隔の不足分」がセッション終了後の
#: クールダウンへ加算される。速射するほど次セッションまでの待ちが
#: 伸びるため、連続即掘りの持続速度だけが下がる。
MIN_DIG_INTERVAL_SECONDS = 3.0

#: 1セッションで掘れる回数の抽選範囲（原典 random.randint(1, 20)）。
SESSION_MIN_DIGS = 1
SESSION_MAX_DIGS = 20

#: 1掘りの基本産出（コイン、原典 random.randint(10, 500)）。
BASE_MIN_COINS = 10
BASE_MAX_COINS = 500

#: 失敗率（原典: 0.8 の確率で成功＝20% で産出0）。
FAIL_RATE = 0.20

#: 大量採掘の発動率（原典 lc = 0.1）。
JACKPOT_RATE = 0.10

#: 大量採掘の上乗せ（プール残高に対する割合、原典 uniform(0.01, 0.1)）。
JACKPOT_POOL_MIN_RATE = 0.01
JACKPOT_POOL_MAX_RATE = 0.10

#: 直下掘り（次期仕様 S6-4）の特殊ダイス。セッション開始時に立てた
#: フラグが残っている間だけ有効で、大量採掘の確率と量が上がる代わり
#: に失敗率が大きく上がる（原典: 大量採掘 +50% / 失敗 90%）。
DIRECT_FAIL_RATE = 0.90
DIRECT_JACKPOT_RATE = 0.15
DIRECT_JACKPOT_MULTIPLIER = 1.5

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0


def _empty_state() -> dict[str, Any]:
    return {"users": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entry in users.items():
            if not isinstance(entry, dict):
                continue
            last = entry.get("last")
            left = entry.get("session_left")
            last_dig = entry.get("last_dig")
            ready_at = entry.get("ready_at")
            debt = entry.get("session_debt")
            state["users"][str(uid)] = {
                # 旧仕様の保存（last/day/count）からは last だけ引き継ぐ。
                "last": last if isinstance(last, str) else None,
                "session_left": (
                    int(left) if isinstance(left, int) and left > 0 else 0),
                "direct": bool(entry.get("direct")),
                # E-15: 掘り間隔の不足分の加算（下記 dig 参照）。旧保存には
                # 無いので既定値で補う。
                "last_dig": last_dig if isinstance(last_dig, str) else None,
                "session_debt": (
                    float(debt) if isinstance(debt, (int, float))
                    and not isinstance(debt, bool) and debt > 0 else 0.0),
                "ready_at": ready_at if isinstance(ready_at, str) else None,
            }
    return state


_DEFAULT_PATH = data_paths.data_path("mining.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/mining.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(__file__, "mining.json")


def default_path() -> Path:
    return Path(os.environ.get("MINING_DATA_PATH") or _DEFAULT_PATH)


class MiningStore:
    """採掘セッション（残り回数）・クールダウンの状態と JSON 保存、産出抽選。"""

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
        raw = self._read_raw()
        if raw is None:
            return _empty_state()
        return _clean_state(raw)

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする (旧パス主・正規パスはユーザー単位で補完)。
        # 環境変数や明示パスで保存先が指定されている場合は移行しない。
        if self._path == _DEFAULT_PATH:
            return data_paths.load_migrated(self._path, _STRAY_PATH, fill=True)
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
            logger.exception("mining: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 状態参照
    def _user_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(
            str(user_id), {"last": None, "session_left": 0, "direct": False,
                           "last_dig": None, "session_debt": 0.0,
                           "ready_at": None})

    def _cooldown_remaining_locked(self, user: dict[str, Any], now: datetime) -> float:
        remaining = 0.0
        if user.get("last"):
            try:
                last = datetime.fromisoformat(user["last"])
                remaining = max(
                    0.0, COOLDOWN_SECONDS - (now - last).total_seconds())
            except ValueError:
                remaining = 0.0
        # E-15: 掘り切り時点に確定した解禁時刻（開始起点クールダウン＋
        # 間隔不足分の加算）も残り時間に反映する。どちらか遅い方が勝つ。
        ready_at = user.get("ready_at")
        if ready_at:
            try:
                ready = datetime.fromisoformat(ready_at)
                remaining = max(remaining, (ready - now).total_seconds(), 0.0)
            except ValueError:
                pass
        return remaining

    def status(self, user_id: str, now: datetime | None = None) -> dict[str, Any]:
        """表示用: クールダウン残りと、進行中セッションの残り回数。"""
        now = now or datetime.now(JST)
        with self._lock:
            user = self._user_locked(str(user_id))
            return {
                "cooldown_remaining": self._cooldown_remaining_locked(user, now),
                "session_left": int(user["session_left"]),
                "session_max": SESSION_MAX_DIGS,
                "direct": bool(user.get("direct")),
            }

    # ------------------------------------------------------------------ セッション
    def start_session(self, user_id: str, now: datetime | None = None,
                      *, direct: bool = False) -> int:
        """セッションを開始し、掘れる回数を返す。

        既にセッションが残っていれば、その残り回数をそのまま返す
        （振り直さない）。クールダウン中は ItemError（状態は不変）。
        direct=True のときはこのセッションを直下掘りとして開始する。
        """
        now = now or datetime.now(JST)
        uid = str(user_id)
        with self._lock:
            user = self._user_locked(uid)
            if int(user["session_left"]) > 0:
                return int(user["session_left"])
            remaining = self._cooldown_remaining_locked(user, now)
            if remaining > 0:
                seconds = int(remaining) + (1 if remaining % 1 else 0)
                raise ItemError(
                    f"クールタイム中です。あと約{seconds}秒で掘れます。")
            digs = self._rng.randint(SESSION_MIN_DIGS, SESSION_MAX_DIGS)
            user["last"] = now.astimezone(JST).isoformat()
            user["session_left"] = digs
            user["direct"] = bool(direct)
            # E-15: 間隔の計測はセッション単位で始める（前セッションの
            # 最終掘りとの間隔はクールダウンが既に担保している）。
            user["last_dig"] = None
            user["session_debt"] = 0.0
            user["ready_at"] = None
            self._mark_dirty()
            return digs

    # ------------------------------------------------------------------ 産出抽選
    def _roll(self, pool_balance: int, *, no_fail: bool = False,
              direct: bool = False) -> dict[str, Any]:
        """1掘り分の産出を抽選する（状態は変えない）。

        原典の順序どおり: 基本額を抽選し、失敗なら基本額は0。
        大量採掘は独立に抽選し、発動すればプール残高の割合が
        基本額とは別に上乗せされる（失敗した掘りでも発動する）。
        支払い要求額はプール残高で clamp する（ある分まで）。

        no_fail（落盤対策）: 失敗抽選を成功扱いに読み替える。
        direct（直下掘り）: 失敗率と大量採掘の確率・量を特殊ダイスにする。
        """
        base = self._rng.randint(BASE_MIN_COINS, BASE_MAX_COINS)
        fail_rate = DIRECT_FAIL_RATE if direct else FAIL_RATE
        failed = self._rng.random() < fail_rate
        if no_fail:
            failed = False
        base_amount = 0 if failed else base
        jackpot_rate = DIRECT_JACKPOT_RATE if direct else JACKPOT_RATE
        jackpot = self._rng.random() < jackpot_rate
        extra = 0
        if jackpot:
            rate = self._rng.uniform(JACKPOT_POOL_MIN_RATE, JACKPOT_POOL_MAX_RATE)
            if direct:
                rate *= DIRECT_JACKPOT_MULTIPLIER
            extra = max(1, int(pool_balance * rate)) if pool_balance > 0 else 0
        requested = base_amount + extra
        return {
            "coins": max(0, min(requested, max(0, int(pool_balance)))),
            "requested": requested,
            "base": base_amount,
            "failed": failed,
            "jackpot": jackpot and extra > 0,
            "extra": extra,
            "direct": bool(direct),
        }

    def dig(self, user_id: str, pool_balance: int,
            now: datetime | None = None, *,
            no_fail: bool = False) -> dict[str, Any]:
        """セッションの1回分を消費して産出を確定する。

        セッションが無い場合は ItemError（状態は不変）。戻り値の
        "user_before" は、支払いに失敗したときの rollback_dig 用。
        直下掘りフラグはセッション終了（残り0）で自動的に落ちる。
        """
        now = now or datetime.now(JST)
        uid = str(user_id)
        with self._lock:
            user = self._user_locked(uid)
            if int(user["session_left"]) <= 0:
                raise ItemError("採掘セッションが始まっていません。")
            user_before = copy.deepcopy(user)
            direct = bool(user.get("direct"))
            # E-15: 前の掘りからの間隔が MIN_DIG_INTERVAL_SECONDS 未満なら
            # 不足分を記録する（この掘り自体は原典どおり即座に成立する）。
            interval_debt = 0.0
            last_dig_raw = user.get("last_dig")
            if last_dig_raw:
                try:
                    last_dig = datetime.fromisoformat(last_dig_raw)
                    elapsed = max(0.0, (now - last_dig).total_seconds())
                    interval_debt = max(
                        0.0, MIN_DIG_INTERVAL_SECONDS - elapsed)
                except ValueError:
                    interval_debt = 0.0
            user["session_debt"] = (
                float(user.get("session_debt") or 0.0) + interval_debt)
            stamp = now.astimezone(JST).isoformat()
            user["last_dig"] = stamp
            user["session_left"] = int(user["session_left"]) - 1
            if int(user["session_left"]) <= 0:
                user["direct"] = False
                # 掘り切り: 解禁時刻は「開始＋60秒」と「開始＋60秒＋間隔
                # 不足分の合計」の遅い方（実質は後者）。間隔を守って掘れば
                # 不足分は0で、従来どおり開始起点60秒のまま。
                base = now
                if user.get("last"):
                    try:
                        base = datetime.fromisoformat(user["last"])
                    except ValueError:
                        base = now
                ready = base + timedelta(
                    seconds=COOLDOWN_SECONDS + float(user["session_debt"]))
                user["ready_at"] = ready.astimezone(JST).isoformat()
            self._mark_dirty()
            result = self._roll(pool_balance, no_fail=no_fail, direct=direct)
            result["session_left"] = int(user["session_left"])
            result["user_before"] = user_before
            result["interval_debt"] = interval_debt
            result["last_dig_after"] = stamp
            return result

    def roll_bonus(self, pool_balance: int, *,
                   no_fail: bool = False) -> dict[str, Any]:
        """追加の1掘り分の抽選（採掘ドリンク／編成ボーナス用）。

        セッションは消費しない。通常ダイス（直下掘りの特殊ダイスには
        しない）。
        """
        return self._roll(pool_balance, no_fail=no_fail)

    def rollback_dig(self, user_id: str, result: dict[str, Any]) -> None:
        """dig の巻き戻し（プールの支払いやコイン反映に失敗したとき用）。

        E-4 対応の差分方式: スナップショットでユーザー状態を丸ごと
        上書きせず、この dig が変えた分だけを戻す。await の間に同一
        ユーザーの別の dig が完了していても、その消費は巻き戻らない。
        """
        before = result.get("user_before") or {}
        with self._lock:
            user = self._user_locked(str(user_id))
            # 消費した1回分だけを戻す（同時 dig の消費は保持される）。
            user["session_left"] = int(user.get("session_left") or 0) + 1
            # この dig が加えた間隔不足分だけを差し引く（E-15）。
            debt = float(result.get("interval_debt") or 0.0)
            if debt:
                user["session_debt"] = max(
                    0.0, float(user.get("session_debt") or 0.0) - debt)
            # last_dig は、後続の dig に上書きされていない場合だけ戻す。
            if (result.get("last_dig_after") is not None
                    and user.get("last_dig") == result.get("last_dig_after")):
                user["last_dig"] = before.get("last_dig")
            # この dig がセッションを掘り切っていた場合だけ、掘り切りで
            # 落とした直下掘りフラグと解禁時刻を戻す（再開したセッション
            # の状態であり、別セッションのものではないことが回数から分かる）。
            if (int(before.get("session_left") or 0) == 1
                    and int(user["session_left"]) == 1):
                user["direct"] = bool(before.get("direct"))
                user["ready_at"] = None
            self._mark_dirty()
