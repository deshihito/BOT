# -*- coding: utf-8 -*-
"""メンバーキャッシュ方針と、キャッシュに頼らないメンバー取得。

メモリ方針（2026-11-12）:
- 起動時の全ギルド一括チャンク（chunk_guilds_at_startup）は行わない。
  チャンクすると全サーバーの全メンバーが起動直後に常駐し、Pi の
  メモリを圧迫する（実測で Bot プロセス約 1.3GB の主因候補）。
- その代わり、メンバー全件が本当に必要な機能は必要な瞬間に
  ``fetch_members`` で取得する（discord.py の fetch 系はキャッシュに
  残らないため、一時的な使用で済む）。
- member_cache_flags は既定（joined / voice）のままにする。
  joined を切ると GUILD_CREATE 由来や参加・更新イベントで得た
  メンバーまで落ち、プレゼンス更新の配信範囲（fujo status の
  PRESENCE 検知）も狭まるため、削減対象はチャンクに絞る。
- メッセージキャッシュは 500 件に絞る（編集・削除検知は直近分で足りる）。
- typing intent は on_typing を使う機能が無いため切る（受信量の削減）。
"""
from __future__ import annotations

import logging
from typing import Any

import discord

logger = logging.getLogger(__name__)

MAX_MESSAGES = 500


def build_intents() -> discord.Intents:
    """Bot が使う intent 一式。typing だけは利用箇所が無いため外す。"""
    intents = discord.Intents.all()
    intents.guild_typing = False
    intents.dm_typing = False
    return intents


def bot_client_kwargs() -> dict[str, Any]:
    """commands.Bot(...) へ渡すメモリ方針込みのキーワード引数。"""
    return {
        "intents": build_intents(),
        "chunk_guilds_at_startup": False,
        "max_messages": MAX_MESSAGES,
    }


async def list_all_members(guild: Any) -> list:
    """ギルドのメンバー全件を返す。

    キャッシュが全員分そろっていればそれを使い、足りなければ
    ``fetch_members`` でその場だけ取得する（キャッシュには残らない）。
    取得できない環境（テスト用の疑似ギルド等）や取得失敗時は
    キャッシュ分だけを返す（従来の縮退動作）。
    """
    cached = list(getattr(guild, "members", None) or [])
    member_count = getattr(guild, "member_count", None)
    if isinstance(member_count, int) and len(cached) >= member_count:
        return cached
    fetch = getattr(guild, "fetch_members", None)
    if fetch is None:
        return cached
    try:
        return [member async for member in fetch(limit=None)]
    except Exception:
        logger.debug("メンバー全件取得に失敗したためキャッシュ分で続行します", exc_info=True)
        return cached


async def get_or_fetch_member(guild: Any, user_id: int):
    """キャッシュ → REST の順でメンバーを引く。いなければ None。

    キャッシュに無いだけのメンバーを「サーバーにいない」と誤判定
    しないための取得（ミュート解除・警告エスカレーション等）。
    """
    if guild is None:
        return None
    get_member = getattr(guild, "get_member", None)
    member = get_member(user_id) if callable(get_member) else None
    if member is not None:
        return member
    fetch_member = getattr(guild, "fetch_member", None)
    if not callable(fetch_member):
        return None
    try:
        return await fetch_member(user_id)
    except Exception:
        return None
