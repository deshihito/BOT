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
import types
from typing import Optional
import discord
import discord.opus
from discord.ext import commands, tasks
from discord.ext import voice_recv
from core.vc import voice_restore
from core.support.legacy import Responder
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.vc.voice_media import add_audio_source, add_receive_sink, remove_audio_source, remove_receive_sink
try:
    import numpy as np  # type: ignore
except Exception:  # numpy が無い環境では純Pythonで合成する
    np = None  # type: ignore[assignment]

from core.vc.globalvc.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.globalvc.common import FRAME_BYTE_SIZE, FRAME_SIZE, JITTER_PREFILL_FRAMES, MAX_BUFFER_FRAMES, TAIL_FLUSH_SECONDS, TRACK_IDLE_SECONDS  # noqa: F401
from core.vc.globalvc.rooms import GLOBAL_ROOMS, ROOMS  # noqa: F401
from core.vc.globalvc.common import GLOBAL_MUSIC_SOURCE_NAMES  # noqa: F401

logger = logging.getLogger("cogs.sio_globalVC")


patch_voice_recv_client()


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


# ---------------------------------------------------------------------------
# bot 自身が再生する音声 (読み上げ・音楽) をルームの他サーバーへ中継する
# ---------------------------------------------------------------------------

def _room_name_of(vc) -> Optional[str]:
    for room_name, clients in GLOBAL_ROOMS.items():
        if vc in clients:
            return room_name
    return None


def _relay_pcm(origin_vc, name: str, pcm: bytes) -> None:
    """origin_vc で再生された PCM を、同じルームの他サーバーの再生ソースへ流す。

    - 音楽 (GLOBAL_MUSIC_SOURCE_NAMES): ルームのオーナーのサーバーで流れているものだけ中継する。
    - それ以外 (読み上げなど): どのサーバーのものでも自由に中継する。
    音声は「サーバー × 種類」ごとの別トラックとして積むので、人の声・読み上げ・音楽は互いに邪魔せず重なって流れる。
    """
    if not pcm or getattr(origin_vc, "global_source", None) is None:
        return  # グローバルVCに参加していないサーバーでは何もしない
    room_name = _room_name_of(origin_vc)
    if room_name is None:
        return
    guild = getattr(origin_vc, "guild", None)
    guild_id = getattr(guild, "id", 0)
    if name in GLOBAL_MUSIC_SOURCE_NAMES:
        room = ROOMS.get(room_name)
        if room is None or guild_id != room.owner_guild_id:
            return
    track_id = f"tee:{guild_id}:{name}"
    for vc in list(GLOBAL_ROOMS.get(room_name, ())):
        if vc is origin_vc or not vc.is_connected():
            continue
        source = getattr(vc, "global_source", None)
        if source is None:
            continue
        source.write_pcm(pcm, track_id)
        if not vc.is_playing():
            _request_playback(vc)


class TeeSource(discord.AudioSource):
    """元の Source をそのまま再生しつつ、読み出した音声のコピーをルームの他サーバーへ流すラッパー。"""

    _OWN = frozenset({"inner", "vc", "name", "_decoder"})

    def __init__(self, inner: discord.AudioSource, vc, name: str):
        object.__setattr__(self, "inner", inner)
        object.__setattr__(self, "vc", vc)
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "_decoder", None)

    def read(self) -> bytes:
        data = self.inner.read()
        if data:
            try:
                pcm = data
                if self.inner.is_opus():
                    if self._decoder is None:
                        object.__setattr__(self, "_decoder", discord.opus.Decoder())
                    pcm = self._decoder.decode(data, fec=False)
                _relay_pcm(self.vc, self.name, pcm)
            except Exception:
                logger.debug("グローバルVC: 再生音声の中継に失敗しました (name=%s)", self.name, exc_info=True)
        return data

    def is_opus(self) -> bool:
        return self.inner.is_opus()

    def cleanup(self) -> None:
        self.inner.cleanup()

    # volume など、元の Source の属性をそのまま読み書きできるようにする
    def __getattr__(self, attr):
        return getattr(self.inner, attr)

    def __setattr__(self, attr, value):
        if attr in self._OWN:
            object.__setattr__(self, attr, value)
        else:
            setattr(self.inner, attr, value)


def wrap_for_global(vc, name: str, source):
    """voice_media.add_audio_source から呼ぶ。グローバルVC自身の Source 以外を TeeSource で包む。"""
    if name == "gvc" or isinstance(source, TeeSource):
        return source  # gvc は他サーバーから受けた音なので、再中継するとループする
    return TeeSource(source, vc, name)