"""ソロゲーム（フラッシュ暗算・数字当て）の個人記録。

これまで両ゲームとも結果がその場で消え、繰り返し遊ぶ動機が無かった。
ここでは「自分の記録」だけを持つ軽量ストアを用意する（ランキングは持たない）。

- フラッシュ暗算: 設定（個数・桁数・間隔）ごとに プレイ数 / 正解数 / 連続正解ベスト
- 数字当て: プレイ数 / 勝利数 / 総賭け額 / 総収支（残高への実際の増減の合計）

保存は core/usage_stats.py と同じ流儀の専用 JSON（既定 ``data/game_records.json``、
環境変数 ``GAME_RECORDS_PATH`` で変更可）。毎回は書かず、一定件数ごと／一定時間
ごとにまとめて書き出す。記録の失敗でゲーム本体を壊さないよう、呼び出し側では
``*_safely`` 系を使う。
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

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "game_records.json"


def default_path() -> Path:
    return Path(os.environ.get("GAME_RECORDS_PATH") or _DEFAULT_PATH)


def flash_setting_key(count: int, digits: int, interval: float) -> str:
    """フラッシュ暗算の設定を 1 つのキーにする（個数・桁数・間隔）。"""
    return f"{int(count)}:{int(digits)}:{float(interval):g}"


def _clean_flash(raw: Any) -> dict[str, dict[str, dict[str, int]]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, dict[str, int]]] = {}
    for user_id, settings in raw.items():
        if not isinstance(settings, dict):
            continue
        cleaned = {}
        for key, entry in settings.items():
            if isinstance(entry, dict):
                cleaned[str(key)] = {
                    "plays": int(entry.get("plays") or 0),
                    "correct": int(entry.get("correct") or 0),
                    "best_streak": int(entry.get("best_streak") or 0),
                    "streak": int(entry.get("streak") or 0),
                }
        out[str(user_id)] = cleaned
    return out


def _clean_guess(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for user_id, entry in raw.items():
        if isinstance(entry, dict):
            out[str(user_id)] = {
                "plays": int(entry.get("plays") or 0),
                "wins": int(entry.get("wins") or 0),
                "total_bet": int(entry.get("total_bet") or 0),
                "net": int(entry.get("net") or 0),
            }
    return out


class GameRecordsStore:
    """ソロゲーム記録の保持と JSON への保存を担う（同期 API、メモリ主体）。"""

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
        self._lock = threading.Lock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return {"flash": {}, "guess": {}}
        if not isinstance(raw, dict):
            return {"flash": {}, "guess": {}}
        return {"flash": _clean_flash(raw.get("flash")), "guess": _clean_guess(raw.get("guess"))}

    def flush(self) -> None:
        """現在の記録を JSON に書き出す（tmp 経由で原子的に差し替える）。"""
        with self._lock:
            payload = copy.deepcopy(self._data)
            self._dirty = 0
            self._last_flush = time.monotonic()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self._path)

    def _maybe_flush(self) -> None:
        if self._dirty >= self._flush_every or (
            self._dirty > 0 and time.monotonic() - self._last_flush >= self._flush_interval
        ):
            try:
                self.flush()
            except Exception:
                logger.debug("game records flush failed", exc_info=True)

    # ------------------------------------------------------------------ フラッシュ暗算
    def record_flash(self, user_id, count: int, digits: int, interval: float, correct: bool) -> dict[str, Any]:
        """1 プレイ分を記録し、更新後の記録（best_updated 付き）を返す。"""
        key = flash_setting_key(count, digits, interval)
        with self._lock:
            entry = self._data["flash"].setdefault(str(user_id), {}).setdefault(
                key, {"plays": 0, "correct": 0, "best_streak": 0, "streak": 0}
            )
            entry["plays"] += 1
            best_updated = False
            if correct:
                entry["correct"] += 1
                entry["streak"] += 1
                if entry["streak"] > entry["best_streak"]:
                    entry["best_streak"] = entry["streak"]
                    best_updated = True
            else:
                entry["streak"] = 0
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_flash(self, user_id, count: int, digits: int, interval: float) -> dict[str, int] | None:
        key = flash_setting_key(count, digits, interval)
        with self._lock:
            entry = self._data["flash"].get(str(user_id), {}).get(key)
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ 数字当て
    def record_guess(self, user_id, bet: int, won: bool, delta: int) -> dict[str, int]:
        """1 プレイ分を記録し、更新後の通算成績を返す。delta は残高への実際の増減。"""
        with self._lock:
            entry = self._data["guess"].setdefault(
                str(user_id), {"plays": 0, "wins": 0, "total_bet": 0, "net": 0}
            )
            entry["plays"] += 1
            entry["wins"] += 1 if won else 0
            entry["total_bet"] += int(bet)
            entry["net"] += int(delta)
            self._dirty += 1
            result = dict(entry)
        self._maybe_flush()
        return result

    def get_guess(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["guess"].get(str(user_id))
            return dict(entry) if entry is not None else None


# ---------------------------------------------------------------------- 表示ヘルパ
def format_flash_line(entry: dict[str, Any], count: int, digits: int, interval: float) -> str:
    """フラッシュ暗算の結果に付ける、自分の記録の 1 行。"""
    plays = int(entry.get("plays") or 0)
    correct = int(entry.get("correct") or 0)
    rate = (correct * 100.0 / plays) if plays else 0.0
    line = (
        f"📊 この設定（{count}個・{digits}桁・{interval:g}秒）の記録: "
        f"{plays}回中{correct}回正解（正答率 {rate:.0f}%）／連続正解ベスト {int(entry.get('best_streak') or 0)}回"
    )
    if entry.get("best_updated"):
        line += " 🎉 連続正解の自己ベスト更新！"
    return line


def format_guess_stats(entry: dict[str, Any]) -> str:
    """数字当ての結果に付ける、自分の通算成績の 1 行。"""
    plays = int(entry.get("plays") or 0)
    wins = int(entry.get("wins") or 0)
    rate = (wins * 100.0 / plays) if plays else 0.0
    return (
        f"{plays}回中{wins}勝（勝率 {rate:.0f}%）／総収支 {int(entry.get('net') or 0):+,} ago"
        f"／総賭け額 {int(entry.get('total_bet') or 0):,} ago"
    )


# ---------------------------------------------------------------------- 共有インスタンス
_shared: GameRecordsStore | None = None


def shared() -> GameRecordsStore:
    global _shared
    if _shared is None:
        _shared = GameRecordsStore()
    return _shared


def record_flash_safely(user_id, count: int, digits: int, interval: float, correct: bool) -> dict[str, Any] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_flash(user_id, count, digits, interval, correct)
    except Exception:
        logger.debug("flash record failed", exc_info=True)
        return None


def record_guess_safely(user_id, bet: int, won: bool, delta: int) -> dict[str, int] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_guess(user_id, bet, won, delta)
    except Exception:
        logger.debug("guess record failed", exc_info=True)
        return None
