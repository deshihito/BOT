# -*- coding: utf-8 -*-
"""ボードゲーム（将棋・チェス・オセロ）の汎用 Elo レート。

人狼のレート（core/game/jinrou/ratings.py の calculate_elo_change）と同じ方式:
- 初期レート 1500、K=32（人狼の ELO_BASE_K と同じ。人狼側の陣営補正 K=48 は
  チーム戦専用なので 1 対 1 のボードゲームには使わない）
- 期待勝率 = 1 / (1 + 10 ** ((相手 - 自分) / 400))

対象は対人戦のみ（CPU 戦は記録しない）。引き分けは標準どおり
スコア 0.5 同士としてレートを計算する（勝敗数には数えず draw に記録）。

保存はサーバー（ギルド）×ゲーム×ユーザー単位の専用 JSON
（既定 data/elo_ratings.json、環境変数 ELO_RATINGS_PATH で変更可）。
対局は低頻度なので、記録のたびに原子的に書き出す。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from core.support import data_paths

logger = logging.getLogger(__name__)

STARTING_RATING = 1500.0
K_FACTOR = 32
GAMES = ("othello", "shogi", "chess", "gomoku", "connect4")

_DEFAULT_PATH = data_paths.data_path("elo_ratings.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/elo_ratings.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(__file__, "elo_ratings.json")


def default_path() -> Path:
    return Path(os.environ.get("ELO_RATINGS_PATH") or _DEFAULT_PATH)


def expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def match_changes(rating_winner: float, rating_loser: float) -> tuple:
    """(勝者の増分, 敗者の増分)。人狼側 calculate_elo_change と同じ式。"""
    change = K_FACTOR * (1.0 - expected_score(rating_winner, rating_loser))
    return change, -change


def draw_changes(rating_a: float, rating_b: float) -> tuple:
    """引き分け (0.5 - 期待勝率) × K を双方へ。"""
    change_a = K_FACTOR * (0.5 - expected_score(rating_a, rating_b))
    change_b = K_FACTOR * (0.5 - expected_score(rating_b, rating_a))
    return change_a, change_b


def _clean_entry(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"rating": STARTING_RATING, "wins": 0, "losses": 0, "draws": 0}
    return {
        "rating": float(raw.get("rating") or STARTING_RATING),
        "wins": int(raw.get("wins") or 0),
        "losses": int(raw.get("losses") or 0),
        "draws": int(raw.get("draws") or 0),
    }


class EloStore:
    """{f"{guild_id}:{game}:{user_id}": entry} を持つ小さなストア。"""

    def __init__(self, path: Path | str | None = None):
        self._path = Path(path) if path is not None else default_path()
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict[str, dict[str, Any]]:
        raw = self._read_raw()
        if not isinstance(raw, dict):
            return {}
        return {str(k): _clean_entry(v) for k, v in raw.items()}

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする (旧パス主・正規パスはキー単位で補完)。
        # 環境変数や明示パスで保存先が指定されている場合は移行しない。
        if self._path == _DEFAULT_PATH:
            return data_paths.load_migrated(self._path, _STRAY_PATH, fill=True)
        return data_paths.read_json(self._path)

    def _flush(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self._path)

    @staticmethod
    def _key(guild_id, game: str, user_id) -> str:
        return f"{int(guild_id)}:{game}:{int(user_id)}"

    def get(self, guild_id, game: str, user_id) -> dict[str, Any]:
        with self._lock:
            entry = self._data.get(self._key(guild_id, game, user_id))
            return dict(entry) if entry is not None else _clean_entry(None)

    def record_match(self, guild_id, game: str, winner_id, loser_id) -> dict[str, Any]:
        """勝敗を記録し、両者の更新後エントリと増分を返す。"""
        if game not in GAMES or not guild_id or winner_id == loser_id:
            return {}
        with self._lock:
            w = self._data.setdefault(self._key(guild_id, game, winner_id), _clean_entry(None))
            l = self._data.setdefault(self._key(guild_id, game, loser_id), _clean_entry(None))
            dw, dl = match_changes(w["rating"], l["rating"])
            w["rating"] += dw
            l["rating"] += dl
            w["wins"] += 1
            l["losses"] += 1
            result = {"winner": dict(w), "loser": dict(l), "winner_delta": dw, "loser_delta": dl}
            snapshot = copy.deepcopy(self._data)
        self._flush()
        return result

    def record_draw(self, guild_id, game: str, user_a, user_b) -> dict[str, Any]:
        if game not in GAMES or not guild_id or user_a == user_b:
            return {}
        with self._lock:
            a = self._data.setdefault(self._key(guild_id, game, user_a), _clean_entry(None))
            b = self._data.setdefault(self._key(guild_id, game, user_b), _clean_entry(None))
            da, db = draw_changes(a["rating"], b["rating"])
            a["rating"] += da
            b["rating"] += db
            a["draws"] += 1
            b["draws"] += 1
            result = {"a": dict(a), "b": dict(b), "a_delta": da, "b_delta": db}
        self._flush()
        return result

    def top(self, guild_id, game: str, limit: int = 10) -> list:
        """[(user_id, rating, wins, losses, draws), ...] をレート順に返す。"""
        prefix = f"{int(guild_id)}:{game}:"
        with self._lock:
            rows = []
            for key, entry in self._data.items():
                if key.startswith(prefix):
                    uid = int(key.rsplit(":", 1)[1])
                    rows.append((uid, entry["rating"], entry["wins"], entry["losses"], entry["draws"]))
        return sorted(rows, key=lambda r: (-r[1], r[0]))[:limit]


_shared: EloStore | None = None


def shared() -> EloStore:
    global _shared
    if _shared is None:
        _shared = EloStore()
    return _shared


def record_match_safely(guild_id, game: str, winner_id, loser_id) -> dict[str, Any] | None:
    try:
        return shared().record_match(guild_id, game, winner_id, loser_id)
    except Exception:
        logger.debug("elo record_match failed", exc_info=True)
        return None


def record_draw_safely(guild_id, game: str, user_a, user_b) -> dict[str, Any] | None:
    try:
        return shared().record_draw(guild_id, game, user_a, user_b)
    except Exception:
        logger.debug("elo record_draw failed", exc_info=True)
        return None


def format_match_line(winner, loser, result: dict[str, Any] | None) -> str:
    """結果表示に付けるレート変動の1行。記録できなければ空文字。"""
    if not result:
        return ""
    return (f"📈 レート: {winner.mention} {result['winner']['rating']:.0f}（{result['winner_delta']:+.0f}）"
            f" / {loser.mention} {result['loser']['rating']:.0f}（{result['loser_delta']:+.0f}）")
