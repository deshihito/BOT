# -*- coding: utf-8 -*-
"""BOT fixer ①: AGOコマンド制限（/support「モデレーション」>「BOT fixer」）。

ギルド管理者が AGO BOT 自身の機能（レジストリのアクション）をギルド単位で
制限するための判定とレート制限カウンタ。設定は GuildSettings の
``command_control`` セクションに保存する:

- mode: ``off``（制限なし＝既定）/ ``deny``（リストしたアクションを使えない）/
  ``allow``（リストしたアクションしか使えない）
- actions: 対象アクションID（``general:xxx`` 等の完全ID）のリスト
- rates: アクションID -> {"count": N, "window_seconds": S}。
  そのギルドでそのユーザーは期間内に N 回まで（ユーザー単位）。

執行は各ルートの dispatch 入口（general / vc / support / game / help）が
共通ヘルパー ``guard`` を呼ぶ形に寄せ、二重実装を避ける。対象外は
右クリックメニューや返信トリガ等のメッセージ経由の入口と常駐処理。

ロックアウト防止:
- 設定アクション自身（support:bot_fixer）は常に対象外。
- ギルド管理者（administrator / manage_guild）は制限・レート制限とも対象外。

レートのカウンタはメモリ内（再起動でリセットされる）。
"""
from __future__ import annotations

import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

COMMAND_CONTROL_SECTION = "command_control"
SELF_ACTION_ID = "support:bot_fixer"
# 機能数再編で増えた BOT fixer 自身の入口（他ボット制限／コマンドレート制限）
# も、ロックアウト防止のため設定アクション自身として常に対象外にする。
SELF_ACTION_IDS = frozenset({
    SELF_ACTION_ID,
    "support:bot_fixer_bots",
    "support:bot_fixer_rates",
})

MODE_OFF = "off"
MODE_DENY = "deny"
MODE_ALLOW = "allow"
MODES = (MODE_OFF, MODE_DENY, MODE_ALLOW)
MODE_LABELS = {MODE_OFF: "制限なし", MODE_DENY: "禁止リスト", MODE_ALLOW: "許可リストのみ"}

RESTRICTED_MESSAGE = "このサーバーでは管理者がこの機能の利用を制限しています。"

# レート制限の入力上限（設定モーダル側の検証と共通）。
RATE_MAX_COUNT = 1000
RATE_MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60


def normalize_settings(raw: Any) -> dict[str, Any]:
    """保存済みの生 dict を検証済み設定に整える（壊れた値は既定に倒す）。"""
    if not isinstance(raw, dict):
        raw = {}
    mode = raw.get("mode")
    if mode not in MODES:
        mode = MODE_OFF
    actions: list[str] = []
    seen: set[str] = set()
    for item in raw.get("actions") or []:
        if isinstance(item, str) and item and item not in SELF_ACTION_IDS and item not in seen:
            seen.add(item)
            actions.append(item)
    rates: dict[str, dict[str, int]] = {}
    raw_rates = raw.get("rates")
    if isinstance(raw_rates, dict):
        for action_id, rule in raw_rates.items():
            if not isinstance(action_id, str) or action_id in SELF_ACTION_IDS:
                continue
            if not isinstance(rule, dict):
                continue
            try:
                count = int(rule.get("count"))
                window = int(rule.get("window_seconds"))
            except (TypeError, ValueError):
                continue
            if 1 <= count <= RATE_MAX_COUNT and 1 <= window <= RATE_MAX_WINDOW_SECONDS:
                rates[action_id] = {"count": count, "window_seconds": window}
    return {"mode": mode, "actions": actions, "rates": rates}


def get_settings(store, guild_id: int) -> dict[str, Any]:
    """GuildSettings ストアから検証済みの制限設定を読む（未設定なら既定）。"""
    return normalize_settings(store.get(guild_id, COMMAND_CONTROL_SECTION))


def is_manager(user: Any) -> bool:
    """ギルド管理者（administrator / manage_guild）なら True。"""
    perms = getattr(user, "guild_permissions", None)
    return bool(
        getattr(perms, "administrator", False) or getattr(perms, "manage_guild", False)
    )


def mode_blocks(settings: dict[str, Any], action_id: str) -> bool:
    """モード判定のみ（レートは見ない）。制限されるなら True。"""
    if action_id in SELF_ACTION_IDS:
        return False
    mode = settings.get("mode", MODE_OFF)
    listed = action_id in (settings.get("actions") or [])
    if mode == MODE_DENY:
        return listed
    if mode == MODE_ALLOW:
        return not listed
    return False


class RateCounter:
    """(guild, user, action) 単位のスライディングウィンドウカウンタ（メモリ内）。"""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._hits: dict[tuple[int, int, str], deque] = {}

    def _prune(self, key, window: float, now: float) -> deque:
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] >= window:
            hits.popleft()
        if not hits:
            self._hits.pop(key, None)
            return deque()
        return hits

    def check_and_record(self, guild_id: int, user_id: int, action_id: str,
                         count: int, window_seconds: int,
                         now: Optional[float] = None) -> Optional[float]:
        """記録して上限内なら None、超過なら再試行までの秒数を返す。"""
        now = self._clock() if now is None else now
        key = (guild_id, user_id, action_id)
        hits = self._prune(key, float(window_seconds), now)
        if len(hits) >= count:
            return max(0.0, window_seconds - (now - hits[0]))
        hits.append(now)
        self._hits[key] = hits
        return None

    def reset(self) -> None:
        self._hits.clear()


_DEFAULT_COUNTER = RateCounter()


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    reason: Optional[str] = None       # "restricted" | "rate"
    retry_after: Optional[float] = None


def check(settings: dict[str, Any], action_id: str, *, guild_id: int, user_id: int,
          manager: bool, counter: Optional[RateCounter] = None,
          now: Optional[float] = None) -> Verdict:
    """制限判定の本体（純粋判定＋レート消費）。管理者は常に対象外。"""
    if manager or action_id in SELF_ACTION_IDS:
        return Verdict(True)
    if mode_blocks(settings, action_id):
        return Verdict(False, reason="restricted")
    rule = (settings.get("rates") or {}).get(action_id)
    if rule:
        counter = counter or _DEFAULT_COUNTER
        retry = counter.check_and_record(
            guild_id, user_id, action_id, rule["count"], rule["window_seconds"], now=now)
        if retry is not None:
            return Verdict(False, reason="rate", retry_after=retry)
    return Verdict(True)


def format_retry_after(seconds: float) -> str:
    total = max(1, math.ceil(seconds))
    if total >= 60:
        return f"約{math.ceil(total / 60)}分"
    return f"約{total}秒"


async def guard(interaction, action_id: str) -> bool:
    """dispatch 入口用ガード。実行可なら True、制限中は通知して False。

    設定の読み込みに失敗しても通常処理は止めない（制限なしとして通す）。
    """
    guild_id = getattr(interaction, "guild_id", None)
    if guild_id is None:
        return True
    user = getattr(interaction, "user", None)
    if is_manager(user):
        return True
    try:
        from core.support import guild_settings

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_settings(store, guild_id)
        if settings["mode"] == MODE_OFF and not settings["rates"]:
            return True
        verdict = check(settings, action_id, guild_id=guild_id,
                        user_id=getattr(user, "id", 0), manager=False)
    except Exception:
        logger.exception("コマンド制限の判定に失敗しました（制限なしとして続行）")
        return True
    if verdict.allowed:
        return True
    if verdict.reason == "rate" and verdict.retry_after is not None:
        message = f"{RESTRICTED_MESSAGE}（目安: {format_retry_after(verdict.retry_after)}後に再試行できます）"
    else:
        message = RESTRICTED_MESSAGE
    try:
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
    except Exception:
        logger.exception("コマンド制限の通知に失敗しました")
    return False
