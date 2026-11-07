# -*- coding: utf-8 -*-
"""アゴトークン市場（為替レート＋市場プール＋売買）の単一の置き場。

パンBot 資産移植 Phase 1。元の数理（ランダムウォーク＋トレンド＋ニュース＋
移動平均からの反発）は採るが、そのままでは乗算型ランダムウォークの分散が
時間とともに増え続け、90日でインフレ／デフレのどちらかにほぼ確実に発散する
（モンテカルロ 90日×100試行で 98/100 が 10倍超または 1/10 未満。
検証スクリプトは goals/ago-bot/hidden_files/fx_sim_*.py）。
そのため時刻駆動 tick・バンド反発・clamp・絶対バンド・プール裏付けで
暴走しない形に再仕様した（同条件の検証で暴走 0/100、最悪でも 64〜167）。

設計の要点:
- レートは tick（5分ごと）でのみ進む。参照系（残高・レート表示）は副作用なし。
- トークンの総量は固定で、全量が初期状態では市場プールにある。
  売買はプールとの交換のみで、新規発行（mint）の経路はこのモジュールに無い。
- AGO コインの増減そのものはここでは行わない（cogs/wallet.py の安全な
  残高更新経路に委ねる）。ここで数えるのはプール側の残高と消却量で、
  「ユーザ残高＋プール＋消却」の保存則が常に成り立つよう売買を組み立てる。
- 保存は core/support/usage_stats/usage_stats.py と同じ流儀: 専用 JSON（既定 data/market.json、
  環境変数 MARKET_DATA_PATH で変更可）に、メモリ主体＋バッチフラッシュ。
"""
from __future__ import annotations

import copy
import json
import logging
import math
import os
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from core.store_flush import DirtyFlushMixin
from core.support import data_paths

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))

# ---------------------------------------------------------------------------
# 経済定数（Phase 1 の暫定値。価格の絶対値は AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: 取引対象トークンの名称（仮称。ユーザ決定により当面このまま進める）。
TOKEN_NAME = "アゴトークン"
#: コインの単位表記（cogs/wallet.py と同じ）。
COIN_NAME = "AGO"

#: レートのアンカー（1トークン = 100 AGO を基準に変動する）。
ANCHOR_RATE = 100.0
#: 絶対バンド（アンカーの 1/10 〜 10倍）。プール介入でこれ以上は外に出さない。
RATE_MIN = 10.0
RATE_MAX = 1000.0

#: tick 間隔（秒）。レートはこの周期でのみ進む。
TICK_SECONDS = 300
#: 1 tick の基礎ボラティリティ（σ）。stable チューニング（検証済み:
#: 90日×100試行で日次変動平均 約3%・全試行 88.5〜111.5。fx_sim_v3_stable）。
SIGMA = 0.003
#: トレンドの再抽選確率と振幅（±0.1%/tick まで）。
TREND_SWITCH_P = 0.005
TREND_MAX = 0.001
#: ニュースの発生確率と衝撃の標準偏差（±3% 級）。
NEWS_P = 0.003
NEWS_SD = 0.03
#: ニュース文（AGO 世界観で新規作成。プラス方向3種・マイナス方向3種）。
NEWS_POSITIVE = (
    "アゴの目撃情報が急増している",
    "大口の買い注文が市場に入った",
    "アゴトークンの保有者が過去最多を更新",
)
NEWS_NEGATIVE = (
    "アゴの目撃情報がぱったり途絶えた",
    "大口の売り注文が市場に入った",
    "市場全体に様子見ムードが広がった",
)

#: 売買フローによる価格インパクト（逓減型 tanh）。次回 tick に織り込む。
IMPACT_COEF = 0.003
IMPACT_SCALE_AGA = 50_000.0

#: バンド反発。バンド内（アンカーの 1/2〜2倍）は弱く、外では強める。
BAND_K_BASE = 0.02
BAND_K_EXTRA = 0.08
#: 1 tick の変動 clamp（±1.5%）。
TICK_CLAMP = 0.015
#: 1日の変動が ±10% を超えたら反発を強める。
DAY_SOFT_CAP_LOG = math.log(1.1)
DAY_PULLBACK = 0.05

#: 売買手数料（売買とも 1%）。半分は消却、半分はプールへ還流する。
FEE_RATE = 0.01
FEE_BURN_SHARE = 0.5

#: トークンの総発行量（固定・追加発行なし）と、プールの AGO 準備のシード額。
#: いずれも暫定値で、AGO のコイン分布の実測後に調整する。
TOTAL_TOKEN_SUPPLY = 1_000_000.0
#: プールシード。確定式（仕様 S0）: 現行値を上限に総残高の10%以下。
#: 実測は tools/coin_distribution.py で行い、数値は実測後に確定する。
POOL_SEED_AGA = 1_000_000

#: 最低取引額（AGO）。トークンは小数 0.01 単位で保持する。
MIN_TRADE_AGA = 10
#: 1回の取引上限（プールの AGO 準備に対する割合）。
TRADE_CAP_POOL_RATIO = 0.01

#: サーキットブレーカー: 1時間で ±10% 超の変動、または準備率の下限割れで停止。
BREAKER_1H_CHANGE = 0.10
BREAKER_HALT_SECONDS = 3600
POOL_MIN_RATIO = 0.05

#: レート履歴の保持件数（5分 tick で約7日分）。
HISTORY_KEEP = 2016

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

_DEFAULT_PATH = data_paths.data_path("market.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/market.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(Path(__file__).resolve().parent.parent / "market.py", "market.json")  # 旧保存先は収納前の深さ基準のため1階層上を渡す


def default_path() -> Path:
    return Path(os.environ.get("MARKET_DATA_PATH") or _DEFAULT_PATH)


def quantize_tokens(amount: float) -> float:
    """トークン量を 0.01 単位へ切り捨てる（端数はプール側に残す）。"""
    return math.floor(float(amount) * 100) / 100.0


class TradeError(Exception):
    """売買が成立しない理由（ユーザ向け文言をそのまま持つ）。"""


def _empty_state(now: datetime) -> dict[str, Any]:
    return {
        "rate": ANCHOR_RATE,
        "trend": 0.0,
        "day_key": now.astimezone(JST).date().isoformat(),
        "day_open_rate": ANCHOR_RATE,
        "pool_aga": POOL_SEED_AGA,
        "pool_token": TOTAL_TOKEN_SUPPLY,
        "burned_aga": 0,
        "net_flow_aga": 0.0,
        "last_news": "",
        "halt_until": None,
        "halt_reason": "",
        "balances": {},
        "history": [],
        "started_at": now.astimezone(JST).isoformat(),
    }


def _clean_state(raw: Any, now: datetime) -> dict[str, Any]:
    state = _empty_state(now)
    if not isinstance(raw, dict):
        return state
    for key in ("rate", "trend", "day_open_rate", "net_flow_aga"):
        if isinstance(raw.get(key), (int, float)):
            state[key] = float(raw[key])
    for key in ("pool_aga", "burned_aga"):
        if isinstance(raw.get(key), (int, float)):
            state[key] = int(raw[key])
    if isinstance(raw.get("pool_token"), (int, float)):
        state["pool_token"] = float(raw["pool_token"])
    for key in ("day_key", "last_news", "halt_reason", "started_at"):
        if isinstance(raw.get(key), str):
            state[key] = raw[key]
    if isinstance(raw.get("halt_until"), str):
        state["halt_until"] = raw["halt_until"]
    balances = raw.get("balances")
    if isinstance(balances, dict):
        state["balances"] = {
            str(k): float(v) for k, v in balances.items()
            if isinstance(v, (int, float)) and float(v) > 0
        }
    history = raw.get("history")
    if isinstance(history, list):
        cleaned = []
        for entry in history[-HISTORY_KEEP:]:
            if isinstance(entry, dict) and isinstance(entry.get("rate"), (int, float)):
                cleaned.append({
                    "t": str(entry.get("t") or ""),
                    "rate": float(entry["rate"]),
                    "volume": float(entry.get("volume") or 0),
                })
        state["history"] = cleaned
    # 保存則の防御: プール＋全ユーザのトークンが総量に合わないデータは
    # プール側で吸収する（負にはしない）。
    held = sum(state["balances"].values())
    if abs(state["pool_token"] + held - TOTAL_TOKEN_SUPPLY) > 0.01:
        state["pool_token"] = max(0.0, TOTAL_TOKEN_SUPPLY - held)
    state["rate"] = min(RATE_MAX, max(RATE_MIN, state["rate"]))
    return state


class MarketStore(DirtyFlushMixin):
    """市場状態の保持・レート生成・売買計算と JSON 保存（同期 API、メモリ主体）。

    売買の計算（quote / apply）はこのクラスで完結させ、AGO コインの実残高の
    増減は呼び出し側（cogs/market.py）が wallet の安全な経路で行う。
    """

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
        # tick／売買がロック保持中に _mark_dirty → flush と再入するため RLock。
        self._lock = threading.RLock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._state = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, Any]:
        raw = self._read_raw()
        if raw is None:
            return _empty_state(datetime.now(JST))
        return _clean_state(raw, datetime.now(JST))

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする。市場状態はスナップショット (レート・プール・
        # 保有量で保存則がある) なので、旧パスのファイル全体を正とし、
        # フィールド単位の混ぜ合わせはしない。環境変数や明示パスで保存先
        # が指定されている場合は移行しない。
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
            logger.exception("market: 状態の保存に失敗しました path=%s", self._path)


    # ------------------------------------------------------------------ 参照
    def snapshot(self) -> dict[str, Any]:
        """表示用の現在状態（副作用なし）。"""
        with self._lock:
            return copy.deepcopy(self._state)

    def rate(self) -> float:
        with self._lock:
            return float(self._state["rate"])

    def token_balance(self, user_id: str) -> float:
        with self._lock:
            return float(self._state["balances"].get(str(user_id), 0.0))

    def trade_cap_aga(self, cap_ratio: float | None = None) -> int:
        """1回の取引上限（プールの AGO 準備に対する比率）。

        cap_ratio は上限比率の上書き（優待パス等のアイテム効果から
        渡す。fee_rate と同じ流儀）。None なら通常の TRADE_CAP_POOL_RATIO。
        """
        ratio = TRADE_CAP_POOL_RATIO if cap_ratio is None else cap_ratio
        with self._lock:
            return int(self._state["pool_aga"] * ratio)

    # ------------------------------------------------------- サーキットブレーカー
    def halt_status(self, now: datetime) -> tuple[bool, str]:
        with self._lock:
            return self._halt_status_locked(now)

    def _halt_status_locked(self, now: datetime) -> tuple[bool, str]:
        until = self._state.get("halt_until")
        if until:
            try:
                until_dt = datetime.fromisoformat(until)
            except ValueError:
                until_dt = None
            if until_dt is not None and now < until_dt:
                return True, str(self._state.get("halt_reason") or "取引を一時停止しています。")
            self._state["halt_until"] = None
            self._state["halt_reason"] = ""
        return False, ""

    def side_halt(self, side: str, now: datetime) -> str | None:
        """片側停止の理由を返す（停止でなければ None）。全体停止も含む。"""
        with self._lock:
            halted, reason = self._halt_status_locked(now)
            if halted:
                return reason
            if side == "buy" and self._state["pool_token"] < TOTAL_TOKEN_SUPPLY * POOL_MIN_RATIO:
                return "市場プールのトークン準備が不足しているため、買う操作を一時停止しています。"
            if side == "sell" and self._state["pool_aga"] < POOL_SEED_AGA * POOL_MIN_RATIO:
                return "市場プールのコイン準備が不足しているため、売る操作を一時停止しています。"
        return None

    # ------------------------------------------------------------------ tick
    def tick(self, now: datetime | None = None) -> float:
        """レートを1 tick 進める（時刻駆動でのみ呼ぶこと）。新しいレートを返す。"""
        now = now or datetime.now(JST)
        rng = self._rng
        with self._lock:
            state = self._state
            day_key = now.astimezone(JST).date().isoformat()
            if state["day_key"] != day_key:
                state["day_key"] = day_key
                state["day_open_rate"] = state["rate"]

            if rng.random() < TREND_SWITCH_P:
                state["trend"] = rng.uniform(-TREND_MAX, TREND_MAX)
            change = rng.gauss(0, SIGMA) + state["trend"]

            news = ""
            if rng.random() < NEWS_P:
                shock = rng.gauss(0, NEWS_SD)
                change += shock
                news = rng.choice(NEWS_POSITIVE if shock >= 0 else NEWS_NEGATIVE)

            net = float(state["net_flow_aga"])
            change += IMPACT_COEF * math.tanh(net / IMPACT_SCALE_AGA)
            volume = abs(net)
            state["net_flow_aga"] = 0.0

            dev = math.log(state["rate"] / ANCHOR_RATE)
            k = BAND_K_BASE if abs(dev) < math.log(2) else (
                BAND_K_BASE + BAND_K_EXTRA * (abs(dev) - math.log(2))
            )
            change -= k * dev

            day_dev = math.log(state["rate"] / state["day_open_rate"])
            if abs(day_dev) > DAY_SOFT_CAP_LOG:
                change -= DAY_PULLBACK * day_dev

            change = max(-TICK_CLAMP, min(TICK_CLAMP, change))
            state["rate"] = min(RATE_MAX, max(RATE_MIN, state["rate"] * math.exp(change)))
            if news:
                state["last_news"] = news

            state["history"].append({
                "t": now.astimezone(JST).isoformat(),
                "rate": state["rate"],
                "volume": volume,
            })
            state["history"] = state["history"][-HISTORY_KEEP:]

            self._check_breaker_locked(now)
            self._mark_dirty()
            return float(state["rate"])

    def _check_breaker_locked(self, now: datetime) -> None:
        state = self._state
        if state.get("halt_until"):
            return
        hour_ago = now - timedelta(hours=1)
        reference = None
        # 履歴は時系列順。1時間前のレートは末尾側にあるので後ろから探す。
        for entry in reversed(state["history"]):
            try:
                entry_at = datetime.fromisoformat(entry["t"])
            except (ValueError, TypeError):
                continue
            if entry_at <= hour_ago:
                reference = float(entry["rate"])
                break
        if reference:
            change_1h = state["rate"] / reference - 1
            if abs(change_1h) > BREAKER_1H_CHANGE:
                state["halt_until"] = (now + timedelta(seconds=BREAKER_HALT_SECONDS)).isoformat()
                state["halt_reason"] = (
                    f"1時間でレートが {change_1h:+.1%} 変動したため、"
                    "サーキットブレーカーで取引を一時停止しています。"
                )

    # ------------------------------------------------------------------ 売買
    def quote_buy(self, aga_amount: int, fee_rate: float | None = None) -> dict[str, Any]:
        """aga_amount AGO で買える量の見積もり（状態は変えない）。

        fee_rate は手数料率の上書き（アイテム効果の割引など、Phase 2 の
        core/general/items/items.py の受動効果から渡す）。None なら通常の FEE_RATE。
        """
        fee_rate = FEE_RATE if fee_rate is None else fee_rate
        with self._lock:
            rate = float(self._state["rate"])
            fee = int(aga_amount * fee_rate)
            net = aga_amount - fee
            tokens = quantize_tokens(net / rate)
            return {"rate": rate, "fee": fee, "net_aga": net, "tokens": tokens}

    def quote_sell(self, token_amount: float, fee_rate: float | None = None) -> dict[str, Any]:
        fee_rate = FEE_RATE if fee_rate is None else fee_rate
        with self._lock:
            rate = float(self._state["rate"])
            gross = int(token_amount * rate)
            fee = int(gross * fee_rate)
            return {"rate": rate, "gross_aga": gross, "fee": fee, "net_aga": gross - fee}

    def validate_buy(self, aga_amount: int, now: datetime | None = None,
                     fee_rate: float | None = None,
                     cap_ratio: float | None = None) -> None:
        now = now or datetime.now(JST)
        if aga_amount < MIN_TRADE_AGA:
            raise TradeError(f"最低取引額は {MIN_TRADE_AGA} AGO です。")
        reason = self.side_halt("buy", now)
        if reason:
            raise TradeError(reason)
        if aga_amount > self.trade_cap_aga(cap_ratio):
            raise TradeError("1回の取引上限を超えています。金額を下げてください。")
        quote = self.quote_buy(aga_amount, fee_rate)
        if quote["tokens"] <= 0:
            raise TradeError("購入金額が小さすぎます。")
        with self._lock:
            if quote["tokens"] > self._state["pool_token"]:
                raise TradeError("市場プールのトークンが不足しています。")

    def validate_sell(self, user_id: str, token_amount: float, now: datetime | None = None,
                      fee_rate: float | None = None,
                      cap_ratio: float | None = None) -> None:
        now = now or datetime.now(JST)
        token_amount = quantize_tokens(token_amount)
        if token_amount <= 0:
            raise TradeError(f"{TOKEN_NAME}の数量を正しく入力してください。")
        reason = self.side_halt("sell", now)
        if reason:
            raise TradeError(reason)
        if self.token_balance(user_id) < token_amount:
            raise TradeError(f"{TOKEN_NAME}が不足しています。")
        quote = self.quote_sell(token_amount, fee_rate)
        if quote["gross_aga"] < MIN_TRADE_AGA:
            raise TradeError(f"最低取引額は {MIN_TRADE_AGA} AGO です。")
        if quote["gross_aga"] > self.trade_cap_aga(cap_ratio):
            raise TradeError("1回の取引上限を超えています。数量を下げてください。")
        with self._lock:
            if quote["net_aga"] > self._state["pool_aga"]:
                raise TradeError("市場プールのコインが不足しています。")

    def apply_buy(self, user_id: str, aga_amount: int, fee_rate: float | None = None) -> dict[str, Any]:
        """検証済みの買いをプールとユーザ残高へ反映する（コインの実移動は呼び出し側）。"""
        quote = self.quote_buy(aga_amount, fee_rate)
        burn = int(quote["fee"] * FEE_BURN_SHARE)
        with self._lock:
            state = self._state
            if quote["tokens"] > state["pool_token"]:
                raise TradeError("市場プールのトークンが不足しています。")
            state["pool_token"] -= quote["tokens"]
            state["pool_aga"] += aga_amount - burn
            state["burned_aga"] += burn
            state["net_flow_aga"] += quote["net_aga"]
            key = str(user_id)
            state["balances"][key] = state["balances"].get(key, 0.0) + quote["tokens"]
            self._mark_dirty()
        return {**quote, "burned": burn, "balance": self.token_balance(user_id)}

    def apply_sell(self, user_id: str, token_amount: float, fee_rate: float | None = None) -> dict[str, Any]:
        token_amount = quantize_tokens(token_amount)
        quote = self.quote_sell(token_amount, fee_rate)
        burn = int(quote["fee"] * FEE_BURN_SHARE)
        with self._lock:
            state = self._state
            key = str(user_id)
            if state["balances"].get(key, 0.0) < token_amount:
                raise TradeError(f"{TOKEN_NAME}が不足しています。")
            state["balances"][key] -= token_amount
            if state["balances"][key] <= 0:
                del state["balances"][key]
            state["pool_token"] += token_amount
            state["pool_aga"] -= quote["net_aga"] + burn
            state["burned_aga"] += burn
            state["net_flow_aga"] -= quote["gross_aga"]
            self._mark_dirty()
        return {**quote, "burned": burn, "balance": self.token_balance(user_id)}

    def rollback_buy(self, user_id: str, aga_amount: int, result: dict[str, Any]) -> None:
        """コイン側の反映に失敗したときの巻き戻し（apply_buy の逆操作）。"""
        with self._lock:
            state = self._state
            key = str(user_id)
            state["balances"][key] = state["balances"].get(key, 0.0) - result["tokens"]
            if state["balances"][key] <= 0:
                state["balances"].pop(key, None)
            state["pool_token"] += result["tokens"]
            state["pool_aga"] -= aga_amount - result["burned"]
            state["burned_aga"] -= result["burned"]
            state["net_flow_aga"] -= result["net_aga"]
            self._mark_dirty()

    def rollback_sell(self, user_id: str, token_amount: float, result: dict[str, Any]) -> None:
        token_amount = quantize_tokens(token_amount)
        with self._lock:
            state = self._state
            key = str(user_id)
            state["balances"][key] = state["balances"].get(key, 0.0) + token_amount
            state["pool_token"] -= token_amount
            state["pool_aga"] += result["net_aga"] + result["burned"]
            state["burned_aga"] -= result["burned"]
            state["net_flow_aga"] += result["gross_aga"]
            self._mark_dirty()


# ---------------------------------------------------------------------------
# チャート（OHLC 集計は純関数、描画は cogs 側で遅延 import する）
# ---------------------------------------------------------------------------

def ohlc_buckets(history: list[dict[str, Any]], *, hours: int = 5, now: datetime | None = None) -> list[dict[str, Any]]:
    """レート履歴を5分足 OHLC＋出来高に集計する（過去 hours 時間分）。

    tick が5分周期なので 1 tick = 1 バケット。始値は前バケットの終値で補う。
    """
    now = now or datetime.now(JST)
    cutoff = now - timedelta(hours=hours)
    points = []
    for entry in history:
        try:
            at = datetime.fromisoformat(entry["t"])
        except (ValueError, TypeError, KeyError):
            continue
        if at >= cutoff:
            points.append((at, float(entry["rate"]), float(entry.get("volume") or 0)))
    buckets: list[dict[str, Any]] = []
    prev_close: float | None = None
    for at, rate, volume in points:
        open_ = prev_close if prev_close is not None else rate
        buckets.append({
            "t": at, "open": open_, "high": max(open_, rate),
            "low": min(open_, rate), "close": rate, "volume": volume,
        })
        prev_close = rate
    return buckets


def moving_average(values: list[float], window: int = 20) -> list[float | None]:
    result: list[float | None] = []
    for i in range(len(values)):
        if i + 1 < window:
            result.append(None)
        else:
            result.append(sum(values[i + 1 - window: i + 1]) / window)
    return result
