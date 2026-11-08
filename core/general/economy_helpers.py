# -*- coding: utf-8 -*-
"""経済系 cog 群の共通ボイラープレート（sweep2 GEN-08 で集約）。

取引履歴の記録・WalletCog の取得・アイテム名解決・トークン量整形は、
circulation / items / market / role_shop / workshop / money_panel で
同型実装が複製されていたため、ここを単一の真実にする。各 cog 側の
``_record_history`` / ``_wallet`` 等の名前は呼び出し互換のため
薄い委譲として残す。
"""
from __future__ import annotations

import asyncio
import logging

import config
from core.general.items import items as items_core
from core.support.messages import feature_not_loaded

logger = logging.getLogger(__name__)


async def record_transaction_history(sender_id: str, receiver_id: str, amount: int,
                                     reason: str, *, log_label: str) -> None:
    """取引履歴を transaction_history へ記録する（失敗しても操作自体は止めない）。"""
    try:
        await asyncio.to_thread(lambda: config.db_api.table("transaction_history").insert({
            "sender_id": sender_id,
            "receiver_id": receiver_id,
            "amount": amount,
            "reason": reason,
        }).execute())
    except Exception:
        logger.exception("%s: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                         log_label, sender_id, receiver_id, amount)


def wallet_cog(bot, error_factory=None):
    """WalletCog を返す。未読込で error_factory があればその例外を送出する。"""
    wallet = bot.get_cog("WalletCog")
    if wallet is None and error_factory is not None:
        raise error_factory(feature_not_loaded("コイン機能"))
    return wallet


def item_name(item_id: str) -> str:
    definition = items_core.ITEM_DEFS.get(item_id)
    return definition["name"] if definition else item_id


def fmt_tokens(amount: float) -> str:
    return f"{amount:,.2f}"
