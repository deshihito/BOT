# -*- coding: utf-8 -*-
"""VC参加時の自動開始（/support「自動化・通知」>「VC参加時の自動開始」）。

ボットが VC へ新規に参加したとき、ギルド設定で ON になっている共有機能を
自動で開始する。対象は接続を共有できる4機能（SHARED_FEATURES）だけ:

- 読み上げ (tts)
- 文字起こし (transcribe)
- ミュージックパネル (music_panel) — 音楽セッションに操作パネルを出す
- グローバルVC (global) — ルーム名の事前設定が必須

録音・カラオケ・やまびこ・ボイスチェンジャー等の排他機能は、共有接続と
競合して参加自体を壊しかねないため自動開始の対象にしない。

発動は VoiceSessionManager.acquire が新規セッションを作ったときだけ
（fresh_session_hook 経由）。再起動復旧（main.py の _restore_voice_sessions）
の間は restore_suppression() で抑止し、復旧の既存仕様を優先する。
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
import time
from typing import Any, Optional

from core.legacy import Responder

logger = logging.getLogger(__name__)

VC_AUTO_START_SECTION = "vc_auto_start"

# (設定キー, 表示名, セッション機能名)。開始順はこの並び。
AUTO_START_FEATURES: tuple[tuple[str, str, str], ...] = (
    ("tts", "読み上げ", "tts"),
    ("transcribe", "文字起こし", "transcribe"),
    ("music_panel", "ミュージックパネル", "music"),
    ("global", "グローバルVC", "global"),
)
FEATURE_LABELS = {key: label for key, label, _ in AUTO_START_FEATURES}
SESSION_FEATURE_OF = {key: session_feature for key, _, session_feature in AUTO_START_FEATURES}

# 再起動復旧の最中は True。復旧経路の acquire では自動開始しない。
_RESTORING: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "vc_auto_start_restoring", default=False
)


@contextlib.contextmanager
def restore_suppression():
    """この範囲で作られた VC セッションでは自動開始を発動しない。"""
    token = _RESTORING.set(True)
    try:
        yield
    finally:
        _RESTORING.reset(token)


def is_restoring() -> bool:
    return _RESTORING.get()


# 自前でパネルを出した直後の二重投稿を防ぐ控え（guild_id -> (key, 時刻)）。
_SELF_STARTED: dict[int, tuple[str, float]] = {}
_SELF_STARTED_TTL = 60.0


def note_self_started(guild_id: int, key: str) -> None:
    """その機能を開始した側が自分で表示まで済ませたことを記録する。"""
    _SELF_STARTED[guild_id] = (key, time.monotonic())


def _consume_self_started(guild_id: int, key: str) -> bool:
    entry = _SELF_STARTED.get(guild_id)
    if entry is None:
        return False
    noted_key, noted_at = entry
    if noted_key != key or (time.monotonic() - noted_at) > _SELF_STARTED_TTL:
        return False
    _SELF_STARTED.pop(guild_id, None)
    return True


# ---------------------------------------------------------------- 設定
def get_vc_auto_start_settings(store, guild_id: int) -> dict[str, Any]:
    """自動開始設定。未設定は全て OFF（従来どおり何も自動開始しない）。"""
    raw = store.get(guild_id, VC_AUTO_START_SECTION)
    if not isinstance(raw, dict):
        raw = {}
    settings: dict[str, Any] = {}
    for key, _label, _session_feature in AUTO_START_FEATURES:
        settings[key] = raw.get(key) if isinstance(raw.get(key), bool) else False
    room = raw.get("global_room")
    settings["global_room"] = room.strip() if isinstance(room, str) and room.strip() else None
    password = raw.get("global_password")
    settings["global_password"] = password if isinstance(password, str) and password else None
    return settings


def plan_auto_start(settings: dict, active_session_features: set[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """開始すべき機能と、設定は ON でも開始できない機能（理由つき）を返す。

    既に有効な機能は冪等にスキップする（開始リストにも理由にも入れない）。
    """
    start: list[str] = []
    skipped: list[tuple[str, str]] = []
    for key, _label, session_feature in AUTO_START_FEATURES:
        if not settings.get(key):
            continue
        # ミュージックパネルは音楽セッション上の UI なので、音楽が持ち主でも
        # 「開始済み」とは限らない（二重投稿は note_self_started 側で防ぐ）。
        if key != "music_panel" and session_feature in active_session_features:
            continue
        if key == "global" and not settings.get("global_room"):
            skipped.append((key, "ルーム名が未設定"))
            continue
        start.append(key)
    return start, skipped


# ---------------------------------------------------------------- 実行用アダプタ
def _flatten_send(content: Any = None, *, embed=None, **_kwargs) -> str:
    if content:
        return str(content)
    if embed is not None:
        parts = [getattr(embed, "title", None), getattr(embed, "description", None)]
        return "\n".join(str(p) for p in parts if p)
    return ""


class _CaptureContext:
    """Responder の受け口（対話ではない）。送信は全て控えに残すだけ。

    各機能の開始処理は通常どおり Responder 経由で呼ぶが、成否の通知は
    自動開始側で1メッセージにまとめるため、個別の送信はここで吸収する。
    """

    def __init__(self, guild, channel, user):
        self.guild = guild
        self.channel = channel
        self.author = user
        self.sent: list[str] = []

    async def send(self, content: Any = None, **kwargs):
        text = _flatten_send(content, embed=kwargs.get("embed"))
        if text:
            self.sent.append(text)
        return None


class _PostingContext(_CaptureContext):
    """ミュージックパネル用: パネル本体は実際に投稿する必要がある。"""

    async def send(self, content: Any = None, **kwargs):
        kwargs.pop("ephemeral", None)
        message = await self.channel.send(content, **kwargs)
        return message


# ---------------------------------------------------------------- 開始処理
async def _start_tts(bot, ctx: _CaptureContext) -> bool:
    cog = bot.get_cog("TTSCog")
    if cog is None:
        raise RuntimeError("読み上げ機能が読み込まれていません")
    await cog._start_impl(Responder(ctx), None)
    return ctx.guild.id in getattr(cog, "read_channels", {})


async def _start_transcribe(bot, ctx: _CaptureContext) -> bool:
    cog = bot.get_cog("TranscriptionCog")
    if cog is None:
        # 文字起こしは遅延ロード対象（hub の _cog と同じ経路で起こす）
        hub = bot.get_cog("VoiceHub")
        if hub is not None:
            cog = await hub._try_load_cog("transcribe")
    if cog is None:
        raise RuntimeError("文字起こし機能が読み込まれていません")
    await cog._transcribe_impl(Responder(ctx), "start", None)
    return ctx.guild.id in getattr(cog, "sessions", {})


async def _start_music_panel(bot, ctx: _PostingContext) -> bool:
    cog = bot.get_cog("VoiceCog")
    if cog is None:
        raise RuntimeError("音楽機能が読み込まれていません")
    await cog._panel_impl(Responder(ctx))
    state = cog.get_state(ctx.guild.id) if hasattr(cog, "get_state") else {}
    return bool(state.get("panel_message"))


async def _start_global(bot, ctx: _CaptureContext, settings: dict) -> bool:
    cog = bot.get_cog("GlobalVCCog")
    if cog is None:
        raise RuntimeError("グローバルVC機能が読み込まれていません")
    await cog._global_impl(
        Responder(ctx), "join", settings.get("global_room"), settings.get("global_password")
    )
    manager = getattr(bot, "voice_sessions", None)
    session = manager.get(ctx.guild.id) if manager is not None else None
    if session is None:
        return False
    return session.feature == "global" or "global" in session.shared_leases


_STARTERS = {
    "tts": _start_tts,
    "transcribe": _start_transcribe,
    "music_panel": _start_music_panel,
}


async def _run_one(bot, key: str, guild, text_channel, user, settings: dict) -> tuple[bool, Optional[str]]:
    """1機能の自動開始。例外は握って (False, 理由) を返す。"""
    if _consume_self_started(guild.id, key):
        return True, None  # 開始した側が表示まで済ませている
    try:
        if key == "music_panel":
            ok = await _start_music_panel(bot, _PostingContext(guild, text_channel, user))
        elif key == "global":
            ok = await _start_global(bot, _CaptureContext(guild, text_channel, user), settings)
        else:
            ctx = _CaptureContext(guild, text_channel, user)
            ok = await _STARTERS[key](bot, ctx)
            if not ok:
                reason = ctx.sent[-1].strip().splitlines()[0] if ctx.sent else "開始できませんでした"
                return False, reason[:120]
        return (True, None) if ok else (False, "開始できませんでした")
    except Exception as exc:  # 1機能の失敗で参加や他機能を巻き込まない
        logger.exception("VC自動開始に失敗しました (guild=%s feature=%s)", guild.id, key)
        return False, str(exc)[:120] or exc.__class__.__name__


async def on_fresh_session(bot, session, user, text_channel) -> None:
    """新規 VC セッションが作られたときの自動開始本体（manager のフック）。

    例外は一切外へ出さない（参加フローを落とさないため）。
    """
    try:
        if is_restoring():
            return
        from core.vc.voice_session import SHARED_FEATURES

        if session.feature not in SHARED_FEATURES:
            return  # 排他機能のセッションでは共有機能を開始できない
        if text_channel is None or user is None:
            return
        guild = session.guild
        channel = guild.get_channel(session.channel_id) if session.channel_id else None
        members = getattr(channel, "members", None) or []
        if not any(not getattr(m, "bot", False) for m in members):
            return  # VC に人がいない

        from core import guild_settings

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_auto_start_settings(store, guild.id)
        if not any(settings.get(key) for key, _, _ in AUTO_START_FEATURES):
            return

        active = {session.feature, *session.shared_leases.keys()}
        start_keys, skipped = plan_auto_start(settings, active)

        results: list[tuple[str, bool, Optional[str]]] = []
        for key, reason in skipped:
            results.append((key, False, reason))
        for key in start_keys:
            ok, reason = await _run_one(bot, key, guild, text_channel, user, settings)
            results.append((key, ok, reason))
        if not results:
            return

        started = [FEATURE_LABELS[key] for key, ok, _ in results if ok]
        failed = [f"{FEATURE_LABELS[key]}（{reason}）" for key, ok, reason in results if not ok]
        lines = []
        if started:
            lines.append(f"自動開始: {'、'.join(started)}")
        if failed:
            lines.append(f"開始できませんでした: {'、'.join(failed)}")
        if lines:
            await text_channel.send("\n".join(lines))
    except Exception:
        logger.exception("VC自動開始の処理に失敗しました (guild=%s)", getattr(session, "guild_id", "?"))


async def run_auto_start_now(bot, session, user, text_channel):
    """テスト・将来の手動再実行用に、フック本体をそのまま呼ぶ。"""
    await on_fresh_session(bot, session, user, text_channel)


__all__ = [
    "VC_AUTO_START_SECTION",
    "AUTO_START_FEATURES",
    "FEATURE_LABELS",
    "get_vc_auto_start_settings",
    "plan_auto_start",
    "restore_suppression",
    "is_restoring",
    "note_self_started",
    "on_fresh_session",
    "run_auto_start_now",
]
