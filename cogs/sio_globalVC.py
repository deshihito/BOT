from __future__ import annotations

import array
import asyncio
import dataclasses
import io
import logging
import re
import sys
import threading
import time
from typing import Optional

import discord
import discord.opus
from discord.ext import commands, tasks
from discord.ext import voice_recv

from core.legacy import Responder
from core.voice_session import VoiceBusy, get_manager
from core.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink

try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

DISCORD_SAMPLE_RATE = 48000
CHANNELS = 2
SAMPLE_WIDTH = 2
FRAME_SIZE = CHANNELS * SAMPLE_WIDTH
FRAME_DURATION = 0.02  # 20ms
FRAME_BYTE_SIZE = int(DISCORD_SAMPLE_RATE * FRAME_DURATION * FRAME_SIZE)  # 3840 bytes
MAX_BUFFER_FRAMES = 50  # 話者ごとの再生バッファの上限 (20ms * 50 = 約1秒分)
JITTER_PREFILL_FRAMES = 3  # 話し始めにこの分(60ms)溜めてから流し、到着の揺れを吸収する
TAIL_FLUSH_SECONDS = 0.08  # 溜まりきらない端数も、新しい音声がこれだけ来なければ流しきる
TRACK_IDLE_SECONDS = 2.0   # 無音が続いた話者のバッファを破棄するまでの時間
PLAYBACK_WATCHDOG_SECONDS = 2.0  # 再生が止まっていないか見回る間隔
STALE_VC_GRACE_SECONDS = 15.0    # 切断されたままの接続をルーム一覧から外すまでの猶予 (再接続中は消さない)


# ============================================================
# ルーム定義 / 接続管理
# ============================================================
@dataclasses.dataclass
class RoomConfig:
    """`gvc create` で定義されるルームの設定。接続の有無に関わらず存在する。"""
    name: str
    owner_id: int
    owner_guild_id: int
    max_servers: int = 0          # 0 = 無制限
    private: bool = False
    password: str = ""
    description: str = ""
    created_at: float = dataclasses.field(default_factory=time.time)


# ルーム定義: { "room_name": RoomConfig }  ※ gvc create で作成され、gvc delete まで残り続ける
ROOMS: dict[str, RoomConfig] = {}
# ルームごとの実際に接続中の VoiceRecvClient 一覧: { "room_name": [vc, ...] }
GLOBAL_ROOMS: dict[str, list[voice_recv.VoiceRecvClient]] = {}


def _remove_vc_from_rooms(vc: voice_recv.VoiceRecvClient) -> Optional[str]:
    """全ルームの接続中リストから vc を取り除く。所属していたルーム名を返す。"""
    for room_name, clients in list(GLOBAL_ROOMS.items()):
        if vc in clients:
            clients.remove(vc)
            if not clients:
                del GLOBAL_ROOMS[room_name]
            return room_name
    return None


def _prune_dead_clients(room_name: Optional[str] = None) -> None:
    """切断されたまま戻ってこない接続を GLOBAL_ROOMS から外す。

    外部切断・キック・ネットワーク断などで一覧にだけ残ると、「すでに参加しています」や満員扱いが
    永久に解けず、他サーバーの音声も存在しない接続へ送り続けてしまう。再接続中の一時的な切断は猶予で吸収する。
    """
    now = time.monotonic()
    names = [room_name] if room_name else list(GLOBAL_ROOMS)
    for name in names:
        for vc in list(GLOBAL_ROOMS.get(name, ())):
            try:
                connected = vc.is_connected()
            except Exception:
                connected = False
            if connected:
                vc._gvc_down_since = None
                continue
            since = getattr(vc, "_gvc_down_since", None)
            if since is None:
                vc._gvc_down_since = now
            elif now - since >= STALE_VC_GRACE_SECONDS:
                logger.info("グローバルVC: 切断されたままの接続を一覧から外します (room=%s)", name)
                _remove_vc_from_rooms(vc)
                try:
                    vc.stop_listening()
                except Exception:
                    logger.debug("stop_listening 失敗 (無視)", exc_info=True)


async def _disconnect_and_cleanup(vc: voice_recv.VoiceRecvClient) -> None:
    """listen/play を止めて切断し、ルーム管理からも除去する。"""
    _remove_vc_from_rooms(vc)
    try:
        vc.stop_listening()
    except Exception:
        logger.debug("stop_listening 失敗 (無視)", exc_info=True)
    try:
        await vc.disconnect(force=True)
    except Exception:
        logger.debug("disconnect 失敗 (無視)", exc_info=True)


_WEBHOOK_BANNED_WORDS = (("discord", "i", "і"), ("clyde", "y", "у"))  # Webhook名に使えない語は見た目が近い文字へ置換


def _safe_webhook_username(name: str) -> str:
    """Webhook の username に使えない語 (discord / clyde) を含むと送信が 400 で失敗するので避ける。"""
    for word, ch, repl in _WEBHOOK_BANNED_WORDS:
        name = re.sub(word, lambda m: m.group(0).replace(ch, repl).replace(ch.upper(), repl.upper()),
                      name, flags=re.IGNORECASE)
    return name[:80].strip() or "unknown"


def _can_delete_room(room: RoomConfig, user, guild: Optional[discord.Guild]) -> bool:
    """ルームを消せるのは作成者本人か、ルームを作ったサーバーでサーバー管理権限を持つ人だけ。

    別のサーバーで管理権限を持っていても、そのサーバーのルームではないので消せない。
    """
    if user.id == room.owner_id:
        return True
    if guild is None or guild.id != room.owner_guild_id:
        return False
    permissions = getattr(user, "guild_permissions", None)
    return bool(permissions and permissions.manage_guild)


# ============================================================
# グロチャ (テキストチャット連携) 管理
# ============================================================
@dataclasses.dataclass
class TextLink:
    guild_id: int
    channel_id: int
    webhook: discord.Webhook


# ルームごとに連携中のテキストチャンネル: { "room_name": [TextLink, ...] }
ROOM_TEXT_LINKS: dict[str, list[TextLink]] = {}
# チャンネルID -> ルーム名 の逆引き (on_message での高速判定用)
CHANNEL_TO_ROOM: dict[int, str] = {}


async def _remove_text_link(channel_id: int, *, delete_webhook: bool = True) -> Optional[str]:
    """指定チャンネルのグロチャ連携を解除する。所属していたルーム名を返す。"""
    room_name = CHANNEL_TO_ROOM.pop(channel_id, None)
    if room_name is None:
        return None

    links = ROOM_TEXT_LINKS.get(room_name, [])
    for link in list(links):
        if link.channel_id == channel_id:
            links.remove(link)
            if delete_webhook:
                try:
                    await link.webhook.delete(reason="グロチャ連携解除")
                except Exception:
                    logger.debug("webhook 削除失敗 (無視)", exc_info=True)
    if not links:
        ROOM_TEXT_LINKS.pop(room_name, None)
    return room_name


# ============================================================
# DAVE (Discord E2EE) 対応パッチ
# ============================================================
try:
    import davey  # type: ignore
except Exception:
    davey = None  # type: ignore[assignment]

_UNSET = object()
_media_type_audio = _UNSET


def _media_type_classes(session=None) -> list:
    found: list = []
    def _add(cls) -> None:
        if cls is not None and not any(cls is f for f in found):
            found.append(cls)

    if davey is not None:
        _add(getattr(davey, "MediaType", None))
    if session is not None:
        mod = sys.modules.get(type(session).__module__)
        if mod is not None:
            _add(getattr(mod, "MediaType", None))
    for name, mod in list(sys.modules.items()):
        if mod is None or "dave" not in name.lower():
            continue
        _add(getattr(mod, "MediaType", None))
    return found


def _media_type_candidates(session=None) -> list:
    candidates: list = []
    seen: set = set()
    def _add(value) -> None:
        if value is None:
            return
        key = (id(type(value)), repr(value))
        if key in seen:
            return
        seen.add(key)
        candidates.append(value)

    for cls in _media_type_classes(session):
        for attr in ("audio", "Audio", "AUDIO"):
            _add(getattr(cls, attr, None))
        try:
            _add(cls(0))
        except Exception:
            pass
    _add(0)
    return candidates


_DAVE_SILENCE_FRAME = b"\xf8\xff\xfe"  # Opus の無音フレームは DAVE でも暗号化されずに送られてくる
_candidates_cache: list = []


def _cached_media_type_candidates(session) -> list:
    """MediaType 候補は一度だけ組み立てて使い回す。

    以前は復号に失敗するたびに sys.modules 全体を走査していたため、無音フレームなど復号できない
    パケットが続くだけで受信スレッドが詰まり、音声が途切れる原因になっていた。
    """
    global _candidates_cache
    if not _candidates_cache:
        _candidates_cache = _media_type_candidates(session)
    return _candidates_cache


def _patch_voice_recv_client() -> None:
    vc_cls = voice_recv.VoiceRecvClient
    if getattr(vc_cls, "_dave_patch_applied", False):
        return
    vc_cls._dave_patch_applied = True

    def _get_dave_session(self):
        connection = getattr(self, "_connection", None)
        return getattr(connection, "dave_session", None) if connection else None

    def dave_is_active(self) -> bool:
        return _get_dave_session(self) is not None

    def dave_decrypt(self, user_id: int, data: bytes) -> bytes:
        global _media_type_audio
        session = _get_dave_session(self)
        if session is None:
            return data
        if data == _DAVE_SILENCE_FRAME:
            return data  # 無音フレームは平文のまま。そのままデコーダへ渡せばよい

        cached = _media_type_audio
        if cached is not _UNSET:
            try:
                return session.decrypt(user_id, cached, data)
            except TypeError:
                # キャッシュした MediaType の型自体が合わない -> 候補を再探索
                logger.debug("DAVE decrypt: キャッシュ済み MediaType %r が型不一致。再探索します。", cached)
                _media_type_audio = _UNSET
            except Exception as e:
                # 型は合っている。復号失敗はそのパケット/ユーザー固有 (エポック更新直後など) なので、
                # キャッシュは捨てずにこのパケットだけ落とす。
                raise RuntimeError(f"DAVE decrypt 失敗: {e!r}") from e

        last_error: Exception | None = None
        for candidate in _cached_media_type_candidates(session):
            try:
                result = session.decrypt(user_id, candidate, data)
            except Exception as e:
                last_error = e
                continue
            _media_type_audio = candidate
            logger.debug("DAVE decrypt: MediaType 候補 %r で復号成功", candidate)
            return result

        try:
            return session.decrypt(user_id, data)
        except Exception as e:
            last_error = e

        raise RuntimeError(f"DAVE decrypt 失敗: {last_error!r}")

    vc_cls.dave_is_active = dave_is_active
    vc_cls.dave_decrypt = dave_decrypt


_patch_voice_recv_client()


class GlobalAudioSink(voice_recv.AudioSink):
    def __init__(self, room_name: str, current_vc: voice_recv.VoiceRecvClient):
        super().__init__()
        self.room_name = room_name
        self.current_vc = current_vc
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self.opus_available = discord.opus.is_loaded()
        self._warned_decrypt = False
        self._warned_decode = False
        if not self.opus_available:
            logger.warning("ルーム %s: libopus がロードされていません。音声を復号できません。", room_name)

    def wants_opus(self) -> bool:
        return True

    def write(self, user, data: voice_recv.VoiceData) -> None:
        raw_opus = getattr(data, 'opus', None)
        if not raw_opus or not user:
            return

        user_id = getattr(user, 'id', 0)
        if user_id == 0:
            return

        # DAVE復号処理
        try:
            payload = self.current_vc.dave_decrypt(user_id, bytes(raw_opus))
        except Exception as e:
            if not self._warned_decrypt:
                self._warned_decrypt = True
                logger.warning("ルーム %s: DAVE復号に失敗しました (以後は debug ログのみ出力): %r", self.room_name, e)
            else:
                logger.debug("ルーム %s: DAVE復号失敗: %r", self.room_name, e)
            return

        if not payload or not self.opus_available:
            return

        decoder = self.decoders.get(user_id)
        if decoder is None:
            decoder = discord.opus.Decoder()
            self.decoders[user_id] = decoder

        try:
            pcm = decoder.decode(payload, fec=False)
        except discord.opus.OpusError as e:
            if not self._warned_decode:
                self._warned_decode = True
                logger.warning("ルーム %s: Opusデコードに失敗しました (以後は debug ログのみ出力): %r", self.room_name, e)
            else:
                logger.debug("ルーム %s: Opusデコード失敗: %r", self.room_name, e)
            return

        # 復号されたPCM音声を他サーバーの再生ソースに流す（話者ごとに別トラックで積み、再生側で合成する）
        if pcm:
            # 受信スレッドから呼ばれるので、イベントループ側の増減に備えてコピーを回す
            for vc in list(GLOBAL_ROOMS.get(self.room_name, ())):
                if vc is self.current_vc or not vc.is_connected():
                    continue
                source = getattr(vc, "global_source", None)
                if source is None:
                    continue
                source.write_pcm(pcm, user_id)
                if not vc.is_playing():
                    _request_playback(vc)  # 再生が止まっていたら、音が届いた時点で再開させる

    def cleanup(self) -> None:
        self.decoders.clear()


_SILENCE = b"\x00" * FRAME_BYTE_SIZE


def mix_pcm_frames(frames: list[bytes]) -> bytes:
    """16bit PCM のフレームを足し合わせて1本にする。範囲を超えた分は上下限で止めて音割れを防ぐ。"""
    if not frames:
        return _SILENCE
    if len(frames) == 1:
        return frames[0]
    if np is not None:
        acc = np.frombuffer(frames[0], dtype="<i2").astype(np.int32)
        for frame in frames[1:]:
            acc += np.frombuffer(frame, dtype="<i2")
        np.clip(acc, -32768, 32767, out=acc)
        return acc.astype("<i2").tobytes()
    arrays = []
    for frame in frames:
        samples = array.array("h")
        samples.frombytes(frame)
        if sys.byteorder == "big":
            samples.byteswap()
        arrays.append(samples)
    mixed = array.array("h", (max(-32768, min(32767, sum(group))) for group in zip(*arrays)))
    if sys.byteorder == "big":
        mixed.byteswap()
    return mixed.tobytes()


class _Track:
    """1人分の再生待ちバッファ。"""
    __slots__ = ("buf", "started", "last_write")

    def __init__(self):
        self.buf = bytearray()
        self.started = False
        self.last_write = time.monotonic()


class GlobalAudioSource(discord.AudioSource):
    """他サーバーから届いた音声を自サーバーVCに再生するSource。

    話者(ユーザーID)ごとに別々のバッファを持ち、20msごとに全員分を1フレームへ合成して返す。
    以前は全員のPCMを1本のキューに順番に積んでいたため、同時に話すと音が重ならず直列になっていた。
    """

    def __init__(self):
        self._tracks: dict[int, _Track] = {}
        self._lock = threading.Lock()

    def write_pcm(self, pcm: bytes, user_id: int = 0):
        now = time.monotonic()
        with self._lock:
            track = self._tracks.get(user_id)
            if track is None:
                track = self._tracks[user_id] = _Track()
            track.buf.extend(pcm)
            track.last_write = now
            # 上限を超えたら古い分から捨てる (遅延が溜まり続けない。ステレオ1サンプル=4バイト単位で切る)
            overflow = len(track.buf) - MAX_BUFFER_FRAMES * FRAME_BYTE_SIZE
            if overflow > 0:
                del track.buf[:overflow - overflow % FRAME_SIZE]

    def discard_stale(self, max_age: float = 0.5, keep_frames: int = 5):
        """再生が止まっていた間に溜まった古い音を捨てる。直近の音声は残す。"""
        now = time.monotonic()
        with self._lock:
            for user_id, track in list(self._tracks.items()):
                if now - track.last_write > max_age:
                    del self._tracks[user_id]
                    continue
                extra = len(track.buf) - keep_frames * FRAME_BYTE_SIZE
                if extra > 0:
                    del track.buf[:extra - extra % FRAME_SIZE]

    def read(self) -> bytes:
        now = time.monotonic()
        frames: list[bytes] = []
        prefill = JITTER_PREFILL_FRAMES * FRAME_BYTE_SIZE
        with self._lock:
            for user_id, track in list(self._tracks.items()):
                size = len(track.buf)
                if not track.started:
                    # 話し始めは少し溜めてから流す。端数しか来ていなくても、続きが来なければ流しきる
                    if size >= prefill or (size and now - track.last_write >= TAIL_FLUSH_SECONDS):
                        track.started = True
                    else:
                        if not size and now - track.last_write >= TRACK_IDLE_SECONDS:
                            del self._tracks[user_id]
                        continue
                if size >= FRAME_BYTE_SIZE:
                    frames.append(bytes(track.buf[:FRAME_BYTE_SIZE]))
                    del track.buf[:FRAME_BYTE_SIZE]
                elif size:
                    frames.append(bytes(track.buf).ljust(FRAME_BYTE_SIZE, b"\x00"))
                    track.buf.clear()
                    track.started = False
                else:
                    track.started = False  # 溜めが尽きた。次に音が来たらまた少し溜めてから流す
        # 誰も話していなければ無音 (PCM 0埋め) を返す
        return mix_pcm_frames(frames)

    def is_opus(self) -> bool:
        return False


# ============================================================
# 再生の開始 / 再開
# ============================================================
def _log_play_end(error) -> None:
    if error:
        logger.warning("グローバルVC: 再生が異常終了しました: %r", error)


def _ensure_playing(vc) -> bool:
    """vc がグローバルVC用の Source を再生していなければ、再生を始める (すでに再生中なら何もしない)。

    参加時だけでなく、他サーバーの参加時・再接続後・誰かが vc.stop() した後・音が届いたときなど、
    止まっている可能性があるタイミングで何度でも呼べる。イベントループ上で呼ぶこと。
    """
    source = getattr(vc, "global_source", None)
    if source is None:
        return False
    try:
        if not vc.is_connected():
            return False
        add_audio_source(vc, "gvc", source)
        source.discard_stale()  # 止まっていた間に溜まった古い音だけ捨てる (直近の音は残す)
        vc._gvc_play_warned = False
        logger.debug("グローバルVC: 再生を開始しました (guild=%s)", getattr(getattr(vc, "guild", None), "id", None))
        return True
    except Exception:
        level = logging.DEBUG if getattr(vc, "_gvc_play_warned", False) else logging.WARNING
        vc._gvc_play_warned = True
        logger.log(level, "グローバルVC: 再生の開始に失敗しました", exc_info=True)
        return False


def _start_room_playback(room_name: str) -> None:
    """ルームに接続中の全サーバーについて、再生が始まっていなければ始める。"""
    for vc in list(GLOBAL_ROOMS.get(room_name, ())):
        _ensure_playing(vc)


def _request_playback(vc) -> None:
    """受信スレッドから呼ぶ用。再生の再開をイベントループ側に依頼する (0.5秒に1回まで)。"""
    now = time.monotonic()
    if now - getattr(vc, "_gvc_last_kick", 0.0) < 0.5:
        return
    vc._gvc_last_kick = now
    loop = getattr(vc, "loop", None)
    if loop is None:
        return
    try:
        loop.call_soon_threadsafe(_ensure_playing, vc)
    except RuntimeError:
        pass  # ループが閉じている (終了処理中)


class _JoinRefused(Exception):
    """満員・重複参加など、利用者に理由をそのまま伝えられる参加拒否。"""


# ============================================================
# ルームオプション (gvc create で指定するフラグ)
# ============================================================
class RoomOptions(commands.FlagConverter, prefix="--", delimiter=" ", case_insensitive=True):
    max: int = commands.flag(default=0, description="最大参加サーバー数 (0=無制限)")
    private: bool = commands.flag(default=False, description="非公開ルームにする (参加時にパスワードが必要)")
    password: str = commands.flag(default="", description="非公開ルームのパスワード")
    desc: str = commands.flag(default="", description="ルームの説明")


# ============================================================
# グローバル VC Cog 本体
# ============================================================
class GlobalVCCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self._join_locks: dict[int, asyncio.Lock] = {}

    async def cog_load(self):
        self._playback_watchdog.start()

    async def cog_unload(self):
        self._playback_watchdog.cancel()

    @tasks.loop(seconds=PLAYBACK_WATCHDOG_SECONDS)
    async def _playback_watchdog(self):
        """再接続や外部からの stop などで再生が止まったサーバーを、定期的に見回って再開させる。"""
        _prune_dead_clients()
        for clients in list(GLOBAL_ROOMS.values()):
            for vc in list(clients):
                _ensure_playing(vc)

    @staticmethod
    def _cleanup(guild_id: int):
        """VC を手放すとき（/voice community の退出・ルーム削除・自動退出・外部切断）にルーム管理から外す。

        外部から切断されたときもここが呼ばれるので、GLOBAL_ROOMS に古い接続が残らない。
        """
        def cleanup(reason: str) -> None:
            for clients in list(GLOBAL_ROOMS.values()):
                for vc in list(clients):
                    if getattr(getattr(vc, "guild", None), "id", None) != guild_id:
                        continue
                    _remove_vc_from_rooms(vc)
                    remove_receive_sink(vc, "gvc")
                    remove_audio_source(vc, "gvc")
                    if hasattr(vc, "global_source"):
                        delattr(vc, "global_source")
        return cleanup

    async def _connect_room(self, guild: discord.Guild, vc_channel, user, text_channel, room_name: str):
        """VC に接続し、受信Sink・再生Sourceを付けてルームへ登録する。ルーム作成時と参加時で共通。"""
        lock = self._join_locks.setdefault(guild.id, asyncio.Lock())
        async with lock:  # 同じサーバーからの同時参加で二重に接続しないようにする
            _prune_dead_clients()
            room = ROOMS.get(room_name)
            if room is None:
                raise _JoinRefused(f"ルーム **{room_name}** は存在しません。")
            for name, clients in GLOBAL_ROOMS.items():
                if any(c.guild and c.guild.id == guild.id for c in clients):
                    raise _JoinRefused(f"このサーバーはすでにルーム **{name}** に参加しています。")
            if room.max_servers and len(GLOBAL_ROOMS.get(room_name, [])) >= room.max_servers:
                raise _JoinRefused(f"ルーム **{room_name}** は満員です ({room.max_servers}サーバーまで)。")

            # 音楽・読み上げ・文字起こしとは同じVC接続を共有し、それ以外は VoiceBusy になる
            vc = await self.voice_sessions.acquire(
                guild, vc_channel, "global", user,
                cleanup=self._cleanup(guild.id), text_channel=text_channel, force=True, timeout=30.0,
            )

            try:
                vc.global_source = GlobalAudioSource()
                add_receive_sink(vc, "gvc", GlobalAudioSink(room_name, vc))
            except Exception:
                remove_receive_sink(vc, "gvc")
                remove_audio_source(vc, "gvc")
                if hasattr(vc, "global_source"):
                    delattr(vc, "global_source")
                # 途中で失敗したら VC を掴んだままにせず手放す (接続だけ残って無音になるのを防ぐ)
                await self._leave_room(vc, reason="error")
                raise

            vc._gvc_down_since = None
            members = GLOBAL_ROOMS.setdefault(room_name, [])
            if vc not in members:
                members.append(vc)

            # 参加してきたサーバー自身はもちろん、すでに接続中の他サーバーも、止まっていれば再生を始める
            _start_room_playback(room_name)
            return vc

    async def _leave_room(self, vc, *, reason: str = "stop", notice=None) -> None:
        guild = getattr(vc, "guild", None)
        if guild is None or not await self.voice_sessions.release(guild.id, "global", reason=reason, notice=notice):
            await _disconnect_and_cleanup(vc)

    @commands.group(name="gvc", invoke_without_command=True)
    async def gvc_group(self, ctx: commands.Context):
        embed = discord.Embed(title="🌐 グローバルVC コマンド一覧", color=0x3498DB)
        embed.description = (
            f"`{ctx.prefix}gvc create <ルーム名> [--max 5] [--private] [--password xxxx] [--desc 説明]` "
            f": 新しいルームを作成\n"
            f"`/voice のパネルからグローバルVC開始/参加 room:<ルーム名> [password]` : 指定したルームに参加 (要ボイスチャンネル在室)\n"
            f"`{ctx.prefix}gvc list` : ルーム一覧を表示\n"
            f"`{ctx.prefix}gvc info <ルーム名>` : ルームの詳細設定を表示\n"
            f"`{ctx.prefix}gvc delete <ルーム名>` : ルームを削除 (作成者か、作成したサーバーの管理者のみ)\n"
            f"`/voice のパネルからグローバルVC終了/退出` : グローバルVCから離脱 (ルーム自体は残ります)\n"
            f"`{ctx.prefix}gvc chat connect <ルーム名> [パスワード]` : このチャンネルをグロチャに接続\n"
            f"`{ctx.prefix}gvc chat disconnect` : このチャンネルのグロチャ接続を解除\n\n"
            f"ルーム名にスペースを含める場合は `\"\"` で囲んでください。"
        )
        await ctx.send(embed=embed)

    @gvc_group.command(name="create")
    async def gvc_create(self, ctx: commands.Context, room_name: str, *, options: RoomOptions = None):
        # フラグが一切指定されなかった場合、discord.py は空文字列を RoomOptions に変換して
        # 各フラグのデフォルト値を持つインスタンスを渡してくる。念のため None の場合の保険も入れる。
        if ctx.guild is None:
            return await ctx.send("⚠️ ルームはサーバー内で作成してください。")
        if room_name in ROOMS:
            return await ctx.send(f"⚠️ ルーム **{room_name}** はすでに存在します。")

        max_servers = options.max if options else 0
        private = options.private if options else False
        password = options.password if options else ""
        description = options.desc if options else ""

        if private and not password:
            return await ctx.send("⚠️ 非公開ルームにする場合は `--password` でパスワードを指定してください。")
        if max_servers < 0:
            return await ctx.send("⚠️ `--max` は 0 以上の値を指定してください。")

        ROOMS[room_name] = RoomConfig(
            name=room_name,
            owner_id=ctx.author.id,
            owner_guild_id=ctx.guild.id,
            max_servers=max_servers,
            private=private,
            password=password,
            description=description,
        )

        embed = discord.Embed(title=f"🌐 ルーム **{room_name}** を作成しました", color=0x2ECC71)
        embed.add_field(name="最大参加サーバー数", value="無制限" if max_servers == 0 else str(max_servers))
        embed.add_field(name="公開設定", value="🔒 非公開" if private else "🌍 公開")
        if description:
            embed.add_field(name="説明", value=description, inline=False)
        embed.set_footer(text=f"/voice のパネルからグローバルVC開始/参加 room:{room_name} で参加できます")
        await ctx.send(embed=embed)

        # 作成者がボイスチャンネルにいるなら、そのままボットも参加させる
        voice = getattr(ctx.author, "voice", None)
        if not voice or not voice.channel:
            return await ctx.send(
                "ℹ️ ボイスチャンネルに入った状態でルームを作成すると、ボットが自動で参加します。"
                "参加するには /voice のパネルから参加してください。"
            )
        try:
            await self._connect_room(ctx.guild, voice.channel, ctx.author, ctx.channel, room_name)
        except (_JoinRefused, VoiceBusy) as e:
            await ctx.send(f"⚠️ ルームは作成しましたが、VC には参加できませんでした: {e}")
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s 作成後の自動参加に失敗しました", room_name, exc_info=True)
            await ctx.send(f"⚠️ ルームは作成しましたが、VC への参加に失敗しました: `{e}`")
        else:
            await ctx.send(f"🎙️ **{voice.channel.name}** に参加し、ルーム **{room_name}** に接続しました。")

    @gvc_group.command(name="list")
    async def gvc_list(self, ctx: commands.Context):
        if not ROOMS:
            return await ctx.send("現在作成されているグローバルVCルームはありません。")

        embed = discord.Embed(title="🌐 ルーム一覧", color=0x2ECC71)
        for room_name, room in ROOMS.items():
            clients = GLOBAL_ROOMS.get(room_name, [])
            servers = [vc.guild.name for vc in clients if vc.guild]
            lock = "🔒" if room.private else "🌍"
            cap = "無制限" if room.max_servers == 0 else f"{len(servers)}/{room.max_servers}"
            chat_count = len(ROOM_TEXT_LINKS.get(room_name, []))
            value = f"{lock} VC参加サーバー数: {cap} / グロチャ接続数: {chat_count}"
            if servers:
                value += f"\n接続中: {', '.join(servers)}"
            if room.description:
                value += f"\n説明: {room.description}"
            embed.add_field(name=f"🎙️ {room_name}", value=value, inline=False)
        await ctx.send(embed=embed)

    @gvc_group.command(name="info")
    async def gvc_info(self, ctx: commands.Context, room_name: str):
        room = ROOMS.get(room_name)
        if room is None:
            return await ctx.send(f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。")

        clients = GLOBAL_ROOMS.get(room_name, [])
        servers = [vc.guild.name for vc in clients if vc.guild]

        text_links = ROOM_TEXT_LINKS.get(room_name, [])
        chat_channels = []
        for link in text_links:
            channel = self.bot.get_channel(link.channel_id)
            if channel:
                chat_channels.append(f"#{channel.name} ({channel.guild.name})")

        embed = discord.Embed(title=f"🌐 ルーム情報: {room_name}", color=0x3498DB)
        embed.add_field(name="公開設定", value="🔒 非公開" if room.private else "🌍 公開")
        embed.add_field(name="最大参加サーバー数", value="無制限" if room.max_servers == 0 else str(room.max_servers))
        embed.add_field(name="現在の参加サーバー数(VC)", value=str(len(servers)))
        if servers:
            embed.add_field(name="接続中のサーバー(VC)", value=", ".join(servers), inline=False)
        embed.add_field(name="グロチャ接続数", value=str(len(chat_channels)))
        if chat_channels:
            embed.add_field(name="グロチャ接続チャンネル", value="\n".join(chat_channels), inline=False)
        if room.description:
            embed.add_field(name="説明", value=room.description, inline=False)
        embed.add_field(name="作成日時", value=f"<t:{int(room.created_at)}:R>", inline=False)
        await ctx.send(embed=embed)

    @gvc_group.command(name="delete")
    async def gvc_delete(self, ctx: commands.Context, room_name: str):
        room = ROOMS.get(room_name)
        if room is None:
            return await ctx.send(f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。")

        if not _can_delete_room(room, ctx.author, ctx.guild):
            return await ctx.send(
                "⚠️ このルームを削除できるのは、作成者か、ルームを作ったサーバーで"
                "「サーバー管理」権限を持つ人だけです。"
            )

        for vc in list(GLOBAL_ROOMS.get(room_name, [])):
            own = ctx.guild is not None and getattr(vc.guild, "id", None) == ctx.guild.id
            await self._leave_room(vc, reason="room_deleted", notice=None if own else
                                   f"🗑️ ルーム **{room_name}** が削除されたため、グローバルVCから切断しました。")

        for link in list(ROOM_TEXT_LINKS.get(room_name, [])):
            await _remove_text_link(link.channel_id)

        GLOBAL_ROOMS.pop(room_name, None)
        ROOM_TEXT_LINKS.pop(room_name, None)
        del ROOMS[room_name]
        await ctx.send(f"🗑️ ルーム **{room_name}** を削除しました (VC・グロチャの連携もすべて解除)。")

    # --------------------------------------------------
    # 実装（/voice community）
    # --------------------------------------------------
    async def _global_impl(self, r: Responder, action: str, room_name: str | None = None, password: str | None = None):
        """action: join / leave"""
        if action == "leave":
            return await self._leave(r)
        return await self._join(r, room_name, password)

    async def _join(self, r: Responder, room_name: str | None, password: str | None):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send("⚠️ ボイスチャンネルに参加してから実行してください。", ephemeral=True)
        if not room_name:
            return await r.send("⚠️ 参加するルーム名を `room` に入れてください。", ephemeral=True)

        room = ROOMS.get(room_name)
        if room is None:
            return await r.send(
                f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。"
                f"先に `!gvc create {room_name}` で作成してください。"
            )

        if room.private and password != room.password:
            return await r.send("🔒 このルームは非公開です。正しいパスワードを指定してください。")

        _prune_dead_clients(room_name)
        current_members = GLOBAL_ROOMS.get(room_name, [])
        if room.max_servers and len(current_members) >= room.max_servers:
            return await r.send(f"⚠️ ルーム **{room_name}** は満員です ({room.max_servers}サーバーまで)。")

        if any(vc.guild and vc.guild.id == r.guild.id for vc in current_members):
            return await r.send(f"⚠️ このサーバーはすでにルーム **{room_name}** に参加しています。")

        vc_channel = voice.channel
        await r.defer()

        session = self.voice_sessions.get(r.guild.id)
        if session is not None and session.feature == "global":
            joined = next((name for name, clients in GLOBAL_ROOMS.items()
                           if any(c.guild and c.guild.id == r.guild.id for c in clients)), None)
            return await r.send(
                f"⚠️ このサーバーはすでにルーム **{joined or '不明'}** に参加しています。"
                "先に `/voice のパネルからグローバルVC終了/退出` してください。"
            )

        try:
            await self._connect_room(r.guild, vc_channel, r.user, r.channel, room_name)
        except _JoinRefused as refused:
            return await r.send(f"⚠️ {refused}")
        except VoiceBusy as busy:
            return await r.send(str(busy))
        except Exception as e:
            logger.warning("グローバルVC: ルーム %s への参加に失敗しました", room_name, exc_info=True)
            return await r.send(f"<:failed:1490986584676368535> ボイス接続に失敗しました: `{e}`")

        await r.send(
            f"🌐 ルーム **{room_name}** に参加しました！\n"
            f"別サーバーの同名ルームと相互接続されています。"
        )

    async def _leave(self, r: Responder):
        if r.guild is not None and await self.voice_sessions.release(r.guild.id, "global", reason="stop"):
            return await r.send("🌐 グローバルVCから切断しました。ルーム自体は残っています。")

        vc = r.voice_client
        if not vc:
            return await r.send("現在ボイスチャンネルに接続していません。")
        if any(vc in clients for clients in GLOBAL_ROOMS.values()):
            # 持ち主の記録がない古い接続
            await _disconnect_and_cleanup(vc)
            return await r.send("🌐 グローバルVCから切断しました。ルーム自体は残っています。")
        # 音楽や録音など、グローバルVC 以外の機能は止めない（以前はここで何でも切断していた）
        await r.send("このサーバーはグローバルVCに参加していません。")

    # ------------------------------------------------------------
    # グロチャ (テキストチャット連携)
    # ------------------------------------------------------------
    @gvc_group.group(name="chat", invoke_without_command=True)
    async def gvc_chat_group(self, ctx: commands.Context):
        embed = discord.Embed(title="🌐 グロチャ コマンド一覧", color=0x3498DB)
        embed.description = (
            f"`{ctx.prefix}gvc chat connect <ルーム名> [パスワード]` : このチャンネルを指定ルームのグロチャに接続\n"
            f"`{ctx.prefix}gvc chat disconnect` : このチャンネルのグロチャ接続を解除"
        )
        await ctx.send(embed=embed)

    @gvc_chat_group.command(name="connect")
    async def gvc_chat_connect(self, ctx: commands.Context, room_name: str, password: str = None):
        if ctx.guild is None:
            return await ctx.send("⚠️ グロチャはサーバー内のチャンネルで接続してください。")
        room = ROOMS.get(room_name)
        if room is None:
            return await ctx.send(
                f"<:failed:1490986584676368535> ルーム **{room_name}** は存在しません。"
                f"先に `{ctx.prefix}gvc create {room_name}` で作成してください。"
            )

        if room.private and password != room.password:
            return await ctx.send("🔒 このルームは非公開です。正しいパスワードを指定してください。")

        if ctx.channel.id in CHANNEL_TO_ROOM:
            current_room = CHANNEL_TO_ROOM[ctx.channel.id]
            return await ctx.send(
                f"⚠️ このチャンネルはすでにルーム **{current_room}** のグロチャに接続されています。"
                f"先に `{ctx.prefix}gvc chat disconnect` してください。"
            )

        if any(link.guild_id == ctx.guild.id for link in ROOM_TEXT_LINKS.get(room_name, [])):
            return await ctx.send(f"⚠️ このサーバーはすでに別のチャンネルでルーム **{room_name}** のグロチャに接続済みです。")

        perms = ctx.channel.permissions_for(ctx.guild.me)
        if not perms.manage_webhooks:
            return await ctx.send("⚠️ このチャンネルで Webhook を管理する権限がボットにありません。")

        try:
            webhook = await ctx.channel.create_webhook(
                name=f"グロチャ: {room_name}", reason="グローバルチャット連携"
            )
        except Exception as e:
            return await ctx.send(f"<:failed:1490986584676368535> Webhook の作成に失敗しました: `{e}`")

        link = TextLink(guild_id=ctx.guild.id, channel_id=ctx.channel.id, webhook=webhook)
        ROOM_TEXT_LINKS.setdefault(room_name, []).append(link)
        CHANNEL_TO_ROOM[ctx.channel.id] = room_name

        await ctx.send(
            f"🌐 このチャンネルをルーム **{room_name}** のグロチャに接続しました！\n"
            f"以降、このチャンネルの発言は同ルームに接続中の他サーバーへ、送信者の名前とアイコンで中継されます。"
        )

    @gvc_chat_group.command(name="disconnect")
    async def gvc_chat_disconnect(self, ctx: commands.Context):
        room_name = await _remove_text_link(ctx.channel.id)
        if room_name is None:
            return await ctx.send("このチャンネルはグロチャに接続されていません。")
        await ctx.send(f"🌐 ルーム **{room_name}** のグロチャ接続を解除しました。")

    @commands.Cog.listener("on_message")
    async def on_message(self, message: discord.Message):
        # webhook からの中継メッセージ自身には反応しない (無限ループ防止)
        if message.webhook_id is not None:
            return
        if message.author.bot:
            return
        if not message.guild:
            return

        room_name = CHANNEL_TO_ROOM.get(message.channel.id)
        if room_name is None:
            return

        if not message.content and not message.attachments:
            return

        links = ROOM_TEXT_LINKS.get(room_name, [])
        if len(links) <= 1:
            return  # 他に接続チャンネルがなければ中継不要

        # 添付ファイルは一度だけ読み込み、送信先ごとに新しい File として使い回す
        # (discord.File は一度送信すると再利用できないため)
        attachment_payloads: list[tuple[bytes, str]] = []
        for attachment in message.attachments:
            try:
                data = await attachment.read()
                attachment_payloads.append((data, attachment.filename))
            except Exception:
                logger.debug("グロチャ: 添付ファイル取得失敗 (%s)", attachment.filename, exc_info=True)

        content = (message.content or "")[:2000]
        username = _safe_webhook_username(f"{message.author.display_name} [{message.guild.name}]")
        avatar_url = message.author.display_avatar.url

        async def relay(link: TextLink) -> None:
            files = [discord.File(io.BytesIO(data), filename=name) for data, name in attachment_payloads]
            try:
                await link.webhook.send(
                    content=content if content else None,
                    username=username,
                    avatar_url=avatar_url,
                    files=files if files else discord.utils.MISSING,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            except discord.NotFound:
                # webhook が手動で削除された等 -> このチャンネルの連携を自動解除
                logger.warning(
                    "ルーム %s: webhook が見つかりません。連携を解除します (channel_id=%s)",
                    room_name, link.channel_id,
                )
                await _remove_text_link(link.channel_id, delete_webhook=False)
            except Exception as e:
                logger.warning(
                    "ルーム %s: グロチャ中継に失敗しました (channel_id=%s): %r",
                    room_name, link.channel_id, e,
                )

        # 1サーバーの遅延や失敗が他サーバーへの中継を止めないよう、並行して送る
        await asyncio.gather(*(relay(link) for link in list(links) if link.channel_id != message.channel.id))

    @commands.Cog.listener("on_guild_channel_delete")
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel):
        if channel.id in CHANNEL_TO_ROOM:
            # チャンネル自体が消えているので webhook 削除は試みない
            await _remove_text_link(channel.id, delete_webhook=False)


async def setup(bot: commands.Bot):
    await bot.add_cog(GlobalVCCog(bot))
