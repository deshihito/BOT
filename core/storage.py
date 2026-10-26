"""小さなキー・バリューの保存先（Supabase のテーブル ``bot_kv``、使えなければローカルの JSON ファイル）。

ラズパイは git から自動で更新されるため、ローカルのファイルは消えることがある。そこで本命は Supabase に置き、
Supabase が未設定・テーブルがまだ無い・通信エラーのときはローカルの JSON ファイルに切り替える（落ちない）。
ローカルのファイルには常に同じ内容を書いておく（Supabase が一時的に使えないときの控え）。

まだ Supabase に送れていない変更は、同じファイルの ``__pending__`` に残す。起動時に読み直しても
未送信の値を古いリモート値で上書きせず、再接続後に送り直す。同じキーへの set / delete は 1 本の順序で送るので、
遅い古い保存が新しい保存や削除を打ち消すことはない。

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
import weakref
from typing import Any, Callable

logger = logging.getLogger(__name__)

TABLE = "bot_kv"
DEFAULT_PATH = "bot_kv.json"
REMOTE_TIMEOUT = 10.0
PAGE_SIZE = 1000
RETRY_DELAY = 5.0
MAX_RETRY_DELAY = 60.0
FLUSH_TIMEOUT = 5.0
PENDING_SECTION = "__pending__"

_MISSING = object()
_file_locks: dict[str, threading.Lock] = {}
_instances: weakref.WeakSet = weakref.WeakSet()


def _lock_for(path: str) -> threading.Lock:
    return _file_locks.setdefault(os.path.abspath(path), threading.Lock())


def is_missing_table(error: Exception) -> bool:
    """テーブルが無いことを表すエラーか（PostgREST の PGRST205 / Postgres の 42P01 など）。"""
    text = f"{getattr(error, 'code', '')} {getattr(error, 'message', '')} {error}"
    return any(s in text for s in ("PGRST205", "42P01", "does not exist", "Could not find the table"))


class KVStore:
    def __init__(self, namespace: str, *, client: Any = _MISSING, path: str | None = None,
                 timeout: float = REMOTE_TIMEOUT, retry_delay: float = RETRY_DELAY,
                 max_retry_delay: float = MAX_RETRY_DELAY):
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
        self.retry_delay = retry_delay
        self.max_retry_delay = max_retry_delay
        self._remote_disabled = False   # テーブルが無いときは、再起動まで Supabase を使わない
        self._warned = False
        # key -> {"value": ...} または {"deleted": True}。まだ Supabase に届いていない最新の変更。
        self._pending: dict[str, dict[str, Any]] = self._load_pending()
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()
        self._retry_task: asyncio.Task | None = None
        self._local_versions: dict[str, int] = {}
        _instances.add(self)

    # ------------------------------------------------------------ 状態
    @property
    def remote_enabled(self) -> bool:
        return self.client is not None and not self._remote_disabled

    @property
    def has_pending(self) -> bool:
        """Supabase にまだ送れていない変更があるか。"""
        return bool(self._pending)

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

    async def _wait_for_thread(self, future: asyncio.Future) -> bool:
        """to_thread の処理が終わるまで待つ。待っている間にキャンセルされたら True。

        スレッドはキャンセルできない。ここで待たずにロックを手放すと、遅れて届いた古い
        書き込みが新しい書き込みの後着になる。待機中にさらにキャンセルされても、実際に
        終わるまでは待ち続ける。
        """
        cancelled = False
        while True:
            if future.done():
                break
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                cancelled = True
                continue
            except Exception:
                break
        if not future.cancelled():
            try:
                future.exception()
            except Exception:
                pass
        return cancelled

    async def _run(self, build: Callable[[], Any]):
        def call():
            return build().execute()

        future = asyncio.ensure_future(asyncio.to_thread(call))
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=self.timeout)
        except asyncio.TimeoutError:
            if await self._wait_for_thread(future):
                raise asyncio.CancelledError from None
            raise
        except asyncio.CancelledError:
            await self._wait_for_thread(future)
            raise

    def _row(self, key: str, value: Any) -> dict[str, Any]:
        return {
            "namespace": self.namespace, "key": key, "value": value,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    async def _upsert_remote(self, key: str, value: Any) -> None:
        row = self._row(key, value)
        await self._run(lambda: self.client.table(TABLE).upsert(row, on_conflict="namespace,key"))

    async def _delete_remote(self, key: str) -> None:
        await self._run(
            lambda: self.client.table(TABLE).delete()
            .eq("namespace", self.namespace).eq("key", key)
        )

    def _lock_for_key(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _write_key(self, key: str) -> bool:
        """このキーの未送信値を、いまの最新の内容で書き込む。成功したら True。

        同じキーの書き込みはこのロックで 1 本に並ぶ。書いている間に新しい値が来たら、
        その値を続けて書く（古い値で終わらせない）。
        """
        while True:
            async with self._lock_for_key(key):
                pending = self._pending.get(key)
                if pending is None:
                    return True
                if not self.remote_enabled:
                    return False
                deleted = bool(pending.get("deleted"))
                try:
                    if deleted:
                        await self._delete_remote(key)
                    else:
                        await self._upsert_remote(key, pending.get("value"))
                except Exception as error:
                    self._remote_failed("削除" if deleted else "保存", error)
                    return False
                if self._pending.get(key) is pending:
                    self._pending.pop(key, None)
                    self._persist_pending()
                    return True

    async def _write_in_background(self, key: str) -> None:
        if not await self._write_key(key):
            self._schedule_retry()

    def _schedule_retry(self) -> None:
        if not self._pending or not self.remote_enabled:
            return
        if self._retry_task is not None and not self._retry_task.done():
            return
        self._retry_task = self._spawn(self._retry_loop())

    async def _retry_loop(self) -> None:
        delay = self.retry_delay
        while self._pending and self.remote_enabled:
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.max_retry_delay)
            for key in list(self._pending):
                if not self.remote_enabled:
                    return
                if not await self._write_key(key):
                    break

    async def flush(self, timeout: float = FLUSH_TIMEOUT) -> bool:
        """未送信の変更を今すぐ送る。時間内に全部送れたら True。"""
        if not self._pending:
            return True
        if not self.remote_enabled:
            return False
        # タイムアウトしても書き込みはキャンセルしない（送信中のスレッドは止められず、
        # 途中でロックを手放すと順序が崩れるため）。時間切れは False で知らせる。
        tasks = [self._spawn(self._write_key(key)) for key in list(self._pending)]
        done, pending = await asyncio.wait(tasks, timeout=timeout)
        if pending:
            return False
        return not self._pending and all(
            task.cancelled() is False and task.exception() is None and task.result() is True
            for task in done
        )

    async def aclose(self) -> None:
        """バックグラウンドの再送を止める（終了前の後片付け用）。"""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

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

    def _load_pending(self) -> dict[str, dict[str, Any]]:
        with _lock_for(self.path):
            data = self._read_file()
        group = data.get(PENDING_SECTION)
        raw = group.get(self.namespace) if isinstance(group, dict) else None
        pending: dict[str, dict[str, Any]] = {}
        if isinstance(raw, dict):
            for key, item in raw.items():
                if not isinstance(item, dict):
                    continue
                if item.get("deleted") is True:
                    pending[str(key)] = {"deleted": True}
                elif "value" in item:
                    pending[str(key)] = {"value": item["value"]}
        return pending

    def _persist_pending(self) -> None:
        with _lock_for(self.path):
            data = self._read_file()
            group = data.get(PENDING_SECTION)
            if not isinstance(group, dict):
                group = {}
            if self._pending:
                group[self.namespace] = self._pending
            else:
                group.pop(self.namespace, None)
            if group:
                data[PENDING_SECTION] = group
            else:
                data.pop(PENDING_SECTION, None)
            self._write_file(data)

    def _record_pending(self, key: str, item: dict[str, Any]) -> None:
        # リモートが設定されていないときは、送る先が無いのでジャーナルを作らない。
        # ただし前回の未送信が残っているなら、その最新値として更新する。
        if self.client is None and not self._pending:
            return
        self._pending[key] = item
        self._persist_pending()

    def _bump(self, key: str) -> None:
        self._local_versions[key] = self._local_versions.get(key, 0) + 1

    # ------------------------------------------------------------ 読み書き
    async def load_all(self) -> dict[str, Any]:
        """この namespace の全データ。未送信のローカル変更があればそちらを優先する。"""
        if self.remote_enabled:
            snapshot = dict(self._pending)
            versions = dict(self._local_versions)
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
                merged = dict(result)
                # 読んでいる間に送信が終わったキーも、スナップショット側の値が最新。
                for pending in (snapshot, self._pending):
                    for key, item in pending.items():
                        if item.get("deleted"):
                            merged.pop(key, None)
                        else:
                            merged[key] = item.get("value")
                # 読んでいる間に保存されたキーは、いまのローカルの値が最新。
                local_now = self.load_local()
                for key, version in self._local_versions.items():
                    if versions.get(key, 0) == version:
                        continue
                    if key in local_now:
                        merged[key] = local_now[key]
                    else:
                        merged.pop(key, None)
                self._update_local(lambda section: (section.clear(), section.update(merged)))
                if self._pending:
                    self._schedule_retry()
                return merged
        if self._pending:
            self._schedule_retry()
        return self.load_local()

    async def set(self, key: str, value: Any, *, wait: bool = True) -> None:
        key = str(key)
        self._bump(key)
        self._record_pending(key, {"value": value})
        self._update_local(lambda section: section.__setitem__(key, value))
        if not self.remote_enabled:
            return
        if wait:
            if not await self._write_key(key):
                self._schedule_retry()
        else:
            self._spawn(self._write_in_background(key))

    async def delete(self, key: str, *, wait: bool = True) -> None:
        key = str(key)
        self._bump(key)
        self._record_pending(key, {"deleted": True})
        self._update_local(lambda section: section.pop(key, None))
        if not self.remote_enabled:
            return
        if wait:
            if not await self._write_key(key):
                self._schedule_retry()
        else:
            self._spawn(self._write_in_background(key))


async def flush_all(timeout: float = FLUSH_TIMEOUT) -> bool:
    """未送信の変更を、このプロセスで作った全ストアから送る（終了前に呼ぶ）。"""
    stores = [store for store in list(_instances) if store._pending]
    if not stores:
        return True
    results = await asyncio.gather(*(store.flush(timeout=timeout) for store in stores),
                                   return_exceptions=True)
    return all(result is True for result in results)

