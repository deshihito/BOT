# -*- coding: utf-8 -*-
"""再起動復旧用スナップショットの永続ストア（VCセッション／音楽／グローバルVC）。

設計原則は「切れても死なない」:

- スナップショットは終了時に保存するものではなく、使用中に継続保存する
  ものとして扱う。呼び出し側（core/voice/voice_session.py、cogs/sio_music.py、
  cogs/sio_globalVC.py）がキー遷移時と定期保存で set_entry / set_section
  を呼び続ける。再起動が優雅でも、クラッシュ・OOM・SIGKILL でも、
  直近のスナップショットから復旧できる。
- 起動時の復旧は「前回正常終了したか」を前提にしない。スナップショットが
  存在すれば常に reconcile し、復旧できないものは呼び出し側が掃除する。
- 保存先は専用 JSON（既定 data/voice_restore.json、環境変数
  VOICE_RESTORE_DATA_PATH で変更可）。core/market.py / core/items.py と
  同じ流儀で、メモリ主体＋バッチフラッシュ＋ tmp→replace の原子差し替え。
  壊れた JSON でも起動を止めない（退避して空から始める）。

ファイル構造::

    {
      "sessions":  {"<guild_id>": {...}},   # VoiceSessionManager の接続記録
      "music":     {"<guild_id>": {...}},   # 音楽の再生状態
      "gvc_rooms": {"<room_name>": {...}},  # グローバルVC のルーム定義
      "gvc_joins": {"<guild_id>": {...}}    # グローバルVC の参加状態
      "gvc_text_links": {"<room_name>": {"links": [...]}}  # グロチャのテキスト連携
      "vc_features": {"<guild_id>:<feature>": {...}}  # 録音/カラオケ/文字起こし/ボイチェンの再開用設定
    }
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "voice_restore.json"

SECTIONS = ("sessions", "music", "gvc_rooms", "gvc_joins", "gvc_text_links", "vc_features")

FLUSH_EVERY_EVENTS = 5
FLUSH_INTERVAL_SECONDS = 10.0


def default_path() -> Path:
    return Path(os.environ.get("VOICE_RESTORE_DATA_PATH") or _DEFAULT_PATH)


def _empty_data() -> dict[str, dict[str, Any]]:
    return {name: {} for name in SECTIONS}


class VoiceRestoreStore:
    """スナップショット全体をメモリに持ち、変更をバッチで JSON へ書く（同期 API）。"""

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
        self._data = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, dict[str, Any]]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return _empty_data()
        except Exception:
            logger.exception(
                "voice_restore: %s の読み込みに失敗しました。壊れたファイルを退避して続行します",
                self._path,
            )
            try:
                os.replace(
                    self._path,
                    self._path.with_name(self._path.name + f".broken-{int(time.time())}"),
                )
            except OSError:
                logger.debug("voice_restore: 壊れたファイルの退避に失敗しました", exc_info=True)
            return _empty_data()
        if not isinstance(raw, dict):
            return _empty_data()
        data = _empty_data()
        for name in SECTIONS:
            section = raw.get(name)
            if isinstance(section, dict):
                data[name] = {str(key): value for key, value in section.items()
                              if isinstance(value, dict)}
        return data

    def flush(self) -> None:
        with self._lock:
            payload = copy.deepcopy(self._data)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("voice_restore: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 参照
    def section(self, name: str) -> dict[str, Any]:
        """セクション全体のコピーを返す。"""
        with self._lock:
            return copy.deepcopy(self._data.get(name, {}))

    def get_entry(self, section: str, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._data.get(section, {}).get(str(key))
            return copy.deepcopy(value) if isinstance(value, dict) else None

    # ------------------------------------------------------------------ 変更
    def set_entry(self, section: str, key: str, value: dict[str, Any] | None) -> None:
        """1エントリを設定する。``value`` が None なら削除（復旧後の掃除もこれで行う）。"""
        if section not in SECTIONS:
            raise ValueError(f"unknown voice_restore section: {section}")
        with self._lock:
            bucket = self._data[section]
            if value is None:
                if str(key) not in bucket:
                    return
                del bucket[str(key)]
            else:
                bucket[str(key)] = copy.deepcopy(value)
            self._mark_dirty()

    def set_section(self, name: str, value: dict[str, Any]) -> None:
        """セクション全体を置き換える（ルーム定義の一括保存など）。"""
        if name not in SECTIONS:
            raise ValueError(f"unknown voice_restore section: {name}")
        with self._lock:
            self._data[name] = {
                str(key): copy.deepcopy(entry)
                for key, entry in value.items() if isinstance(entry, dict)
            }
            self._mark_dirty()


_store: VoiceRestoreStore | None = None
_store_lock = threading.Lock()


def get_store() -> VoiceRestoreStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = VoiceRestoreStore()
        return _store


def reset_store(path: Path | str | None = None) -> VoiceRestoreStore:
    """シングルトンを作り直す（テスト・保存先切り替え用）。"""
    global _store
    with _store_lock:
        _store = VoiceRestoreStore(path)
        return _store
