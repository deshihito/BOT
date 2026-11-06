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


def _clean_wordle_daily(raw: Any) -> dict[str, dict[str, dict[str, Any]]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for date_key, users in raw.items():
        if not isinstance(users, dict):
            continue
        cleaned = {}
        for user_id, entry in users.items():
            if isinstance(entry, dict):
                cleaned[str(user_id)] = {
                    "guild_id": int(entry.get("guild_id") or 0),
                    "attempts": int(entry.get("attempts") or 0),
                    "won": bool(entry.get("won")),
                    "winning_guess": bool(entry.get("winning_guess")),
                }
        out[str(date_key)] = cleaned
    return out


def _clean_sweeper(raw: Any) -> dict[str, dict[str, dict[str, Any]]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for user_id, difficulties in raw.items():
        if not isinstance(difficulties, dict):
            continue
        cleaned = {}
        for key, entry in difficulties.items():
            if isinstance(entry, dict):
                best = entry.get("best_seconds")
                cleaned[str(key)] = {
                    "plays": int(entry.get("plays") or 0),
                    "clears": int(entry.get("clears") or 0),
                    "best_seconds": float(best) if best else None,
                }
        out[str(user_id)] = cleaned
    return out


def _clean_highlow(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for user_id, entry in raw.items():
        if isinstance(entry, dict):
            out[str(user_id)] = {
                "plays": int(entry.get("plays") or 0),
                "best_streak": int(entry.get("best_streak") or 0),
                "total_correct": int(entry.get("total_correct") or 0),
            }
    return out


def _clean_g2048(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for user_id, entry in raw.items():
        if isinstance(entry, dict):
            out[str(user_id)] = {
                "plays": int(entry.get("plays") or 0),
                "best_score": int(entry.get("best_score") or 0),
                "best_tile": int(entry.get("best_tile") or 0),
                "clears": int(entry.get("clears") or 0),
            }
    return out


def _clean_sudoku(raw: Any) -> dict[str, dict[str, dict[str, Any]]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for user_id, difficulties in raw.items():
        if not isinstance(difficulties, dict):
            continue
        cleaned = {}
        for key, entry in difficulties.items():
            if isinstance(entry, dict):
                best = entry.get("best_seconds")
                cleaned[str(key)] = {
                    "plays": int(entry.get("plays") or 0),
                    "clears": int(entry.get("clears") or 0),
                    "best_seconds": float(best) if best else None,
                }
        out[str(user_id)] = cleaned
    return out


def _clean_twochoice(raw: Any) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for user_id, entry in raw.items():
        if isinstance(entry, dict):
            out[str(user_id)] = {
                "sessions": int(entry.get("sessions") or 0),
                "votes": int(entry.get("votes") or 0),
                "minority": int(entry.get("minority") or 0),
            }
    return out


def _clean_coop(raw: Any, fields: tuple[str, ...]) -> dict[str, dict[str, int]]:
    """協力ゲーム（ラウンド4）共通の単純な記録クリーナ。"""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for user_id, entry in raw.items():
        if isinstance(entry, dict):
            out[str(user_id)] = {f: int(entry.get(f) or 0) for f in fields}
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
        empty = {"flash": {}, "guess": {}, "sweeper": {}, "wordle_daily": {},
                 "highlow": {}, "g2048": {}, "sudoku": {}, "nonogram": {}, "twochoice": {},
                 "justone": {}, "ito": {}, "hanabi": {}}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return empty
        if not isinstance(raw, dict):
            return empty
        return {"flash": _clean_flash(raw.get("flash")), "guess": _clean_guess(raw.get("guess")),
                "sweeper": _clean_sweeper(raw.get("sweeper")),
                "wordle_daily": _clean_wordle_daily(raw.get("wordle_daily")),
                "highlow": _clean_highlow(raw.get("highlow")),
                "g2048": _clean_g2048(raw.get("g2048")),
                "sudoku": _clean_sudoku(raw.get("sudoku")),
                "nonogram": _clean_sudoku(raw.get("nonogram")),
                "twochoice": _clean_twochoice(raw.get("twochoice")),
                "justone": _clean_coop(raw.get("justone"), ("plays", "best_successes", "total_successes")),
                "ito": _clean_coop(raw.get("ito"), ("plays", "clears")),
                "hanabi": _clean_coop(raw.get("hanabi"), ("plays", "best_score", "total_score"))}

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

    # ------------------------------------------------------------------ ハイ＆ロー
    def record_highlow(self, user_id, streak: int) -> dict[str, Any]:
        """1 プレイ（ゲームオーバーまで）を記録し、更新後の記録を返す。"""
        with self._lock:
            entry = self._data["highlow"].setdefault(
                str(user_id), {"plays": 0, "best_streak": 0, "total_correct": 0}
            )
            entry["plays"] += 1
            entry["total_correct"] += int(streak)
            best_updated = int(streak) > entry["best_streak"]
            if best_updated:
                entry["best_streak"] = int(streak)
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_highlow(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["highlow"].get(str(user_id))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ 2048
    def record_2048(self, user_id, score: int, max_tile: int) -> dict[str, Any]:
        """1 プレイの終了を記録し、更新後の記録を返す。"""
        with self._lock:
            entry = self._data["g2048"].setdefault(
                str(user_id), {"plays": 0, "best_score": 0, "best_tile": 0, "clears": 0}
            )
            entry["plays"] += 1
            if int(max_tile) >= 2048:
                entry["clears"] += 1
            best_updated = int(score) > entry["best_score"]
            if best_updated:
                entry["best_score"] = int(score)
            if int(max_tile) > entry["best_tile"]:
                entry["best_tile"] = int(max_tile)
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_2048(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["g2048"].get(str(user_id))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ 数独 / ノノグラム（タイム記録）
    def _record_timed(self, section: str, user_id, key: str, cleared: bool,
                      seconds: float | None) -> dict[str, Any]:
        with self._lock:
            entry = self._data[section].setdefault(str(user_id), {}).setdefault(
                str(key), {"plays": 0, "clears": 0, "best_seconds": None}
            )
            entry["plays"] += 1
            best_updated = False
            if cleared:
                entry["clears"] += 1
                if seconds is not None and (entry["best_seconds"] is None or seconds < entry["best_seconds"]):
                    entry["best_seconds"] = float(seconds)
                    best_updated = True
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def record_sudoku(self, user_id, difficulty: str, cleared: bool, seconds: float | None) -> dict[str, Any]:
        return self._record_timed("sudoku", user_id, difficulty, cleared, seconds)

    def get_sudoku(self, user_id, difficulty: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._data["sudoku"].get(str(user_id), {}).get(str(difficulty))
            return dict(entry) if entry is not None else None

    def record_nonogram(self, user_id, size: str, cleared: bool, seconds: float | None) -> dict[str, Any]:
        return self._record_timed("nonogram", user_id, size, cleared, seconds)

    def get_nonogram(self, user_id, size: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._data["nonogram"].get(str(user_id), {}).get(str(size))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ 究極の二択
    def record_twochoice(self, user_id, votes: int, minority: int) -> dict[str, int]:
        """1 セッションへの参加（投票 votes 回・少数派 minority 回）を記録する。"""
        with self._lock:
            entry = self._data["twochoice"].setdefault(
                str(user_id), {"sessions": 0, "votes": 0, "minority": 0}
            )
            entry["sessions"] += 1
            entry["votes"] += int(votes)
            entry["minority"] += int(minority)
            self._dirty += 1
            result = dict(entry)
        self._maybe_flush()
        return result

    def get_twochoice(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["twochoice"].get(str(user_id))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ マインスイーパー
    def record_sweeper(self, user_id, difficulty: str, cleared: bool, seconds: float | None) -> dict[str, Any]:
        """1 プレイの終了（クリア/爆発/あきらめ）を記録し、難易度別の記録を返す。"""
        with self._lock:
            entry = self._data["sweeper"].setdefault(str(user_id), {}).setdefault(
                str(difficulty), {"plays": 0, "clears": 0, "best_seconds": None}
            )
            entry["plays"] += 1
            best_updated = False
            if cleared:
                entry["clears"] += 1
                if seconds is not None and (entry["best_seconds"] is None or seconds < entry["best_seconds"]):
                    entry["best_seconds"] = float(seconds)
                    best_updated = True
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_sweeper(self, user_id, difficulty: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._data["sweeper"].get(str(user_id), {}).get(str(difficulty))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ Wordle デイリー
    @staticmethod
    def _daily_better(new: dict, old: dict) -> bool:
        """デイリー記録の優劣: 勝ち > 負け、同条件なら手数が少ない方。"""
        if new["won"] != old["won"]:
            return new["won"]
        return new["attempts"] < old["attempts"]

    def record_wordle_daily(self, user_id, guild_id, date_key: str, attempts: int, won: bool,
                            winning_guess: bool = False) -> dict[str, Any]:
        """その日のデイリー結果を記録する（同じ日は良い方の結果だけ残す）。"""
        with self._lock:
            day = self._data["wordle_daily"].setdefault(str(date_key), {})
            new = {"guild_id": int(guild_id or 0), "attempts": int(attempts),
                   "won": bool(won), "winning_guess": bool(winning_guess)}
            old = day.get(str(user_id))
            if old is None or self._daily_better(new, old):
                day[str(user_id)] = new
                self._dirty += 1
                result = dict(new)
            else:
                result = dict(old)
        self._maybe_flush()
        return result

    def wordle_daily_for(self, date_key: str, guild_id=None) -> list:
        """その日の記録 [(user_id, entry), ...]（勝ち→手数少ない順）。"""
        with self._lock:
            day = self._data["wordle_daily"].get(str(date_key), {})
            rows = [(int(uid), dict(e)) for uid, e in day.items()
                    if guild_id is None or e.get("guild_id") == int(guild_id)]
        return sorted(rows, key=lambda r: (not r[1]["won"], r[1]["attempts"], r[0]))

    def get_guess(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["guess"].get(str(user_id))
            return dict(entry) if entry is not None else None

    # ------------------------------------------------------------------ ラウンド4協力系
    def record_justone(self, user_id, successes: int) -> dict[str, Any]:
        """ひとことヒント: 1セッションの成功数を記録（チーム全員に同じ結果）。"""
        with self._lock:
            entry = self._data["justone"].setdefault(
                str(user_id), {"plays": 0, "best_successes": 0, "total_successes": 0})
            entry["plays"] += 1
            entry["total_successes"] += int(successes)
            best_updated = int(successes) > entry["best_successes"]
            if best_updated:
                entry["best_successes"] = int(successes)
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_justone(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["justone"].get(str(user_id))
            return dict(entry) if entry is not None else None

    def record_ito(self, user_id, clears: int, rounds: int) -> dict[str, Any]:
        """たとえナンバー: テーマ成功数（clears/rounds）を記録。"""
        with self._lock:
            entry = self._data["ito"].setdefault(str(user_id), {"plays": 0, "clears": 0})
            entry["plays"] += 1
            entry["clears"] += int(clears)
            self._dirty += 1
            result = dict(entry)
        self._maybe_flush()
        return result

    def get_ito(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["ito"].get(str(user_id))
            return dict(entry) if entry is not None else None

    def record_hanabi(self, user_id, score: int) -> dict[str, Any]:
        """花火大会: 完成スコアを記録（チーム全員に同じ結果）。"""
        with self._lock:
            entry = self._data["hanabi"].setdefault(
                str(user_id), {"plays": 0, "best_score": 0, "total_score": 0})
            entry["plays"] += 1
            entry["total_score"] += int(score)
            best_updated = int(score) > entry["best_score"]
            if best_updated:
                entry["best_score"] = int(score)
            self._dirty += 1
            result = dict(entry, best_updated=best_updated)
        self._maybe_flush()
        return result

    def get_hanabi(self, user_id) -> dict[str, int] | None:
        with self._lock:
            entry = self._data["hanabi"].get(str(user_id))
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


def record_sweeper_safely(user_id, difficulty: str, cleared: bool, seconds: float | None) -> dict[str, Any] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_sweeper(user_id, difficulty, cleared, seconds)
    except Exception:
        logger.debug("sweeper record failed", exc_info=True)
        return None


def format_sweeper_line(entry: dict[str, Any], difficulty_label: str) -> str:
    """マインスイーパーの結果に付ける、自分の記録の 1 行。"""
    plays = int(entry.get("plays") or 0)
    clears = int(entry.get("clears") or 0)
    best = entry.get("best_seconds")
    best_text = f"{best:.1f}秒" if best else "―"
    line = f"📊 {difficulty_label}の記録: {plays}回中{clears}回クリア／ベストタイム {best_text}"
    if entry.get("best_updated"):
        line += " 🎉 ベストタイム更新！"
    return line


def record_wordle_daily_safely(user_id, guild_id, date_key: str, attempts: int, won: bool,
                               winning_guess: bool = False) -> dict[str, Any] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_wordle_daily(user_id, guild_id, date_key, attempts, won, winning_guess)
    except Exception:
        logger.debug("wordle daily record failed", exc_info=True)
        return None


def record_highlow_safely(user_id, streak: int) -> dict[str, Any] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_highlow(user_id, streak)
    except Exception:
        logger.debug("highlow record failed", exc_info=True)
        return None


def format_highlow_line(entry: dict[str, Any], streak: int) -> str:
    """ハイ＆ローの結果に付ける、自分の記録の 1 行。"""
    line = (f"📊 今回: 連続{streak}回正解／通算 {int(entry.get('plays') or 0)}プレイ"
            f"・連続正解ベスト {int(entry.get('best_streak') or 0)}回")
    if entry.get("best_updated"):
        line += " 🎉 連続正解の自己ベスト更新！"
    return line


def record_2048_safely(user_id, score: int, max_tile: int) -> dict[str, Any] | None:
    try:
        return shared().record_2048(user_id, score, max_tile)
    except Exception:
        logger.debug("2048 record failed", exc_info=True)
        return None


def format_2048_line(entry: dict[str, Any], score: int, max_tile: int) -> str:
    line = (f"📊 今回: スコア {score}・最大タイル {max_tile}／ベストスコア "
            f"{int(entry.get('best_score') or 0)}・最大タイル記録 {int(entry.get('best_tile') or 0)}"
            f"（{int(entry.get('plays') or 0)}プレイ）")
    if entry.get("best_updated"):
        line += " 🎉 スコアの自己ベスト更新！"
    return line


def record_sudoku_safely(user_id, difficulty: str, cleared: bool, seconds: float | None) -> dict[str, Any] | None:
    try:
        return shared().record_sudoku(user_id, difficulty, cleared, seconds)
    except Exception:
        logger.debug("sudoku record failed", exc_info=True)
        return None


def record_nonogram_safely(user_id, size: str, cleared: bool, seconds: float | None) -> dict[str, Any] | None:
    try:
        return shared().record_nonogram(user_id, size, cleared, seconds)
    except Exception:
        logger.debug("nonogram record failed", exc_info=True)
        return None


def format_timed_line(entry: dict[str, Any], label: str) -> str:
    """数独・ノノグラムの結果に付ける、自分の記録の 1 行。"""
    plays = int(entry.get("plays") or 0)
    clears = int(entry.get("clears") or 0)
    best = entry.get("best_seconds")
    best_text = f"{best:.1f}秒" if best else "―"
    line = f"📊 {label}の記録: {plays}回中{clears}回クリア／ベストタイム {best_text}"
    if entry.get("best_updated"):
        line += " 🎉 ベストタイム更新！"
    return line


def record_twochoice_safely(user_id, votes: int, minority: int) -> dict[str, int] | None:
    try:
        return shared().record_twochoice(user_id, votes, minority)
    except Exception:
        logger.debug("twochoice record failed", exc_info=True)
        return None


def record_justone_safely(user_id, successes: int) -> dict[str, Any] | None:
    try:
        return shared().record_justone(user_id, successes)
    except Exception:
        logger.debug("justone record failed", exc_info=True)
        return None


def record_ito_safely(user_id, clears: int, rounds: int) -> dict[str, Any] | None:
    try:
        return shared().record_ito(user_id, clears, rounds)
    except Exception:
        logger.debug("ito record failed", exc_info=True)
        return None


def record_hanabi_safely(user_id, score: int) -> dict[str, Any] | None:
    try:
        return shared().record_hanabi(user_id, score)
    except Exception:
        logger.debug("hanabi record failed", exc_info=True)
        return None


def record_guess_safely(user_id, bet: int, won: bool, delta: int) -> dict[str, int] | None:
    """記録に失敗してもゲームを止めないためのラッパ。失敗時は None。"""
    try:
        return shared().record_guess(user_id, bet, won, delta)
    except Exception:
        logger.debug("guess record failed", exc_info=True)
        return None
