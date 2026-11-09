"""連携広告枠の共通部品。

連携クリエイティブ（パートナー／自社の告知）を1か所で管理し、
表示面（いまは boardNotify RTA の記録表示）が順送りで1件ずつ出す。

クリエイティブの供給元は2つ：
- ハウス枠：このファイルの定数 ``CREATIVES``（自社告知）。
- パートナー広告：Web の広告申請システムで承認された申請。
  bot_kv の ``partner_ads`` 名前空間（1申請＝1キー）に Web 側だけが書き、
  Bot は読むだけ。status の書き換え（expired / revoked への遷移）は
  Web 側の責務で、Bot は読み取り時点の判定（承認済み・期限内・対象
  ギルドが guild_registry に現存）で配信対象を決める。そのため
  Bot 退出による自動失効も、レコードを書き換えずに読み取りで効く。

配信の配分は、承認広告がある間はハウス枠を合算25%相当に間引き
（4回に1回）、残りを承認広告が均等に回す。承認広告が0件なら
ハウス枠だけの順送り（従来どおり）。

読み取りは60秒TTLのメモリキャッシュ。``pick_creative()`` は同期関数の
ため、キャッシュが古いときは裏で非同期に読み直しを予約する。
読み込みに失敗したら手元のキャッシュ（初回は空＝ハウス枠のみ）で
配信を続ける。広告の読み取り失敗で記録表示そのものが送れなくなる
ことは決してない。

広告枠は強制表示：ギルドごとの ON/OFF は無い。旧仕様で使っていた
guild_settings の "boardnotify" セクション（キー ads_enabled）は
もう読み書きしない（保存済みの値が残っていても無視される）。
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

logger = logging.getLogger(__name__)

FIELD_NAME = "連携"

PARTNER_NAMESPACE = "partner_ads"
REGISTRY_NAMESPACE = "guild_registry"

# 承認広告キャッシュの再読込間隔（秒）。GuildSettings の前例に合わせる。
CACHE_TTL_SECONDS = 60.0

# 承認広告がある間、ハウス枠を出す間隔（4回に1回＝合算25%相当）。
HOUSE_SLOT_INTERVAL = 4


@dataclass(frozen=True)
class Creative:
    name: str   # 連携先の名前（テスト・運用での識別用）
    text: str   # 表示する短いテキスト1行
    url: str    # リンク先


# ハウス枠（自社告知）。フェーズ1からの定数をそのまま残す。
CREATIVES: list[Creative] = [
    Creative(
        name="One Prompter",
        text="One Prompter — 雑な一文から、AIに通じるプロンプトへ",
        url="https://oneprompter.agobot.app",
    ),
    Creative(
        name="AGO BOT サポートサーバー",
        text="AGO BOT サポートサーバー — 質問・要望はこちら",
        url="https://discord.gg/dCAQzJUaa9",
    ),
    Creative(
        name="AGO BOT 公式サイト",
        text="AGO BOT 公式サイト — 全機能の解説と導入はこちら",
        url="https://agobot.app",
    ),
]

_slot_counter = itertools.count()
_house_counter = itertools.count()
_partner_counter = itertools.count()

# 承認広告のメモリキャッシュ（refresh_partner_ads が差し替える）。
_partner_creatives: list[Creative] = []
_partner_loaded_at: Optional[float] = None
_partner_refresh_task: Optional[asyncio.Task] = None

# テスト用: 名前空間→KV互換オブジェクト（load_all() を持つもの）の差し替え。
_kv_factory: Optional[Callable[[str], Any]] = None


def _get_kv(namespace: str) -> Any:
    if _kv_factory is not None:
        return _kv_factory(namespace)
    # core.support.storage は重い（APIクライアント等）ので遅延 import する。
    from core.support.storage import KVStore

    return KVStore(namespace)


def set_kv_factory(factory: Optional[Callable[[str], Any]]) -> None:
    """テスト用: partner_ads / guild_registry の読み取り先を差し替える。"""
    global _kv_factory
    _kv_factory = factory


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def partner_creatives_from_records(
    records: Mapping[str, Any],
    registry_guild_ids: set[str],
    *,
    now: datetime,
) -> list[Creative]:
    """申請レコード群から、配信対象の承認広告だけを Creative の列にする（純粋関数）。

    対象は「status=approved かつ expires_at が未来 かつ 対象ギルドが
    guild_registry に現存する」もの。並びはキー（申請ID）の昇順で安定させる。
    形式が壊れているレコードは黙って落とす（1件の破損で全体を止めない）。
    """
    result: list[Creative] = []
    for key in sorted(records):
        record = records[key]
        if not isinstance(record, dict):
            continue
        if record.get("status") != "approved":
            continue
        guild_id = record.get("guild_id")
        guild_id = str(guild_id) if guild_id is not None else ""
        if not guild_id or guild_id not in registry_guild_ids:
            continue
        expires_at = _parse_iso(record.get("expires_at"))
        if expires_at is None or expires_at <= now:
            continue
        text = record.get("text")
        url = record.get("url")
        if not isinstance(text, str) or not text.strip():
            continue
        if not isinstance(url, str) or not url.startswith("https://"):
            continue
        name = record.get("guild_name")
        result.append(Creative(
            name=str(name) if isinstance(name, str) and name else "パートナー",
            text=text,
            url=url,
        ))
    return result


async def refresh_partner_ads(*, force: bool = False) -> list[Creative]:
    """承認広告のキャッシュを読み直す（TTL内なら何もしない）。

    失敗しても例外は外に出さず、手元のキャッシュで配信を続ける。
    失敗時も読み直し時刻は進める（TTL間隔以上は連続で叩かない）。
    """
    global _partner_creatives, _partner_loaded_at
    now_mono = time.monotonic()
    if (
        not force
        and _partner_loaded_at is not None
        and now_mono - _partner_loaded_at < CACHE_TTL_SECONDS
    ):
        return list(_partner_creatives)
    try:
        records = await _get_kv(PARTNER_NAMESPACE).load_all()
        registry = await _get_kv(REGISTRY_NAMESPACE).load_all()
        creatives = partner_creatives_from_records(
            records if isinstance(records, dict) else {},
            set(registry.keys()) if isinstance(registry, dict) else set(),
            now=datetime.now(timezone.utc),
        )
    except Exception:
        # KVStore 側が失敗の詳細をログに残しているため、ここでは1行だけ。
        logger.warning("承認広告の読み込みに失敗しました（手元のキャッシュで配信を続けます）")
        _partner_loaded_at = now_mono
        return list(_partner_creatives)
    _partner_creatives = creatives
    _partner_loaded_at = now_mono
    return list(creatives)


def _schedule_refresh() -> None:
    """キャッシュが古ければ、裏で読み直しを予約する（同期呼び出し用）。"""
    global _partner_refresh_task
    if (
        _partner_loaded_at is not None
        and time.monotonic() - _partner_loaded_at < CACHE_TTL_SECONDS
    ):
        return
    if _partner_refresh_task is not None and not _partner_refresh_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _partner_refresh_task = loop.create_task(refresh_partner_ads())


def _pick_house() -> Creative | None:
    if not CREATIVES:
        return None
    return CREATIVES[next(_house_counter) % len(CREATIVES)]


def pick_creative() -> Creative | None:
    """次のクリエイティブを返す。

    承認広告がある間は4回に1回だけハウス枠を出し、残りは承認広告を
    均等に回す。承認広告が無い／全体が空なら従来どおりハウス枠の
    順送り（空なら None で、呼び出し側は枠自体を出さない）。
    選択は呼び出し時点（＝投稿時点）で固定され、再描画では変わらない。
    """
    _schedule_refresh()
    partners = _partner_creatives
    if partners:
        slot = next(_slot_counter)
        if slot % HOUSE_SLOT_INTERVAL != 0:
            return partners[next(_partner_counter) % len(partners)]
    return _pick_house()


def ad_field(creative: Creative | None) -> tuple[str, str] | None:
    """embed 用の (フィールド名, 値) を返す。値側はクリッカブルなリンク。"""
    if creative is None:
        return None
    return FIELD_NAME, f"[{creative.text}]({creative.url})"


def next_ad_field() -> tuple[str, str] | None:
    """次に表示する広告枠フィールド（無ければ None）。"""
    return ad_field(pick_creative())
