# -*- coding: utf-8 -*-
"""対局中ゲームセッションの再起動復旧用スナップショット（「切れても死なない」最終フェーズ）。

設計原則は core/voice_restore.py と同じ:

- スナップショットは終了時に保存するものではなく、対局中に継続保存する
  ものとして扱う。各ゲーム cog が手番の節目など状態遷移のたびに
  ``save_session`` を呼び続ける。再起動が優雅でも、クラッシュ・OOM・
  SIGKILL でも、直近のチェックポイントから対局を再開できる。
- チェックポイントは「手番の開始時点」の一貫した状態とする。手番の途中
  選択（駒を選んだだけ等）は復旧対象にせず、復旧時はその手番を最初から
  やり直す。
- 起動時の復旧は「前回正常終了したか」を前提にしない。スナップショットが
  存在すれば常に reconcile し、復旧できないもの（チャンネル消滅・状態の
  破損）は掃除して古い状態を残さない。
- 保存先は専用 JSON（既定 data/game_restore.json、環境変数
  GAME_RESTORE_DATA_PATH で変更可）。メモリ主体＋バッチフラッシュ＋
  tmp→replace の原子差し替え、壊れた JSON でも起動を止めない（退避して
  空から始める）のは voice_restore と同じ流儀。
- 永続化の失敗で対局の通常進行を止めることはしない（全て握ってログだけ
  残す）。

ファイル構造::

    {
      "<game_id>": {"<channel_id>": {
          "game": "<game_id>", "channel_id": int, "guild_id": int,
          "saved_at": float, "state": {...ゲーム固有の状態...}
      }}
    }

対象ゲーム（ターン制で状態が素直に JSON 化できるもの）:
    shogi / chess / othello / daifugo / babanuki / shinkei / shiritori /
    uno / wordle
対象外（理由は各 cog ではなく本フェーズの報告に集約）:
    jinrou / wordwolf（Event 駆動のフェーズ機械で途中状態を再構築できない）、
    janken（同時選択の短時間ラウンド＋賭けコインのエスクロー途中）、
    poker（チップ制テーブル。対局は復旧しないが、預かりチップは
    cogs/poker.py の台帳 data/poker_chips.json で起動時に全額返金する）、
    doubt（ダウト受付のリアルタイムウィンドウを含む）、
    ngword（手番のない会話常駐型）、
    dungeon / seizon（大規模 RPG で別途設計対象）、guess / flash / dice
    （セッション自体が無い一発勝負）。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
import types
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "game_restore.json"

GAME_IDS = (
    "shogi", "chess", "othello", "daifugo", "babanuki",
    "shinkei", "shiritori", "uno", "wordle",
)

FLUSH_EVERY_EVENTS = 5
FLUSH_INTERVAL_SECONDS = 10.0


def default_path() -> Path:
    return Path(os.environ.get("GAME_RESTORE_DATA_PATH") or _DEFAULT_PATH)


def _empty_data() -> dict[str, dict[str, Any]]:
    return {name: {} for name in GAME_IDS}


class GameRestoreStore:
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
                "game_restore: %s の読み込みに失敗しました。壊れたファイルを退避して続行します",
                self._path,
            )
            try:
                os.replace(
                    self._path,
                    self._path.with_name(self._path.name + f".broken-{int(time.time())}"),
                )
            except OSError:
                logger.debug("game_restore: 壊れたファイルの退避に失敗しました", exc_info=True)
            return _empty_data()
        if not isinstance(raw, dict):
            return _empty_data()
        data = _empty_data()
        for name in GAME_IDS:
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
            logger.exception("game_restore: 状態の保存に失敗しました path=%s", self._path)

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
    def section(self, game_id: str) -> dict[str, Any]:
        """ゲーム単位のセクション全体のコピーを返す。"""
        with self._lock:
            return copy.deepcopy(self._data.get(game_id, {}))

    def get_entry(self, game_id: str, channel_id: int) -> dict[str, Any] | None:
        with self._lock:
            value = self._data.get(game_id, {}).get(str(channel_id))
            return copy.deepcopy(value) if isinstance(value, dict) else None

    # ------------------------------------------------------------------ 変更
    def set_entry(self, game_id: str, channel_id: int, value: dict[str, Any] | None) -> None:
        """1エントリを設定する。``value`` が None なら削除（復旧後の掃除もこれで行う）。"""
        if game_id not in GAME_IDS:
            raise ValueError(f"unknown game_restore game_id: {game_id}")
        with self._lock:
            bucket = self._data[game_id]
            if value is None:
                if str(channel_id) not in bucket:
                    return
                del bucket[str(channel_id)]
            else:
                bucket[str(channel_id)] = copy.deepcopy(value)
            self._mark_dirty()


_store: GameRestoreStore | None = None
_store_lock = threading.Lock()


def get_store() -> GameRestoreStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = GameRestoreStore()
        return _store


def reset_store(path: Path | str | None = None) -> GameRestoreStore:
    """シングルトンを作り直す（テスト・保存先切り替え用）。"""
    global _store
    with _store_lock:
        _store = GameRestoreStore(path)
        return _store


# ----------------------------------------------------------------------
# cog から使う薄いヘルパー（失敗は握ってログだけ残す）
# ----------------------------------------------------------------------

def save_session(game_id: str, channel_id: int, guild_id: int | None,
                 state: dict[str, Any]) -> None:
    """対局のチェックポイントを保存する。"""
    try:
        entry = {
            "game": game_id,
            "channel_id": int(channel_id),
            "guild_id": int(guild_id) if guild_id is not None else None,
            "saved_at": time.time(),
            "state": copy.deepcopy(state),
        }
        store = get_store()
        store.set_entry(game_id, int(channel_id), entry)
        store.maybe_flush()
    except Exception:
        logger.debug("game_restore: %s (channel %s) のスナップショット保存に失敗しました",
                     game_id, channel_id, exc_info=True)


def clear_session(game_id: str, channel_id: int) -> None:
    """対局終了時・復旧できなかったときの掃除。"""
    try:
        store = get_store()
        store.set_entry(game_id, int(channel_id), None)
        store.maybe_flush()
    except Exception:
        logger.debug("game_restore: %s (channel %s) のスナップショット削除に失敗しました",
                     game_id, channel_id, exc_info=True)


def session_entries(game_id: str) -> dict[int, dict[str, Any]]:
    """保存済みエントリを ``{channel_id: entry}`` で返す（壊れたキーは読み飛ばす）。"""
    try:
        section = get_store().section(game_id)
    except Exception:
        logger.debug("game_restore: %s のスナップショット読み込みに失敗しました",
                     game_id, exc_info=True)
        return {}
    entries: dict[int, dict[str, Any]] = {}
    for key, value in section.items():
        if not isinstance(value, dict):
            continue
        try:
            channel_id = int(key)
        except (TypeError, ValueError):
            continue
        entries[channel_id] = value
    return entries


def flush_store() -> None:
    try:
        get_store().flush()
    except Exception:
        logger.debug("game_restore: スナップショットの保存に失敗しました", exc_info=True)


def member_ref(member) -> dict[str, Any]:
    """保存用にプレイヤーの ID と表示名だけを抜き出す。"""
    return {
        "id": int(getattr(member, "id", 0) or 0),
        "name": getattr(member, "display_name", None) or getattr(member, "name", None) or "",
    }


def resolve_member(guild, user_id, name: str | None = None):
    """プレイヤーを guild から引き直す。見つからなければ保存した名前で代替する。

    代替は mention / display_name / id だけを持つ軽いオブジェクトで、
    ゲーム側の表示（mention）と手番判定（id）はそのまま動く。
    """
    if user_id:
        get_member = getattr(guild, "get_member", None)
        member = get_member(user_id) if callable(get_member) else None
        if member is not None:
            return member
    display = name or "だれか"
    return types.SimpleNamespace(
        id=user_id or 0,
        name=display,
        display_name=display,
        mention=f"<@{user_id or 0}>",
        bot=False,
    )
