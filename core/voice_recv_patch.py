"""discord-ext-voice-recv の VoiceRecvClient へ DAVE（Discord E2EE）復号メソッドを足すモンキーパッチ。

以前は同じパッチが cogs/sio_globalVC.py / sio_karaoke.py / sio_rec.py /
sio_transcription.py の4ファイルに重複定義され、各ファイルの import 時に実行されていた。
適用済みフラグ（``_dave_patch_applied``）で最初に import された1つだけが有効になる作り
だったため、どの版が効くかは cog の読込順（main.py の os.listdir 順）依存だった。
版ごとの差分は意図的な機能差ではなく「片方にだけ入った修正」のドリフトだったため、
ここに1本化する。統合版は最も修正が進んでいた globalVC 版を正とし、sio_rec 版だけに
あった ``dave_is_ready`` を加えたもの:

- 無音フレーム（Opus silence）は DAVE でも暗号化されずに送られてくるので、そのまま返す
  （従来は呼び出し側が事前に弾いていたが、sio_music のように弾かずに呼ぶ経路もある）
- MediaType 候補は一度だけ組み立ててキャッシュする。復号に失敗するたびに
  sys.modules 全体を走査すると、復号できないパケットが続くだけで受信スレッドが
  詰まり、音声が途切れる原因になっていた
- キャッシュ済み MediaType での復号失敗は、型不一致（TypeError）ならキャッシュを
  捨てて候補を再探索し、それ以外の例外はそのパケット／ユーザー固有の失敗
  （エポック更新直後など）としてキャッシュを残したまま RuntimeError で落とす

各 cog は import 時に ``patch_voice_recv_client()`` を呼ぶ（従来どおり）。
この関数自体が冪等なので、何度呼ばれてもパッチはプロセス内で1回だけ適用される。
"""
from __future__ import annotations

import logging
import sys

from discord.ext import voice_recv

logger = logging.getLogger(__name__)

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


def patch_voice_recv_client() -> None:
    """VoiceRecvClient に dave_is_active / dave_is_ready / dave_decrypt を生やす（冪等）。"""
    vc_cls = voice_recv.VoiceRecvClient
    if getattr(vc_cls, "_dave_patch_applied", False):
        return
    vc_cls._dave_patch_applied = True

    def _get_dave_session(self):
        connection = getattr(self, "_connection", None)
        return getattr(connection, "dave_session", None) if connection else None

    def dave_is_active(self) -> bool:
        return _get_dave_session(self) is not None

    def dave_is_ready(self) -> bool:
        connection = getattr(self, "_connection", None)
        if connection is not None:
            state = getattr(connection, "is_e2ee", None)
            if isinstance(state, bool):
                return state
            if callable(state):
                try:
                    return bool(state())
                except Exception:
                    pass
        session = _get_dave_session(self)
        return bool(getattr(session, "ready", False)) if session else False

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
    vc_cls.dave_is_ready = dave_is_ready
    vc_cls.dave_decrypt = dave_decrypt
