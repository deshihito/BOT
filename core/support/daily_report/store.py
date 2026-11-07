# -*- coding: utf-8 -*-
"""日報（オプトインDM）の単一の置き場。

原典（パンBot）の日報は特定個人の ID がベタ書きで、その人へ無条件に
DM を送るものだった。AGO はグローバルBotなので同意モデルに作り替え、
ユーザーが自分で ON にしたときだけ、その日の経済サマリを DM で送る。

このモジュールが持つのは購読状態（ユーザー単位・永続化）と、
送信対象の判定、レポート文の組み立てまで。実際の DM 送信と
ステータス集約は daily_report の Cog（入口は cogs/support.py）が担う。

保存は core/game/game/prison.py と同じ流儀: 専用 JSON（既定 data/daily_report.json、
環境変数 DAILY_REPORT_DATA_PATH で変更可）にメモリ主体＋バッチ
フラッシュ＋原子差し替え。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from core.general.items.items import JST
from core.game.game.prison import format_remaining

logger = logging.getLogger(__name__)

#: 日報を送る時刻（JST の時）。この時刻を過ぎてから、その日まだ
#: 送っていない購読者へ送る（daily_report の毎分チェック）。
SEND_HOUR_JST = 21

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
            last_sent = entry.get("last_sent")
            state["users"][str(uid)] = {
                "opt_in": bool(entry.get("opt_in")),
                "last_sent": last_sent if isinstance(last_sent, str) else None,
            }
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "daily_report.json"


def default_path() -> Path:
    return Path(os.environ.get("DAILY_REPORT_DATA_PATH") or _DEFAULT_PATH)


class DailyReportStore:
    """日報の購読状態（ON/OFF・最終送信日）と JSON 保存。"""

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
            logger.exception("daily_report: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 購読状態
    def _entry_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(
            str(user_id), {"opt_in": False, "last_sent": None})

    def is_opted_in(self, user_id: str) -> bool:
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return bool(entry.get("opt_in"))

    def set_opt_in(self, user_id: str, opt_in: bool) -> bool:
        """購読状態を設定し、設定後の状態を返す。"""
        with self._lock:
            self._entry_locked(user_id)["opt_in"] = bool(opt_in)
            self._mark_dirty()
            return bool(opt_in)

    def toggle(self, user_id: str) -> bool:
        """購読状態を反転し、反転後の状態を返す。"""
        return self.set_opt_in(user_id, not self.is_opted_in(user_id))

    # ------------------------------------------------------------------ 送信判定
    def due_users(self, now: datetime | None = None) -> list[str]:
        """いま送信すべきユーザー（購読中・送信時刻経過・本日未送信）。"""
        now = now or datetime.now(JST)
        if now.hour < SEND_HOUR_JST:
            return []
        today = now.date().isoformat()
        with self._lock:
            return [
                uid for uid, entry in self._state["users"].items()
                if entry.get("opt_in") and entry.get("last_sent") != today
            ]

    def mark_sent(self, user_id: str, now: datetime | None = None) -> None:
        """本日分を送信済み（または送信試行済み）として記録する。"""
        now = now or datetime.now(JST)
        with self._lock:
            self._entry_locked(user_id)["last_sent"] = now.date().isoformat()
            self._mark_dirty()


def build_report_lines(status: dict, now: datetime | None = None) -> list[str]:
    """経済ステータス（MoneyPanelCog.collect_status 互換）から日報の行を作る。

    集計できなかった項目（None）は無理に作らず省く。数値は「自分の
    結果と状態」だけにし、内部仕様（確率・還流率など）は出さない。
    """
    now = now or datetime.now(JST)
    lines = [f"📬 **{now.strftime('%m/%d')} の日報**"]
    lines.append(f"AGOコイン: **{int(status.get('balance') or 0):,} AGO**")
    if status.get("rate") is not None:
        lines.append(
            f"アゴトークン: **{float(status.get('tokens') or 0):,.2f}**"
            f"（レート {float(status['rate']):,.2f} AGO）")
    if status.get("items_total") is not None:
        lines.append(
            f"アイテム: **{int(status['items_total'])} 個**"
            f"（{int(status.get('items_kinds') or 0)} 種／"
            f"宝箱 {int(status.get('boxes') or 0)} 個）")
    if status.get("machines") is not None and status.get("pending_cycles"):
        lines.append(
            f"工房: 受け取り可能 **{int(status['pending_cycles'])} サイクル分**")
    if status.get("commissions_ready"):
        lines.append(
            f"委託: 受け取り可能 **{int(status['commissions_ready'])} 件**")
    if status.get("lottery_pool") is not None:
        lines.append(
            f"宝くじ: プール **{int(status['lottery_pool']):,} AGO**／"
            f"あなたのチケット **{int(status.get('lottery_tickets') or 0)} 枚**")
    if status.get("mining_session_left"):
        lines.append("採掘: いま掘れます")
    if status.get("prison_remaining"):
        lines.append(
            "🚔 逮捕中です"
            f"（釈放まで{format_remaining(float(status['prison_remaining']))}）")
    return lines
