"""連携広告枠の共通部品。

連携クリエイティブ（パートナー／自社の告知）を1か所で管理し、
表示面（いまは boardNotify RTA の記録表示）が順送りで1件ずつ出す。

外部の連携先が決まったら、CREATIVES に1件足すだけで差し替え・追加できる。
表示の責務は呼び出し側にあり、ここでは「次に表示するクリエイティブ」と
「ギルドごとの広告枠 ON/OFF（デフォルト ON）」だけを提供する。

ON/OFF の保存先は guild_settings の "boardnotify" セクション
（キー ads_enabled）。DB マイグレーションは不要。
"""
from __future__ import annotations

import itertools
import logging
from dataclasses import dataclass

from core.support import guild_settings

logger = logging.getLogger(__name__)

SECTION = "boardnotify"
ADS_ENABLED_KEY = "ads_enabled"

FIELD_NAME = "連携"


@dataclass(frozen=True)
class Creative:
    name: str   # 連携先の名前（テスト・運用での識別用）
    text: str   # 表示する短いテキスト1行
    url: str    # リンク先


# 初期枠は自社（ハウス）告知で埋める。外部の連携先が決まったら
# ここへ Creative を追加すれば、そのままローテーションに乗る。
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

_counter = itertools.count()


def pick_creative() -> Creative | None:
    """次のクリエイティブを順送りで返す（全件を一巡してラップする）。

    クリエイティブが1件も無い場合は None（呼び出し側は枠自体を出さない）。
    選択は呼び出し時点（＝投稿時点）で固定され、再描画では変わらない。
    """
    if not CREATIVES:
        return None
    return CREATIVES[next(_counter) % len(CREATIVES)]


def ad_field(creative: Creative | None) -> tuple[str, str] | None:
    """embed 用の (フィールド名, 値) を返す。値側はクリッカブルなリンク。"""
    if creative is None:
        return None
    return FIELD_NAME, f"[{creative.text}]({creative.url})"


def next_ad_field() -> tuple[str, str] | None:
    """次に表示する広告枠フィールド（無ければ None）。"""
    return ad_field(pick_creative())


async def ads_enabled(guild_id) -> bool:
    """そのギルドで広告枠を出すか（デフォルト ON、読み取り失敗時も ON）。"""
    if guild_id is None:
        return True
    try:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        section = store.get(guild_id, SECTION)
    except Exception:
        logger.debug("広告枠設定の読み取りに失敗（ON として続行）", exc_info=True)
        return True
    if isinstance(section, dict):
        value = section.get(ADS_ENABLED_KEY)
        if isinstance(value, bool):
            return value
    return True


async def set_ads_enabled(guild_id, enabled: bool) -> None:
    store = guild_settings.get_store()
    await store.update(guild_id, SECTION, **{ADS_ENABLED_KEY: bool(enabled)})
