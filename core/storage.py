"""小さなキー・バリューの保存先（Supabase のテーブル ``bot_kv``、使えなければローカルの JSON ファイル）。

ラズパイは git から自動で更新されるため、ローカルのファイルは消えることがある。そこで本命は Supabase に置き、
Supabase が未設定・テーブルがまだ無い・通信エラーのときはローカルの JSON ファイルに切り替える（落ちない）。
ローカルのファイルには常に同じ内容を書いておく（Supabase が一時的に使えないときの控え）。

テーブルは docs/sql/bot_kv.sql で作る。

    store = KVStore("muted")
    data = await store.load_all()        # {key: value}
    await store.set("123", {"a": 1})
    await store.delete("123")
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import tempfile
import threading
from typing import Any, Callable

logger = logging.getLogger(__name__)

TABLE = "bot_kv"
DEFAULT_PATH = "bot_kv.json"
REMOTE_TIMEOUT = 10.0
PAGE_SIZE = 1000

_MISSING = object()
_file_locks: dict[str, threading.Lock] = {}


def _lock_for(path: str) -> threading.Lock:
    return _file_locks.setdefault(os.path.abspath(path), threading.Lock())


def is_missing_table(error: Exception) -> bool:
    """テーブルが無いことを表すエラーか（PostgREST の PGRST205 / Postgres の 42P01 など）。"""
    text = f"{getattr(error, 'code', '')} {getattr(error, 'message', '')} {error}"
    return any(s in text for s in ("PGRST205", "42P01", "does not exist", "Could not find the table"))


class KVStore:
    def __init__(self, namespace: str, *, client: Any = _MISSING, path: str | None = None,
                 timeout: float = REMOTE_TIMEOUT):
        if client is _MISSING:
            try:
                import config
                client = getattr(config, "supabase", None)
            except Exception:
                client = None
        self.namespace = namespace
        self.client = client
        self.path = path or os.getenv("BOT_KV_FILE") or DEFAULT_PATH
        self.timeout = timeout
        self._remote_disabled = False   # テーブルが無いときは、再起動まで Supabase を使わない
        self._warned = False
        self._pending_writes: dict[str, Any] = {}
        self._writer_task: asyncio.Task | None = None

    # ------------------------------------------------------------ 状態
    @property
    def remote_enabled(self) -> bool:
        return self.client is not None and not self._remote_disabled

    def _remote_failed(self, action: str, error: Exception) -> None:
        if is_missing_table(error):
            self._remote_disabled = True
        if not self._warned:
            self._warned = True
            logger.warning(
                "Supabase の %s を %s できませんでした。ローカルのファイル（%s）を使います%s: %s",
                TABLE, action, self.path,
                "（テーブルがありません。docs/sql/bot_kv.sql を実行してください）" if self._remote_disabled else "",
                error,
            )
        else:
            logger.debug("Supabase の %s を %s できませんでした: %s", TABLE, action, error)

    async def _run(self, build: Callable[[], Any]):
        def call():
            return build().execute()
        return await asyncio.wait_for(asyncio.to_thread(call), timeout=self.timeout)

    def _row(self, key: str, value: Any) -> dict[str, Any]:
        return {
            "namespace": self.namespace, "key": key, "value": value,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    async def _upsert_remote(self, key: str, value: Any) -> None:
        row = self._row(key, value)
        try:
            await self._run(lambda: self.client.table(TABLE).upsert(row, on_conflict="namespace,key"))
        except Exception as error:
            self._remote_failed("保存", error)

    async def _writer_loop(self) -> None:
        while self._pending_writes:
            key, value = next(iter(self._pending_writes.items()))
            self._pending_writes.pop(key, None)
            if not self.remote_enabled:
                self._pending_writes.clear()
                return
            await self._upsert_remote(key, value)

    def _queue_remote(self, key: str, value: Any) -> None:
        self._pending_writes[key] = value
        if self._writer_task is None or self._writer_task.done():
            self._writer_task = asyncio.create_task(self._writer_loop())

    # ------------------------------------------------------------ ローカルファイル
    def _read_file(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            logger.exception("保存ファイルを読めませんでした: %s", self.path)
            return {}
        return data if isinstance(data, dict) else {}

    def _write_file(self, data: dict) -> None:
        folder = os.path.dirname(os.path.abspath(self.path))
        try:
            fd, tmp = tempfile.mkstemp(prefix=".bot_kv_", suffix=".json", dir=folder)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except OSError:
            logger.exception("保存ファイルに書けませんでした: %s", self.path)

    def load_local(self) -> dict[str, Any]:
        with _lock_for(self.path):
            section = self._read_file().get(self.namespace)
        return dict(section) if isinstance(section, dict) else {}

    def _update_local(self, change: Callable[[dict], None]) -> None:
        with _lock_for(self.path):
            data = self._read_file()
            section = data.get(self.namespace)
            if not isinstance(section, dict):
                section = {}
            change(section)
            if section:
                data[self.namespace] = section
            else:
                data.pop(self.namespace, None)
            self._write_file(data)

    # ------------------------------------------------------------ 読み書き
    async def load_all(self) -> dict[str, Any]:
        """この namespace の全データ。Supabase が使えればそちら、だめならローカルのファイルから。"""
        if self.remote_enabled:
            try:
                result: dict[str, Any] = {}
                start = 0
                while True:
                    response = await self._run(
                        lambda s=start: self.client.table(TABLE).select("key,value")
                        .eq("namespace", self.namespace).range(s, s + PAGE_SIZE - 1)
                    )
                    rows = list(getattr(response, "data", None) or [])
                    for row in rows:
                        result[str(row["key"])] = row.get("value")
                    if len(rows) < PAGE_SIZE:
                        break
                    start += PAGE_SIZE
            except Exception as error:
                self._remote_failed("読み込み", error)
            else:
                self._update_local(lambda section: (section.clear(), section.update(result)))
                return result
        return self.load_local()

    async def set(self, key: str, value: Any, *, wait: bool = True) -> None:
        key = str(key)
        self._update_local(lambda section: section.__setitem__(key, value))
        if not self.remote_enabled:
            return
        if wait:
            await self._upsert_remote(key, value)
        else:
            self._queue_remote(key, value)

    async def delete(self, key: str) -> None:
        key = str(key)
        self._update_local(lambda section: section.pop(key, None))
        if not self.remote_enabled:
            return
        try:
            await self._run(lambda: self.client.table(TABLE).delete().eq("namespace", self.namespace).eq("key", key))
        except Exception as error:
            self._remote_failed("削除", error)
