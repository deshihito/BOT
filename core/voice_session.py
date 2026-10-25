"""ボイスチャンネル接続の持ち主を1か所で管理する。

Bot はサーバーごとに 1 つしか VC に入れない。以前は録音・やまびこ・文字起こし・カラオケ・
ボイスチェンジャー・!saito・!gvc join がそれぞれ「接続中なら強制切断して入り直す」実装だったため、
別の機能を使っている人を黙って追い出していた（バグ10）。

音楽・GVC・読み上げ・文字起こしは、1つの VoiceClient を共有する複数リースとして記録する。
PCM再生と受信Sinkは ``core.voice_media`` が合成・多重化し、各機能の停止は自分のリースだけを解放する。
それ以外の機能は従来どおり排他的に接続を所有する。

- ``acquire()``: 同じVCチャンネルの共有対象機能は同じ接続に追加する。非対応機能は ``VoiceBusy``。
  ``force=True`` のときだけ、開始した本人・管理者（または全開始者が VC にいない場合）が排他機能へ切り替えられる。
- ``release()``: 指定機能のcleanupだけ実行し、最後のリースが解放されたときに接続を切断する。
- ``on_voice_state_update``（Bot に 1 つだけ登録）:
  - VC に人がいない状態が ``AUTO_LEAVE_SECONDS`` 続いたら、どの機能でも終了して退出する。
  - Bot が外部から切断された（キック・チャンネル削除など）ときも後片付けを呼ぶ。
    これでグローバルVC や録音の状態が「接続していないのに使用中」のまま残らない。

各 cog は ``get_manager(bot)`` で共有のインスタンスを取得する。
cleanup の中から同じサーバーの ``release()`` を await しないこと（ロックが再入できないため）。
別サーバーを止めたいとき（/voice community の相手側など）は ``asyncio.create_task`` で呼ぶ。
"""
from __future__ import annotations

import asyncio
import dataclasses
import inspect
import logging
import time
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

AUTO_LEAVE_SECONDS = 180  # 誰もいない状態がこれだけ続いたら退出する（3分）
DISCONNECT_GRACE_SECONDS = 5.0  # 外部切断を検知してから、自動再接続を待つ時間
RECONNECT_DELAY_SECONDS = 1.0  # 切断してから入り直すまでの待ち時間（ハンドシェイクのリセット待ち）

# 機能名 → (表示名, voiceパネルの終了案内)。
FEATURES: dict[str, tuple[str, str]] = {
    "music": ("音楽再生", "/music の操作パネルから停止"),
    "record": ("録音", "/voice のパネルから録音停止"),
    "echo": ("やまびこ", "/voice のパネルからやまびこ停止"),
    "transcribe": ("文字起こし", "/voice のパネルから文字起こし停止"),
    "tts": ("読み上げ", "/vc のパネルから読み上げ停止"),
    "karaoke": ("カラオケ", "/voice のパネルからカラオケ停止"),
    "changer": ("ボイスチェンジャー", "/voice のパネルからボイスチェンジャー停止"),
    "match": ("ランダム通話", "/voice のパネルからランダム通話退出"),
    "global": ("グローバルVC", "/voice のパネルからグローバルVC退出"),
}
# These features share a single voice client and the PCM/sink multiplexers in voice_media.
SHARED_FEATURES = frozenset({"music", "global", "transcribe", "tts"})

# release() の理由ごとに、使っていたチャンネルへ送るお知らせ。None は送らない（コマンド側で返信する）。
DEFAULT_NOTICES: dict[str, Optional[str]] = {
    "stop": None,
    "time_limit": None,
    "idle": "ボイスチャンネルに誰もいない状態が{minutes}分続いたため、{label}を終了して退出しました。",
    "disconnected": "ボイスチャンネルから切断されたため、{label}を終了しました。",
    "takeover": "{by} さんが{by_label}を始めたため、{label}を終了しました。",
    "leave": "{by} さんが `/voice` で退出操作を実行したため、{label}を終了しました。",
}

Cleanup = Callable[[str], Any]


def feature_label(feature: str) -> str:
    return FEATURES.get(feature, (feature, ""))[0]


def stop_hint(feature: str) -> str:
    return FEATURES.get(feature, ("", "/voice のパネルからVC退出"))[1]


def _display_name(user) -> str:
    return str(getattr(user, "display_name", None) or getattr(user, "name", None) or "だれか")


def _is_admin(member) -> bool:
    perms = getattr(member, "guild_permissions", None)
    if perms is None:
        return False
    return bool(getattr(perms, "administrator", False) or getattr(perms, "manage_guild", False)
                or getattr(perms, "move_members", False))


def _has_humans(channel) -> bool:
    members = getattr(channel, "members", None) or []
    return any(not getattr(m, "bot", False) for m in members)


@dataclasses.dataclass(eq=False)
class VoiceLease:
    feature: str
    user_id: int
    user_name: str
    started_at: float
    cleanup: Optional[Cleanup] = None
    text_channel: Any = None


@dataclasses.dataclass(eq=False)
class VoiceSession:
    guild: Any
    feature: str
    user_id: int
    user_name: str
    channel_id: Optional[int]
    started_at: float
    cleanup: Optional[Cleanup] = None
    text_channel: Any = None
    vc: Any = None
    idle_task: Optional[asyncio.Task] = None
    shared_leases: dict[str, VoiceLease] = dataclasses.field(default_factory=dict)

    @property
    def guild_id(self) -> int:
        return self.guild.id

    @property
    def label(self) -> str:
        return feature_label(self.feature)


class VoiceBusy(Exception):
    """別の機能が VC を使用中なので接続しなかった。``str(error)`` はそのまま利用者に見せられる文。"""

    def __init__(self, session: VoiceSession, message: str):
        super().__init__(message)
        self.session = session


class VoiceSessionManager:
    def __init__(self, bot, *, auto_leave_seconds: float = AUTO_LEAVE_SECONDS,
                 disconnect_grace: float = DISCONNECT_GRACE_SECONDS,
                 reconnect_delay: float = RECONNECT_DELAY_SECONDS):
        self.bot = bot
        self.auto_leave_seconds = auto_leave_seconds
        self.disconnect_grace = disconnect_grace
        self.reconnect_delay = reconnect_delay
        self._sessions: dict[int, VoiceSession] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------ 参照
    def get(self, guild_id: int) -> Optional[VoiceSession]:
        return self._sessions.get(guild_id)

    def owner(self, guild_id: int) -> Optional[str]:
        session = self._sessions.get(guild_id)
        return session.feature if session else None

    def _lock(self, guild_id: int) -> asyncio.Lock:
        lock = self._locks.get(guild_id)
        if lock is None:
            lock = self._locks[guild_id] = asyncio.Lock()
        return lock

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _current_channel(self, session: VoiceSession):
        vc = getattr(session.guild, "voice_client", None)
        channel = getattr(vc, "channel", None) if vc is not None else None
        if channel is None and session.channel_id is not None:
            getter = getattr(session.guild, "get_channel", None)
            channel = getter(session.channel_id) if getter else None
        return channel

    def _starter_present(self, session: VoiceSession) -> bool:
        channel = self._current_channel(session)
        members = getattr(channel, "members", None) or []
        return any(getattr(m, "id", None) == session.user_id for m in members)

    def can_override(self, session: VoiceSession, member) -> bool:
        """別機能への切り替え（force）や停止をしてよい人か。

        開始した本人・管理者（サーバー管理 / メンバーを移動）、または開始した人がもう VC にいない場合。
        """
        if member is None:
            return False
        active_ids = {session.user_id, *(lease.user_id for lease in session.shared_leases.values())}
        if getattr(member, "id", None) in active_ids or _is_admin(member):
            return True
        channel = self._current_channel(session)
        members = getattr(channel, "members", None) or []
        return not any(getattr(m, "id", None) in active_ids for m in members)

    def can_leave(self, session: VoiceSession, member) -> bool:
        """`/voice` の退出操作で止めてよいか。音楽は今までどおり誰でも止められる。"""
        return session.feature == "music" or self.can_override(session, member)

    def busy_message(self, session: VoiceSession) -> str:
        labels = [session.label, *(feature_label(name) for name in session.shared_leases)]
        return (
            f"⚠️ いまこのサーバーのボイスチャンネルは **{'、'.join(labels)}**（{session.user_name} さんが開始）で使用中です。\n"
            f"先に `{stop_hint(session.feature)}` で終了するか、`/voice` のパネルから退出させてから実行してください。\n"
            "（開始した人・管理者が実行した場合や、開始した人が VC にいない場合はそのまま切り替わります）"
        )

    # ------------------------------------------------------------ 取得・解放
    async def acquire(self, guild, channel, feature: str, user, *, cleanup: Optional[Cleanup] = None,
                      text_channel=None, force: bool = False, cls=None, timeout: float = 30.0,
                      self_deaf: bool = False, reconnect: bool = True):
        """``feature`` として VC に接続し、VoiceClient を返す。

        - 同じ機能がすでに持ち主なら、そのまま（必要ならチャンネルを移動して）返す。
        - 別の機能が持ち主なら ``VoiceBusy``。ただし ``force`` で、``can_override`` を満たす人なら
          前の持ち主を ``release(reason="takeover")`` してから接続する。
        - 接続の失敗（タイムアウトなど）はそのまま例外として呼び出し元へ返す。
        """
        async with self._lock(guild.id):
            existing = self._sessions.get(guild.id)
            vc = getattr(guild, "voice_client", None)
            connected = bool(vc is not None and vc.is_connected())

            if existing is not None and existing.feature == feature:
                if connected:
                    if getattr(vc, "channel", None) != channel and existing.shared_leases:
                        raise VoiceBusy(existing, self.busy_message(existing))
                    if getattr(vc, "channel", None) != channel:
                        await vc.move_to(channel)
                    existing.channel_id = getattr(channel, "id", None)
                    if cleanup is not None:
                        existing.cleanup = cleanup
                    if text_channel is not None:
                        existing.text_channel = text_channel
                    self._evaluate_idle(existing)
                    return vc
                # 記録だけ残って接続が切れていた -> 片付けてから入り直す
                await self._release_locked(existing, reason="disconnected", disconnect=False)
                existing = None

            if existing is not None and feature in SHARED_FEATURES and existing.feature in SHARED_FEATURES:
                if connected and getattr(vc, "channel", None) == channel:
                    lease = existing.shared_leases.get(feature)
                    if lease is None:
                        existing.shared_leases[feature] = VoiceLease(
                            feature=feature, user_id=getattr(user, "id", 0), user_name=_display_name(user),
                            started_at=time.time(), cleanup=cleanup, text_channel=text_channel,
                        )
                    else:
                        if cleanup is not None:
                            lease.cleanup = cleanup
                        if text_channel is not None:
                            lease.text_channel = text_channel
                    self._evaluate_idle(existing)
                    return vc
                raise VoiceBusy(
                    existing,
                    self.busy_message(existing) + "\n共有対象の機能は同じボイスチャンネルでのみ併用できます。先に稼働中の機能を停止してください。",
                )

            disconnected = False
            if existing is not None:
                if not (force and self.can_override(existing, user)):
                    raise VoiceBusy(existing, self.busy_message(existing))
                await self._release_locked(existing, reason="takeover", by=user, by_feature=feature)
                disconnected = True
                vc = getattr(guild, "voice_client", None)
                connected = bool(vc is not None and vc.is_connected())

            if vc is not None:
                # 持ち主のいない接続（古い状態など）。だれも使っていないので切ってから入り直す。
                logger.warning("guild %s: 持ち主のいない VC 接続を切断します", guild.id)
                try:
                    await vc.disconnect(force=True)
                except Exception:
                    logger.debug("stale disconnect failed", exc_info=True)
                disconnected = True
            if disconnected and self.reconnect_delay:
                await asyncio.sleep(self.reconnect_delay)

            if cls is None:
                from discord.ext import voice_recv
                cls = voice_recv.VoiceRecvClient
            vc = await channel.connect(cls=cls, timeout=timeout, reconnect=reconnect, self_deaf=self_deaf)

            session = VoiceSession(
                guild=guild, feature=feature, user_id=getattr(user, "id", 0), user_name=_display_name(user),
                channel_id=getattr(channel, "id", None), started_at=time.time(), cleanup=cleanup,
                text_channel=text_channel, vc=vc,
            )
            self._sessions[guild.id] = session
            self._evaluate_idle(session)
            return vc

    async def release(self, guild, feature: Optional[str] = None, *, reason: str = "stop", by=None,
                      notice: Optional[str] = None, disconnect: bool = True) -> bool:
        """持ち主の cleanup を呼んでから切断する。``feature`` を指定したときは、その機能が持ち主の場合だけ。"""
        guild_id = guild if isinstance(guild, int) else guild.id
        async with self._lock(guild_id):
            session = self._sessions.get(guild_id)
            if session is None:
                return False
            if feature is not None and feature != session.feature:
                lease = session.shared_leases.pop(feature, None)
                if lease is None:
                    return False
                await self._run_cleanup(session, feature, lease.cleanup, reason)
                return True
            if feature is not None and session.shared_leases:
                await self._run_cleanup(session, session.feature, session.cleanup, reason)
                promoted_feature, promoted = session.shared_leases.popitem()
                session.feature = promoted_feature
                session.user_id = promoted.user_id
                session.user_name = promoted.user_name
                session.started_at = promoted.started_at
                session.cleanup = promoted.cleanup
                session.text_channel = promoted.text_channel
                return True
            await self._release_locked(session, reason=reason, by=by, notice=notice, disconnect=disconnect)
            return True

    async def _run_cleanup(self, session: VoiceSession, feature: str, cleanup, reason: str) -> None:
        if cleanup is None:
            return
        try:
            result = cleanup(reason)
            if inspect.isawaitable(result):
                await result
        except Exception:
            logger.exception("guild %s: %s の後片付けに失敗しました", session.guild_id, feature)

    async def _release_locked(self, session: VoiceSession, *, reason: str, by=None, by_feature: Optional[str] = None,
                              notice: Optional[str] = None, disconnect: bool = True) -> None:
        if self._sessions.get(session.guild_id) is session:
            del self._sessions[session.guild_id]
        task, session.idle_task = session.idle_task, None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

        await self._run_cleanup(session, session.feature, session.cleanup, reason)
        for feature, lease in list(session.shared_leases.items()):
            await self._run_cleanup(session, feature, lease.cleanup, reason)
        session.shared_leases.clear()

        if disconnect:
            vc = getattr(session.guild, "voice_client", None) or session.vc
            if vc is not None:
                try:
                    await vc.disconnect(force=True)
                except Exception:
                    logger.debug("disconnect failed", exc_info=True)

        template = notice if notice is not None else DEFAULT_NOTICES.get(reason)
        if template and session.text_channel is not None:
            text = template.format(
                label=session.label, minutes=max(1, int(self.auto_leave_seconds // 60)),
                by=_display_name(by) if by is not None else "だれか",
                by_label=feature_label(by_feature) if by_feature else "別の機能",
            )
            try:
                await session.text_channel.send(text)
            except Exception:
                logger.debug("notice send failed", exc_info=True)

    # ------------------------------------------------------------ 自動退出・外部切断
    def _evaluate_idle(self, session: VoiceSession) -> None:
        channel = self._current_channel(session)
        if channel is None or _has_humans(channel):
            if session.idle_task is not None and not session.idle_task.done():
                session.idle_task.cancel()
            session.idle_task = None
            return
        if session.idle_task is None or session.idle_task.done():
            session.idle_task = self._spawn(self._idle_timer(session))

    async def _idle_timer(self, session: VoiceSession) -> None:
        try:
            await asyncio.sleep(self.auto_leave_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock(session.guild_id):
            if self._sessions.get(session.guild_id) is not session:
                return
            session.idle_task = None
            channel = self._current_channel(session)
            if channel is not None and _has_humans(channel):
                return
            await self._release_locked(session, reason="idle")

    async def _check_external_disconnect(self, session: VoiceSession) -> None:
        if self.disconnect_grace:
            await asyncio.sleep(self.disconnect_grace)
        async with self._lock(session.guild_id):
            if self._sessions.get(session.guild_id) is not session:
                return  # すでに解放済み、または別の機能が入り直した
            vc = getattr(session.guild, "voice_client", None)
            if vc is not None and vc.is_connected():
                return  # 自動再接続できた
            await self._release_locked(session, reason="disconnected")

    async def on_voice_state_update(self, member, before, after) -> None:
        guild = getattr(member, "guild", None)
        if guild is None:
            return
        session = self._sessions.get(guild.id)
        if session is None:
            return
        me = getattr(self.bot, "user", None)
        if me is not None and getattr(member, "id", None) == getattr(me, "id", None):
            if getattr(after, "channel", None) is None:
                self._spawn(self._check_external_disconnect(session))
            else:
                session.channel_id = after.channel.id
                self._evaluate_idle(session)
            return
        if getattr(member, "bot", False):
            return
        watched = {getattr(before, "channel", None), getattr(after, "channel", None)}
        if any(getattr(c, "id", None) == session.channel_id for c in watched if c is not None):
            self._evaluate_idle(session)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()


def get_manager(bot) -> VoiceSessionManager:
    """Bot に 1 つだけの VoiceSessionManager を返す（なければ作って on_voice_state_update を登録する）。"""
    manager = getattr(bot, "voice_sessions", None)
    if isinstance(manager, VoiceSessionManager):
        return manager
    manager = VoiceSessionManager(bot)
    bot.voice_sessions = manager
    add_listener = getattr(bot, "add_listener", None)
    if callable(add_listener):
        try:
            add_listener(manager.on_voice_state_update, "on_voice_state_update")
        except Exception:
            logger.exception("on_voice_state_update の登録に失敗しました")
    return manager
