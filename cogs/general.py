# -*- coding: utf-8 -*-
"""汎用系の集約入口（cogs/ 6ファイル化）。

このファイルは「目次＋登録表」に徹し、実装はすべて core/general/ 配下にある。
旧入口ファイル（cogs/ai.py など18本）はこのファイルに統合された。
（quick だけは独立の入口 cogs/quick.py を持つ。）

対応表（機能 → 実装モジュール → Cog）:
    general本体   core/general/entry.py                    GeneralCog
    ai            core/general/ai/cog.py                   AICog
    ai_tools      core/general/ai_tools/cog.py             AIToolsCog
    circulation   core/general/circulation/cog.py          CirculationCog
    d1_test       core/general/d1_test/cog.py              D1TestCog
    gauge         core/general/gauge/cog.py                Gauge
    garden        core/general/garden/cog.py               GardenCog
    ggrks         core/general/ggrks/cog.py                GoogleSearch
    imakita       core/general/imakita/cog.py              ImakitaSummaryCog
    items         core/general/items/cog.py                ItemsCog
    judge_comment core/general/judge_comment/cog.py        JudgeCommentCog
    judgement     core/general/judgement/cog.py            JudgeCog
    market        core/general/market/cog.py               MarketCog
    money_panel   core/general/money_panel/cog.py          MoneyPanelCog
    mood          core/general/mood/cog.py                 MoodAnalysis
    omikuji       core/general/omikuji/cog.py              OmikujiCog
    role_shop     core/general/role_shop/cog.py            RoleShopCog
    wallet        core/general/wallet/cog.py               WalletCog
    weather       core/general/weather/cog.py              WeatherCog
    whisper       core/general/whisper/cog.py              WhisperCog
    workshop      core/general/workshop/cog.py             WorkshopCog

互換メモ:
- 旧 cogs.general / 旧各入口から import できた名前は、このファイルから
  再エクスポートする（テストのパッチ先・他モジュールからの参照を維持）。
  機能間で同名の私的ヘルパー（_wrap 等）は代表の1つだけを出し、残りは
  実装モジュール側に残る。
- CHART_PATH / CHART_FONT_PATH の定義は market の実装モジュール
  （core/general/market/cog.py）が持つ。集約後は discord.py の拡張ローダが
  集約モジュールのインスタンスを二重化し、入口で定義して入口へパッチする
  旧来の配置では実装に届かない場合があるため、実装側の所有に統一した
  （このファイルからは遅延再エクスポートする）。
- 各機能の名前は遅延解決（モジュール __getattr__）。理由は2つ:
  (1) ai / imakita / judgement / mood の実装は bs4 / groq / pydantic 等の
      任意依存を import するため、未導入環境でも他の機能の名前解決が
      巻き添えにならない（旧入口でも未導入環境ではその機能だけが落ちていた）。
  (2) カテゴリをまたぐ循環の回避。実装モジュール同士は cogs.general /
      cogs.support を経由して参照し合うため、集約入口のトップレベルで
      機能モジュールを一括 import すると循環 import になる。
- setup() は機能ごとに import して登録する。失敗した機能は FAILED_FEATURES
  に記録し、ログに残して次へ進む（main.py が入口ファイルごとに握っていた
  障害分離の再現。tests/test_cog_loading.py が FAILED_FEATURES を検査する）。
- 並び順の制約: market の実装が読み込み時に `from cogs.general import
  INSUFFICIENT` と引くため、wallet の名前は本体取り込みより前に確定させる。
"""
from __future__ import annotations

import importlib
import logging

from discord.ext import commands

logger = logging.getLogger("cogs.general")

#: setup() で読み込みに失敗した機能 {ラベル: エラー文字列}。
#: 起動前検査（tests/test_cog_loading.py）が参照する。
FAILED_FEATURES: dict[str, str] = {}

# =====================================================================
# 基盤の名前（循環回避のため最初に確定させる）
# wallet — 実装: core/general/wallet/cog.py
# =====================================================================
from core.general.wallet.cog import (  # noqa: F401
    COIN_SETTER_USER_ID,
    NEW_USER_BALANCE,
    read_user_balance,
    BALANCE_UPDATE_ATTEMPTS,
    INSUFFICIENT,
    COIN_PATH,
    COIN_FILENAME,
    COIN_COLOR,
    coin_embed,
    WalletCog,
)

# =====================================================================
# general 本体（GeneralCog）— 実装: core/general/entry.py
# 旧 cogs/general.py の名前空間をそのまま引き継ぐため star で取り込む。
# =====================================================================
from core.general.entry import *  # noqa: F401,F403

# =====================================================================
# 登録テーブル（旧入口ファイル名の辞書順 = 従来のロード順）
# =====================================================================
_FEATURE_MODULES = (
    ("ai", "core.general.ai.cog"),
    ("ai_tools", "core.general.ai_tools.cog"),
    ("circulation", "core.general.circulation.cog"),
    ("d1_test", "core.general.d1_test.cog"),
    ("gauge", "core.general.gauge.cog"),
    ("garden", "core.general.garden.cog"),
    ("general", "core.general.entry"),
    ("ggrks", "core.general.ggrks.cog"),
    ("imakita", "core.general.imakita.cog"),
    ("items", "core.general.items.cog"),
    ("judge_comment", "core.general.judge_comment.cog"),
    ("judgement", "core.general.judgement.cog"),
    ("market", "core.general.market.cog"),
    ("money_panel", "core.general.money_panel.cog"),
    ("mood", "core.general.mood.cog"),
    ("omikuji", "core.general.omikuji.cog"),
    ("role_shop", "core.general.role_shop.cog"),
    ("wallet", "core.general.wallet.cog"),
    ("weather", "core.general.weather.cog"),
    ("whisper", "core.general.whisper.cog"),
    ("workshop", "core.general.workshop.cog"),
)


async def setup(bot: commands.Bot):
    for _label, _module_path in _FEATURE_MODULES:
        try:
            _module = importlib.import_module(_module_path)
            await _module.setup(bot)
        except Exception as _exc:  # noqa: BLE001 - 機能単位で分離する
            FAILED_FEATURES[_label] = f"{type(_exc).__name__}: {_exc}"
            logger.exception("general 機能の読み込みに失敗しました: %s", _label)


# =====================================================================
# 遅延解決する名前（基盤 wallet と本体以外の全機能）
# =====================================================================
_LAZY_FEATURE_MODULES = {
    "AICog": "core.general.ai.cog",
    "AIToolsCog": "core.general.ai_tools.cog",
    "AIToolsConfirmView": "core.general.ai_tools.cog",
    "AIToolsParamCompletionView": "core.general.ai_tools.cog",
    "AIToolsParamModal": "core.general.ai_tools.cog",
    "BALANCE_UPDATE_ATTEMPTS": "core.general.wallet.cog",
    "BOX_ID": "core.general.items.cog",
    "BuyLotteryView": "core.general.circulation.cog",
    "BuyMachineView": "core.general.workshop.cog",
    "CATEGORIES": "core.general.money_panel.cog",
    "CHART_FONT_PATH": "core.general.market.cog",
    "CHART_PATH": "core.general.market.cog",
    "CATEGORY_LABELS": "core.general.money_panel.cog",
    "CHART_FILENAME": "core.general.market.cog",
    "CIRCULATION_COLOR": "core.general.circulation.cog",
    "COIN_COLOR": "core.general.wallet.cog",
    "COIN_FILENAME": "core.general.wallet.cog",
    "COIN_PATH": "core.general.wallet.cog",
    "COIN_SETTER_USER_ID": "core.general.wallet.cog",
    "COOLDOWN_SECONDS": "core.general.imakita.cog",
    "COUNTER_SECONDS": "core.general.gauge.cog",
    "CirculationCog": "core.general.circulation.cog",
    "CraftView": "core.general.workshop.cog",
    "D1TestCog": "core.general.d1_test.cog",
    "DEFAULT_D1_ENDPOINT": "core.general.d1_test.cog",
    "DeleteProductView": "core.general.role_shop.cog",
    "FAILURE_MESSAGE": "core.general.imakita.cog",
    "GAME_ID": "core.general.gauge.cog",
    "GENERIC_FAILURE_MESSAGE": "core.general.ai_tools.cog",
    "GUESS_SECONDS": "core.general.gauge.cog",
    "GamePanelView": "core.general.gauge.cog",
    "GardenCog": "core.general.garden.cog",
    "Gauge": "core.general.gauge.cog",
    "GaugeGame": "core.general.gauge.cog",
    "GoogleSearch": "core.general.ggrks.cog",
    "HINT_SECONDS": "core.general.gauge.cog",
    "HISTORY_AUTO_DEFAULT": "core.general.ai.cog",
    "HISTORY_AUTO_MAX": "core.general.ai.cog",
    "HISTORY_JUDGE_PROMPT": "core.general.ai.cog",
    "HISTORY_LIMIT": "core.general.imakita.cog",
    "HintModal": "core.general.gauge.cog",
    "INSUFFICIENT": "core.general.wallet.cog",
    "ITEMS_COLOR": "core.general.items.cog",
    "ITEM_INVALID_INPUT": "core.general.items.cog",
    "ITEM_NOT_FOUND": "core.general.items.cog",
    "ImakitaSummaryCog": "core.general.imakita.cog",
    "ItemAmountModal": "core.general.items.cog",
    "ItemPickView": "core.general.items.cog",
    "ItemQuantityModal": "core.general.items.cog",
    "ItemsCog": "core.general.items.cog",
    "ItemsView": "core.general.items.cog",
    "JUDGE_TYPES": "core.general.judgement.cog",
    "JudgeCog": "core.general.judgement.cog",
    "JudgeCommentCog": "core.general.judge_comment.cog",
    "LEVELS": "core.general.judgement.cog",
    "LEVEL_SCORES": "core.general.judgement.cog",
    "LOTTERY_ID": "core.general.circulation.cog",
    "LotteryView": "core.general.circulation.cog",
    "MARKET_COLOR": "core.general.market.cog",
    "MARKET_INVALID_AMOUNT": "core.general.market.cog",
    "MAX_HISTORY_CHARS": "core.general.imakita.cog",
    "MAX_HISTORY_MESSAGES": "core.general.imakita.cog",
    "MAX_PLAYERS": "core.general.gauge.cog",
    "MINING_ID": "core.general.circulation.cog",
    "MIN_PLAYERS": "core.general.gauge.cog",
    "MODEL": "core.general.imakita.cog",
    "MONEY_PANEL_COLOR": "core.general.money_panel.cog",
    "MarketCog": "core.general.market.cog",
    "MarketView": "core.general.market.cog",
    "MiningView": "core.general.circulation.cog",
    "MoneyPanelCog": "core.general.money_panel.cog",
    "MoneyPanelView": "core.general.money_panel.cog",
    "MoodAnalysis": "core.general.mood.cog",
    "OmikujiCog": "core.general.omikuji.cog",
    "NEW_USER_BALANCE": "core.general.wallet.cog",
    "RECRUIT_SECONDS": "core.general.gauge.cog",
    "RegisterModal": "core.general.role_shop.cog",
    "RegisterRoleView": "core.general.role_shop.cog",
    "RoleShopCog": "core.general.role_shop.cog",
    "RoleShopView": "core.general.role_shop.cog",
    "SCALE": "core.general.gauge.cog",
    "SHOP_COLOR": "core.general.role_shop.cog",
    "SHOP_ID": "core.general.items.cog",
    "StealTargetSelect": "core.general.circulation.cog",
    "StealView": "core.general.circulation.cog",
    "TARGET_SCORE": "core.general.gauge.cog",
    "TRIGGER_PHRASE": "core.general.imakita.cog",
    "TradeModal": "core.general.market.cog",
    "WORKSHOP_COLOR": "core.general.workshop.cog",
    "WORKSHOP_ID": "core.general.workshop.cog",
    "WeatherCog": "core.general.weather.cog",
    "WhisperCog": "core.general.whisper.cog",
    "WhisperModal": "core.general.whisper.cog",
    "WhisperView": "core.general.whisper.cog",
    "WorkshopCog": "core.general.workshop.cog",
    "WorkshopView": "core.general.workshop.cog",
    "_SESSION_LABELS": "core.general.money_panel.cog",
    "_build_rating_model": "core.general.judgement.cog",
    "_craft_embed": "core.general.workshop.cog",
    "_enabled": "core.general.ai_tools.cog",
    "_fmt_minutes": "core.general.circulation.cog",
    "_fmt_tokens": "core.general.market.cog",
    "_is_miq_trigger": "core.general.ai_tools.cog",
    "_item_name": "core.general.circulation.cog",
    "_item_pick_options": "core.general.items.cog",
    "_items_embed": "core.general.items.cog",
    "_judge_history": "core.general.ai.cog",
    "_lottery_embed": "core.general.circulation.cog",
    "_market_embed": "core.general.market.cog",
    "_mining_embed": "core.general.circulation.cog",
    "_parse_history_decision": "core.general.ai.cog",
    "_parse_param_input": "core.general.ai_tools.cog",
    "_render_chart": "core.general.market.cog",
    "_reply_without_localization": "core.general.ai.cog",
    "_resolve_invoker": "core.general.ai_tools.cog",
    "_send_item_pick": "core.general.items.cog",
    "_shop_lines": "core.general.items.cog",
    "_steal_embed": "core.general.circulation.cog",
    "_tier_lines": "core.general.workshop.cog",
    "_with_history": "core.general.ai.cog",
    "_workshop_embed": "core.general.workshop.cog",
    "ai_tools_router": "core.general.ai_tools.cog",
    "as_panel_v2": "core.general.circulation.cog",
    "circulation_action_failed": "core.general.circulation.cog",
    "coin_embed": "core.general.wallet.cog",
    "craft_action_failed": "core.general.workshop.cog",
    "edit_message_v2": "core.general.money_panel.cog",
    "edit_panel_v2": "core.general.circulation.cog",
    "gauge_panel": "core.general.gauge.cog",
    "guild_locale": "core.general.imakita.cog",
    "item_action_failed": "core.general.items.cog",
    "logfare": "core.general.ai_tools.cog",
    "market_trade_failed": "core.general.market.cog",
    "render_gauge": "core.general.gauge.cog",
    "shop_embed": "core.general.role_shop.cog",
    "status_embed": "core.general.money_panel.cog",
    "text_panel": "core.general.gauge.cog",
    "workshop_action_failed": "core.general.workshop.cog",
}


def __getattr__(name: str):
    _module_path = _LAZY_FEATURE_MODULES.get(name)
    if _module_path is not None:
        _module = importlib.import_module(_module_path)
        return getattr(_module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
