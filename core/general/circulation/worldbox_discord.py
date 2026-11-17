"""AGO WORLD BOX の Discord 連携（ディレクトリ公開＋受信リレー）ワーカー。

ディレクトリ公開:
  国が存在する各ギルドについて、Bot が閲覧・送信できるテキストチャンネル
  一覧と、そのギルドのグローバルチャット連携チャンネルを bot_kv
  ``worldbox_discord_directory``（キー = ギルド ID）へ書く。Web はこの
  一覧から連携先を名前で選ばせる（チャンネル ID の手入力は廃止した）。

受信リレー（Discord → ゲーム内）:
  連携チャンネルへの通常ユーザー投稿をユニオン掲示（bot_kv
  ``worldbox_union_board``、キー ``union:<ギルドID>``）へ source
  "discord" で追加する。対象は「そのギルドの連携チャンネルへの直接
  投稿」のみ。グローバルチャット流用時も、他サーバーから横断リレー
  された分は webhook 投稿なので対象にならない。
  ループ防止: Bot 自身・webhook の投稿は拾わない。Bot が送信リレーで
  投稿した文面（``**名前**（WORLD BOX ユニオン）: 本文``）も拾わない。

書き込み・読み取りの失敗は警告ログのみでループを止めない。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

DIRECTORY_NAMESPACE = "worldbox_discord_directory"
NATIONS_NAMESPACE = "worldbox_nations"
UNION_SETTINGS_NAMESPACE = "worldbox_union_settings"
UNION_BOARD_NAMESPACE = "worldbox_union_board"

DIRECTORY_INTERVAL_SECONDS = 300.0
MAX_CHANNELS = 100
# Web 側 chat.ts の保持規則に合わせる（掲示は24時間・最大50件）。
BOARD_LIMIT = 50
BOARD_TTL_MS = 24 * 60 * 60 * 1000
TEXT_MAX = 120
NAME_MAX = 24
# 連携設定とディレクトリのメモリキャッシュ（受信判定用）。
LINK_CACHE_SECONDS = 60.0

_CHANNEL_ID_RE = re.compile(r"^\d{17,20}$")
_RELAY_FORMAT_RE = re.compile(r"^\*\*.+\*\*（WORLD BOX ユニオン）: ", re.DOTALL)
_MENTION_PATTERNS = [
    re.compile(r"<@!?\d+>"),
    re.compile(r"<@&\d+>"),
    re.compile(r"<#\d+>"),
]
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _as_obj(raw: Any) -> Any:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return None
    return raw


def build_directory_entry(
    channels: list[dict[str, Any]],
    global_channel_ids: set[str],
    now_ms: int,
) -> dict[str, Any]:
    """ディレクトリ1件分を組み立てる（channels は閲覧・送信可のみ、順序維持）。"""
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    global_id: str | None = None
    for ch in channels:
        cid = ch.get("id")
        name = ch.get("name")
        if not isinstance(cid, str) or not _CHANNEL_ID_RE.match(cid) or cid in seen:
            continue
        seen.add(cid)
        result.append({"id": cid, "name": name[:100] if isinstance(name, str) and name else cid})
        if global_id is None and cid in global_channel_ids:
            global_id = cid
        if len(result) >= MAX_CHANNELS:
            break
    return {"channels": result, "globalChatChannelId": global_id, "updatedAt": now_ms}


def parse_nation_guild_ids(raw: Any) -> set[str]:
    """worldbox_nations の "nations" 値から国が存在するギルド ID 集合を取る。"""
    data = _as_obj(raw)
    if not isinstance(data, dict):
        return set()
    inner = data.get("nations")
    if not isinstance(inner, dict):
        return set()
    return {k for k in inner if isinstance(k, str) and k.isdigit()}


def parse_union_link(raw: Any) -> tuple[str, str | None]:
    """連携設定を (mode, channelId) に解釈する。旧形式 chatChannelId も読む。"""
    data = _as_obj(raw)
    if not isinstance(data, dict):
        return ("none", None)
    mode = data.get("mode")
    if mode == "global":
        return ("global", None)
    if mode == "channel":
        cid = data.get("channelId")
        if isinstance(cid, str) and _CHANNEL_ID_RE.match(cid):
            return ("channel", cid)
        return ("none", None)
    if mode == "none":
        return ("none", None)
    legacy = data.get("chatChannelId")
    if isinstance(legacy, str) and _CHANNEL_ID_RE.match(legacy):
        return ("channel", legacy)
    return ("none", None)


def parse_directory_entry(raw: Any) -> dict[str, Any] | None:
    data = _as_obj(raw)
    if not isinstance(data, dict) or not isinstance(data.get("channels"), list):
        return None
    return data


def resolve_receive_channel_id(
    link: tuple[str, str | None], directory: dict[str, Any] | None
) -> str | None:
    """受信リレーの対象チャンネル ID。連携なし・解決不能なら None。"""
    mode, channel_id = link
    if mode == "channel":
        return channel_id
    if mode == "global":
        if directory is None:
            return None
        gid = directory.get("globalChatChannelId")
        return gid if isinstance(gid, str) and _CHANNEL_ID_RE.match(gid) else None
    return None


def is_relay_text(text: str) -> bool:
    """Bot の送信リレー文面かどうか（受信で拾い直さないための識別）。"""
    return bool(_RELAY_FORMAT_RE.match(text or ""))


def sanitize_relay_text(text: str) -> str:
    """メンション無効化相当のサニタイズをして掲示本文にする。空なら ""。"""
    if not isinstance(text, str):
        return ""
    cleaned = text
    for pattern in _MENTION_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    cleaned = cleaned.replace("@everyone", "everyone").replace("@here", "here")
    cleaned = _CONTROL_RE.sub(" ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:TEXT_MAX]


def parse_board(raw: Any) -> list[dict[str, Any]]:
    """保存済みユニオン掲示を読む。壊れたエントリは落とす。"""
    data = _as_obj(raw)
    if not isinstance(data, list):
        return []
    board: list[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        if entry.get("channel") != "union":
            continue
        if not isinstance(entry.get("id"), str) or not entry.get("id"):
            continue
        if not isinstance(entry.get("text"), str) or not entry.get("text"):
            continue
        at = entry.get("at")
        if not isinstance(at, (int, float)) or at <= 0:
            continue
        board.append(entry)
    return board


def build_board_entry(
    *, message_id: str, guild_id: str, name: str, text: str, at_ms: int
) -> dict[str, Any]:
    """Web の ChatMessage と同形の掲示エントリ（source "discord"）。"""
    return {
        "id": f"discord:{message_id}",
        "channel": "union",
        "name": (name or "プレイヤー")[:NAME_MAX],
        "text": text,
        "at": at_ms,
        "x": 0,
        "y": 0,
        "space": "world",
        "guildId": guild_id,
        "source": "discord",
    }


def append_board_entry(
    board: list[dict[str, Any]], entry: dict[str, Any], now_ms: int
) -> list[dict[str, Any]]:
    """重複を除いて追記し、保持期間・件数で間引いて新しい順に返す。"""
    merged = [e for e in board if e.get("id") != entry["id"]]
    merged.append(entry)
    fresh = [e for e in merged if now_ms - float(e.get("at", 0)) <= BOARD_TTL_MS]
    fresh.sort(key=lambda e: float(e.get("at", 0)), reverse=True)
    return fresh[:BOARD_LIMIT]


class WorldBoxDiscordWorker:
    """ディレクトリ公開と受信リレーを担うワーカー。"""

    def __init__(
        self,
        *,
        directory_kv: Any,
        nations_kv: Any,
        settings_kv: Any,
        board_kv: Any,
        guild_channels_provider: Callable[[], list[tuple[str, list[dict[str, Any]]]]],
        global_channel_ids_provider: Callable[[], set[str]],
    ) -> None:
        # kv: core.support.storage.KVStore（load_one / set を使う）
        self._directory_kv = directory_kv
        self._nations_kv = nations_kv
        self._settings_kv = settings_kv
        self._board_kv = board_kv
        # guild_channels_provider() -> [(guild_id, [{id, name}, ...]), ...]
        self._guild_channels_provider = guild_channels_provider
        self._global_channel_ids_provider = global_channel_ids_provider
        self._remote_down = False
        # guild_id -> (取得時刻ms, link, directory)
        self._link_cache: dict[str, tuple[int, tuple[str, str | None], dict[str, Any] | None]] = {}
        # 掲示の read-modify-write をギルド単位で直列化するロック。
        # on_message は投稿ごとに並行して走るため、ロック無しでは
        # 同時投稿の後勝ちで先のエントリが欠落する（lost-update）。
        # Web 側も同じキーを書くが bot_kv に CAS が無いため、プロセスを
        # またぐ同時書きの窓は残る（Web 側も自プロセス内は直列化済み）。
        self._board_locks: dict[str, asyncio.Lock] = {}

    async def publish_directory_once(self) -> int:
        """国が存在する全ギルドのディレクトリを書き直す。公開した件数を返す。"""
        try:
            nations_raw = await self._nations_kv.load_one("nations")
        except Exception:
            if not self._remote_down:
                logger.warning("worldbox discord: 国家データの読み取りに失敗しました（次回再試行）")
            self._remote_down = True
            return 0
        if self._remote_down:
            logger.info("worldbox discord: bot_kv への接続が回復しました")
            self._remote_down = False
        guild_ids = parse_nation_guild_ids(nations_raw)
        if not guild_ids:
            return 0
        try:
            global_ids = self._global_channel_ids_provider()
        except Exception:
            global_ids = set()
        try:
            guild_channels = self._guild_channels_provider()
        except Exception:
            # 巡回本体の失敗で tasks.loop ごと止まる（無言死）とディレクトリ
            # 公開全体が死ぬ。ここで吸収し、次周期に再試行する。
            logger.exception("worldbox discord: チャンネル一覧の取得に失敗しました（次回再試行）")
            return 0
        now_ms = _now_ms()
        published = 0
        for guild_id, channels in guild_channels:
            if guild_id not in guild_ids:
                continue
            entry = build_directory_entry(channels, global_ids, now_ms)
            try:
                await self._directory_kv.set(guild_id, json.dumps(entry))
                published += 1
            except Exception:
                logger.warning("worldbox discord: ディレクトリ公開に失敗しました（guild=%s）", guild_id)
        return published

    async def _load_link(
        self, guild_id: str, now_ms: int
    ) -> tuple[tuple[str, str | None], dict[str, Any] | None]:
        cached = self._link_cache.get(guild_id)
        if cached is not None and now_ms - cached[0] < LINK_CACHE_SECONDS * 1000:
            return cached[1], cached[2]
        try:
            settings_raw = await self._settings_kv.load_one(guild_id)
            directory_raw = await self._directory_kv.load_one(guild_id)
        except Exception:
            return ("none", None), None
        link = parse_union_link(settings_raw)
        directory = parse_directory_entry(directory_raw)
        self._link_cache[guild_id] = (now_ms, link, directory)
        return link, directory

    async def handle_message(self, snapshot: dict[str, Any]) -> bool:
        """Discord の投稿スナップショットを判定し、対象なら掲示へ追加する。"""
        if snapshot.get("author_is_bot") or snapshot.get("is_webhook"):
            return False
        guild_id = snapshot.get("guild_id")
        channel_id = snapshot.get("channel_id")
        content = snapshot.get("content")
        if not isinstance(guild_id, str) or not isinstance(channel_id, str):
            return False
        if not isinstance(content, str) or is_relay_text(content):
            return False
        now_ms = _now_ms()
        link, directory = await self._load_link(guild_id, now_ms)
        target = resolve_receive_channel_id(link, directory)
        if target is None or target != channel_id:
            return False
        text = sanitize_relay_text(content)
        if not text:
            return False
        at_ms = snapshot.get("at_ms")
        entry = build_board_entry(
            message_id=str(snapshot.get("message_id") or ""),
            guild_id=guild_id,
            name=str(snapshot.get("author_name") or ""),
            text=text,
            at_ms=int(at_ms) if isinstance(at_ms, (int, float)) and at_ms > 0 else now_ms,
        )
        if entry["id"] == "discord:":
            return False
        board_key = f"union:{guild_id}"
        lock = self._board_locks.setdefault(guild_id, asyncio.Lock())
        try:
            async with lock:
                raw = await self._board_kv.load_one(board_key)
                board = append_board_entry(parse_board(raw), entry, now_ms)
                await self._board_kv.set(board_key, json.dumps(board))
        except Exception:
            logger.warning("worldbox discord: 掲示への取り込みに失敗しました（guild=%s）", guild_id)
            return False
        return True
