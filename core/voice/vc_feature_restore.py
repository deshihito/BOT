# -*- coding: utf-8 -*-
"""VC 各機能（録音・カラオケ・文字起こし・ボイスチェンジャー）の再開用スナップショット。

音楽（core/voice/music/restore.py）は再生状態そのものを復元するが、こちらの4機能は
セッション途中のデータ（録音バッファ、歌唱履歴、発話バッファ、変換バッファ）が
プロセスと一緒に失われるため、復元できるのは「開始に必要な設定」だけである。
各 cog は開始時（と設定変更時）にここへ再開用エントリを保存し、停止時の
cleanup で消す。再起動後は各 cog の ``restore_after_restart()`` がエントリを
読み、人が VC に残っている場合に限り、同じ設定で新規セッションとして再開する。

保存先は core/voice/voice_restore.py の ``vc_features`` セクション
（キー ``"<guild_id>:<feature>"``、feature は core/voice/voice_session.py の機能名）。
音楽スナップショットと同じく、永続化の失敗で機能自体を止めることはしない
（全て握ってログだけ残す）。
"""
from __future__ import annotations

import logging
import time
import types
from typing import Any

try:
    from core.voice import voice_restore
except Exception:  # pragma: no cover - import 失敗時も各機能自体は止めない
    voice_restore = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

SECTION = "vc_features"


def _key(guild_id: int, feature: str) -> str:
    return f"{int(guild_id)}:{feature}"


def save_feature(feature: str, guild_id: int, entry: dict[str, Any]) -> None:
    """再開用エントリを保存する。``entry`` は共通項目＋ ``settings`` を含む dict。"""
    if voice_restore is None:
        return
    try:
        store = voice_restore.get_store()
        payload = dict(entry)
        payload["feature"] = feature
        payload["saved_at"] = time.time()
        store.set_entry(SECTION, _key(guild_id, feature), payload)
        store.maybe_flush()
    except Exception:
        logger.debug("guild %s: %s の再開用スナップショットの保存に失敗しました",
                     guild_id, feature, exc_info=True)


def update_settings(feature: str, guild_id: int, settings: dict[str, Any]) -> None:
    """既存エントリの ``settings`` だけを差し替える（動作中の設定変更用）。"""
    if voice_restore is None:
        return
    try:
        store = voice_restore.get_store()
        entry = store.get_entry(SECTION, _key(guild_id, feature))
        if entry is None:
            return
        entry["settings"] = dict(settings)
        entry["saved_at"] = time.time()
        store.set_entry(SECTION, _key(guild_id, feature), entry)
        store.maybe_flush()
    except Exception:
        logger.debug("guild %s: %s の設定スナップショットの更新に失敗しました",
                     guild_id, feature, exc_info=True)


def clear_feature(feature: str, guild_id: int) -> None:
    """再開用エントリを消す（停止時・復旧できなかったときの掃除）。"""
    if voice_restore is None:
        return
    try:
        store = voice_restore.get_store()
        store.set_entry(SECTION, _key(guild_id, feature), None)
        store.maybe_flush()
    except Exception:
        logger.debug("guild %s: %s の再開用スナップショットの削除に失敗しました",
                     guild_id, feature, exc_info=True)


def feature_entries(feature: str) -> dict[int, dict[str, Any]]:
    """指定機能の保存済みエントリを ``{guild_id: entry}`` で返す（壊れたキーは読み飛ばす）。"""
    if voice_restore is None:
        return {}
    try:
        section = voice_restore.get_store().section(SECTION)
    except Exception:
        logger.debug("%s の再開用スナップショットの読み込みに失敗しました", feature, exc_info=True)
        return {}
    suffix = f":{feature}"
    entries: dict[int, dict[str, Any]] = {}
    for key, value in section.items():
        if not isinstance(value, dict) or not str(key).endswith(suffix):
            continue
        try:
            guild_id = int(str(key)[: -len(suffix)])
        except (TypeError, ValueError):
            continue
        entries[guild_id] = value
    return entries


def flush_store() -> None:
    if voice_restore is None:
        return
    try:
        voice_restore.get_store().flush()
    except Exception:
        logger.debug("再開用スナップショットの保存に失敗しました", exc_info=True)


def has_humans(channel) -> bool:
    """音楽復旧と同じ条件: VC に Bot 以外の人が1人でもいるか。"""
    members = getattr(channel, "members", None) or []
    return any(not getattr(m, "bot", False) for m in members)


def resolve_user(guild, snapshot: dict[str, Any]):
    """開始者を guild から引き直す。見つからなければスナップショットの名前で代替する（音楽復旧と同じ）。"""
    user_id = snapshot.get("user_id")
    if user_id:
        get_member = getattr(guild, "get_member", None)
        user = get_member(user_id) if callable(get_member) else None
        if user is not None:
            return user
    name = snapshot.get("user_name") or "だれか"
    return types.SimpleNamespace(id=user_id or 0, name=name, display_name=name)


def build_entry(*, voice_channel_id, text_channel_id, user, settings: dict[str, Any]) -> dict[str, Any]:
    """各 cog が開始時に保存する共通形式のエントリを作る。"""
    return {
        "voice_channel_id": voice_channel_id,
        "text_channel_id": text_channel_id,
        "user_id": getattr(user, "id", None),
        "user_name": getattr(user, "display_name", None) or getattr(user, "name", None),
        "settings": dict(settings),
    }
