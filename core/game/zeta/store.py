import discord
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from discord.ext import commands
from typing import Dict, List, Optional
import re
import os
from core.support import data_paths
from core.general import logfare
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

from core.game.zeta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.zeta.common import BotPersona, CUSTOM_FILE, DEFAULT_ICON_URL, MAX_CUSTOM_PER_USER, STRAY_CUSTOM_FILE  # noqa: F401

logger = logging.getLogger("cogs.zetamodoki")


class CustomSituationStore:
    """ユーザーごとの登録シチュエーションをJSONファイルへ保存する。"""

    def __init__(self, path: Path = CUSTOM_FILE):
        self.path = path
        self._data: dict | None = None
        self._lock: asyncio.Lock | None = None

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _root(self) -> dict:
        if self._data is None:
            self._data = self._load()
        return self._data

    def _load(self) -> dict:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/game/data/)
        # から移行読み取りする (旧パス主・正規パスはユーザー単位で補完)。
        # 環境変数や明示パスで保存先が指定されている場合は移行しない。
        if self.path == CUSTOM_FILE and not os.getenv("ZETAMODOKI_CUSTOM_PATH"):
            raw = data_paths.load_migrated(self.path, STRAY_CUSTOM_FILE, fill=True)
            if isinstance(raw, dict):
                return raw
            if raw is not None:
                return {}
            # どちらにも読めるデータが無い場合のみ従来経路に落とす
            # (壊れたファイルの退避などの従来動作を保つため)。
        data: dict = {}
        try:
            with self.path.open("r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
        except FileNotFoundError:
            pass
        except Exception:
            logger.exception("ZetaModoki: %s の読み込みに失敗しました。壊れたファイルを退避します", self.path)
            try:
                os.replace(self.path, self.path.with_name(self.path.name + f".broken-{int(time.time())}"))
            except OSError:
                logger.debug("ZetaModoki: 壊れたファイルの退避に失敗しました", exc_info=True)
        return data

    def _write(self, payload: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    async def _save(self) -> bool:
        try:
            payload = json.dumps(self._root(), ensure_ascii=False)
            await asyncio.to_thread(self._write, payload)
            return True
        except Exception:
            logger.exception("ZetaModoki: %s への保存に失敗しました", self.path)
            return False

    def list(self, user_id: int) -> list[dict]:
        entries = self._root().get(str(user_id), [])
        return [e for e in entries if isinstance(e, dict) and e.get("id")]

    def get(self, user_id: int, entry_id: str) -> dict | None:
        return next((e for e in self.list(user_id) if e["id"] == entry_id), None)

    def to_persona(self, entry: dict) -> BotPersona:
        return BotPersona(
            name=entry["name"],
            persona=entry["persona"],
            situation=entry["situation"],
            first_message=entry["first_message"],
            icon_url=entry.get("icon_url") or DEFAULT_ICON_URL,
        )

    async def _mutate(self, user_id: int, fn) -> tuple[object, str | None]:
        """fn(entries:list)->(result, error)。保存に失敗したら変更を巻き戻す。"""
        async with self._get_lock():
            root = self._root()
            snapshot = json.dumps(root, ensure_ascii=False)
            entries = list(self.list(user_id))
            result, error = fn(entries)
            if error:
                return None, error
            root[str(user_id)] = entries
            if not await self._save():
                self._data = json.loads(snapshot)
                return None, "保存に失敗しました。しばらくしてからもう一度お試しください。"
            return result, None

    async def add(self, user_id: int, fields: dict):
        def op(entries):
            if len(entries) >= MAX_CUSTOM_PER_USER:
                return None, f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。先に不要な登録を削除してください。"
            entry = {"id": uuid.uuid4().hex[:8], **fields}
            entries.append(entry)
            return entry, None
        return await self._mutate(user_id, op)

    async def update(self, user_id: int, entry_id: str, fields: dict):
        def op(entries):
            for entry in entries:
                if entry["id"] == entry_id:
                    entry.update(fields)
                    return entry, None
            return None, "対象の登録が見つかりません（すでに削除された可能性があります）。"
        return await self._mutate(user_id, op)

    async def delete(self, user_id: int, entry_id: str):
        def op(entries):
            for i, entry in enumerate(entries):
                if entry["id"] == entry_id:
                    return entries.pop(i), None
            return None, "対象の登録が見つかりません（すでに削除された可能性があります）。"
        return await self._mutate(user_id, op)
