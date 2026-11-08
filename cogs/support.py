# -*- coding: utf-8 -*-
"""サポート系の集約入口（cogs/ 6ファイル化）。

このファイルは「目次＋登録表」に徹し、実装はすべて core/support/ 配下にある。
旧入口ファイル（cogs/auth.py など19本）はこのファイルに統合された。

対応表（機能 → 実装モジュール → Cog）:
    support本体    core/support/entry.py                        SupportCog
    allstats       core/support/allstats/cog.py                 SystemStatsCog
    auth           core/support/auth/cog.py                     VerificationCog
    clear          core/support/clear/cog.py                    ClearCog
    daily_report   core/support/daily_report/cog.py             DailyReportCog
    errorhandler   core/support/errorhandler/cog.py             ErrorHandler
    globalchat     core/support/globalchat/cog.py               GlobalChatCog
    localization   core/support/localization/cog.py             LocalizationCog
    log_viewer     core/support/log_viewer/cog.py               LogViewer
    muted          core/support/muted/cog.py                    Muted
    ngword         core/support/ngword/cog.py                   NGWord
    panel_recovery core/support/panel_recovery/cog.py           PanelRecoveryCog
    server_assist  core/support/server_assist/cog.py            ServerAssistCog
    server_setup   core/support/server_setup/cog.py             ServerSetup
    stat           core/support/stat/cog.py                     SystemInfoCog
    status_updater core/support/status_updater/cog.py           StatusUpdater
    terminal       core/support/terminal/cog.py                 TerminalCog
    ticket         core/support/ticket/cog.py                   TicketCog
    usage_stats    core/support/usage_stats/cog.py              UsageStatsCog

互換メモ:
- 旧 cogs.support / 旧各入口から import できた名前は、このファイルから
  再エクスポートする（テストのパッチ先・他モジュールからの参照を維持）。
- RECOVERY_WAIT_SECONDS はこのファイルで定義する。実装
  （core/support/panel_recovery/cog.py）は実行時にここから読み直す。
- ALLOWED_USER_IDS は terminal のものを代表として再エクスポートする
  （log_viewer にも同値の別リストがあるが、そちらは実装モジュール側に残る）。
- 並び順の制約: core/support/common.py など実装モジュールの一部は
  モジュール読み込み時に `from cogs.support import ...` で定数を引くため、
  それらの名前（auth / clear / terminal 由来）は SupportCog 本体
  （core/support/entry.py）を取り込む前にここで確定させる。
"""
from __future__ import annotations

import importlib
import logging

from discord.ext import commands

logger = logging.getLogger("cogs.support")

#: setup() で読み込みに失敗した機能 {ラベル: エラー文字列}。
#: 起動前検査（tests/test_cog_loading.py）が参照する。
FAILED_FEATURES: dict[str, str] = {}

# =====================================================================
# 基盤の名前（循環回避のため最初に確定させる）
# =====================================================================
from core.support import guild_settings  # noqa: F401  (patch("cogs.support.guild_settings.get_store") の解決先)
from core.support.guild_settings import get_store  # noqa: F401  (旧 auth/localization/server_setup 入口が再エクスポートしていた共通関数)

# auth — 実装: core/support/auth/cog.py
from core.support.auth.cog import (  # noqa: F401
    SUCCESS,
    FAILED,
    INTRO_CHANNEL_ID,
    WEBHOOK_NAME,
    PANEL_SETTINGS_ID,
    auth_settings,
    sanitize_webhook_name,
    get_intro_webhook,
    role_failure_reason,
    QuestionModal,
    VerifyView,
    VerificationCog,
    sync_category_perms,
)

# clear — 実装: core/support/clear/cog.py
from core.support.clear.cog import MAX_CLEAR, ClearCog  # noqa: F401

# terminal — 実装: core/support/terminal/cog.py
from core.support.terminal.cog import (  # noqa: F401
    ALLOWED_USER_IDS,
    TARGET_DIR,
    run_interactive_terminal,
    TerminalModal,
    TerminalView,
    TerminalCog,
    guild_list_messages,
)

# panel_recovery の定数（実装: core/support/panel_recovery/cog.py が実行時に読み直す）
# テストがこのモジュール上の定数をパッチする。
# 生存中の View が応答する見込みがある場合にだけ使う、待機の上限。
# 1.5秒の根拠: is_done() は生存中 callback の応答 HTTP が完了して初めて
# 立つため、Raspberry Pi では Discord API の往復だけで 0.4 秒を超える
# ことがある（生存パネルの誤判定→二重応答→40060 の原因）。その判定には
# 1.5秒の余裕が要る。一方、死んだパネル（応答する View が無いことが
# ViewStore で確定できる場合）は待機自体を省いて即座に再表示する。
# Discord の初回応答期限は3秒で、一律 1.5 秒待つ旧方式は高負荷時に
# 10062 (Unknown interaction) で復旧自体が失敗した（2026-11-08 実機）。
RECOVERY_WAIT_SECONDS = 1.5

# =====================================================================
# support 本体（SupportCog）— 実装: core/support/entry.py
# 旧 cogs/support.py の名前空間をそのまま引き継ぐため star で取り込む。
# =====================================================================
from core.support.entry import *  # noqa: F401,F403

# =====================================================================
# daily_report — 実装: core/support/daily_report/cog.py
# =====================================================================
from core.support.daily_report.cog import DailyReportCog  # noqa: F401

# =====================================================================
# errorhandler — 実装: core/support/errorhandler/cog.py
# =====================================================================
from core.support.errorhandler.cog import (  # noqa: F401
    permission_label,
    new_error_id,
    _permissions_text,
    prefix_usage,
    _with_usage,
    classify,
    unexpected_message,
    _cog_overrides,
    prefix_has_local_handler,
    app_has_local_handler,
    ErrorHandler,
)

# =====================================================================
# globalchat — 実装: core/support/globalchat/cog.py
# =====================================================================
from core.support.globalchat.cog import CROCK, GlobalChatCog  # noqa: F401

# =====================================================================
# localization — 実装: core/support/localization/cog.py
# =====================================================================
from core.support.localization.cog import (  # noqa: F401
    _PATCHED,
    install_discord_localization,
    LanguageSelect,
    LanguageView,
    LocalizationCog,
)

# =====================================================================
# log_viewer — 実装: core/support/log_viewer/cog.py
# （ALLOWED_USER_IDS は terminal のものを代表として上で出す）
# =====================================================================
from core.support.log_viewer.cog import (  # noqa: F401
    VALID_LEVELS,
    is_log_allowed,
    LogViewer,
)

# =====================================================================
# muted — 実装: core/support/muted/cog.py
# =====================================================================
from core.support.muted.cog import NAMESPACE, parse_guild, Muted  # noqa: F401

# =====================================================================
# ngword — 実装: core/support/ngword/cog.py
# =====================================================================
from core.support.ngword.cog import (  # noqa: F401
    COLOR,
    RECRUIT_SECONDS,
    GAME_SECONDS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    NG_WORDS,
    TIME_CHOICES,
    DEFAULT_MINUTES,
    MODES,
    NG_CHARS,
    _SMALL,
    normalize_kana,
    contains_ng_char,
    contains_ng,
    NGGame,
    PlayPanel,
    PlayView,
    NGWord,
)

# =====================================================================
# panel_recovery — 実装: core/support/panel_recovery/cog.py
# （RECOVERY_WAIT_SECONDS は基盤ブロックで定義済み）
# =====================================================================
from core.support.panel_recovery.cog import (  # noqa: F401
    CUSTOM_ID_PREFIX,
    KNOWN_ROOTS,
    FALLBACK_MESSAGE,
    build_panel,
    PanelRecoveryCog,
)

# =====================================================================
# server_assist — 実装: core/support/server_assist/cog.py
# =====================================================================
from core.support.server_assist.cog import (  # noqa: F401
    discover_features,
    has_manage_permission,
    ServerAssistCog,
)

# =====================================================================
# server_setup — 実装: core/support/server_setup/cog.py
# =====================================================================
from core.support.server_setup.cog import (  # noqa: F401
    NATION_SECTION,
    NOTIFY_LEVELS,
    NOTIFY_MAJOR,
    nation_settings,
    EMBED_COLOR,
    can_post,
    pick_welcome_channel,
    can_post_v2,
    pick_welcome_channel_v2,
    ONBOARDING_SECTION,
    WELCOME_VERSION,
    WELCOME_RESEND_GUARD,
    SITE_URL,
    SUPPORT_SERVER_URL,
    welcome_stats,
    WelcomeView,
    build_welcome_view,
    _missing,
    check_permissions,
    format_permission_report,
    check_onboarding_permissions,
    has_missing_permissions,
    format_onboarding_report,
    ServerSetup,
)

# =====================================================================
# stat — 実装: core/support/stat/cog.py
# =====================================================================
from core.support.stat.cog import SystemInfoCog  # noqa: F401

# =====================================================================
# status_updater — 実装: core/support/status_updater/cog.py
# =====================================================================
from core.support.status_updater.cog import (  # noqa: F401
    _ensure_log_output,
    STATUS_MODE,
    STATUS_SOURCE,
    TARGET_GUILD_ID,
    UPDATE_MINUTES,
    TEXT_TEMPLATE,
    _ACTIVITY_TYPES,
    truncate_text,
    StatusUpdater,
)

# =====================================================================
# ticket — 実装: core/support/ticket/cog.py
# =====================================================================
from core.support.ticket.cog import (  # noqa: F401
    TICKET_SECTION,
    TICKET_MODE_THREAD,
    TICKET_MODE_CHANNEL,
    TICKET_DELETE_OPTIONS,
    TICKET_DELETE_LABELS,
    MAX_TICKET_TYPES,
    TRANSCRIPT_LIMIT,
    _int_list,
    _normalize_types,
    parse_ticket_types,
    format_ticket_types,
    _normalize_assignments,
    build_transcript,
    get_ticket_settings,
    _ticket_embed,
    TicketPanelView,
    TicketRoomView,
    TicketModeSelect,
    TicketChannelSelect,
    TicketCategorySelect,
    TicketViewerRoleSelect,
    TicketAdvancedButton,
    TicketSettingsView,
    TicketIdsModal,
    TicketTypesModal,
    TicketTranscriptChannelSelect,
    TicketAdvancedSettingsView,
    TicketAssignView,
    TicketCog,
)

# =====================================================================
# usage_stats — 実装: core/support/usage_stats/cog.py
# =====================================================================
from core.support.usage_stats.cog import (  # noqa: F401
    _action_label,
    _started_date,
    UsageStatsCog,
)

# =====================================================================
# 登録テーブル（旧入口ファイル名の辞書順 = 従来のロード順）
# setup() は機能ごとに import して登録する。1機能の import 失敗で
# カテゴリ全体が落ちないよう、失敗はログに残して次へ進む
# （main.py が入口ファイルごとに握っていた粒度をここで再現する）。
# =====================================================================
_FEATURE_MODULES = (
    ("allstats", "core.support.allstats.cog"),
    ("auth", "core.support.auth.cog"),
    ("bot_status", "core.support.bot_status.cog"),
    ("clear", "core.support.clear.cog"),
    ("daily_report", "core.support.daily_report.cog"),
    ("errorhandler", "core.support.errorhandler.cog"),
    ("globalchat", "core.support.globalchat.cog"),
    ("localization", "core.support.localization.cog"),
    ("log_viewer", "core.support.log_viewer.cog"),
    ("muted", "core.support.muted.cog"),
    ("ngword", "core.support.ngword.cog"),
    ("panel_recovery", "core.support.panel_recovery.cog"),
    ("public_ranking", "core.support.public_ranking.cog"),
    ("server_assist", "core.support.server_assist.cog"),
    ("server_setup", "core.support.server_setup.cog"),
    ("stat", "core.support.stat.cog"),
    ("status_updater", "core.support.status_updater.cog"),
    ("support", "core.support.entry"),
    ("terminal", "core.support.terminal.cog"),
    ("ticket", "core.support.ticket.cog"),
    ("usage_stats", "core.support.usage_stats.cog"),
)


async def setup(bot: commands.Bot):
    for _label, _module_path in _FEATURE_MODULES:
        try:
            _module = importlib.import_module(_module_path)
            await _module.setup(bot)
        except Exception as _exc:  # noqa: BLE001 - 機能単位で分離する
            FAILED_FEATURES[_label] = f"{type(_exc).__name__}: {_exc}"
            logger.exception("support 機能の読み込みに失敗しました: %s", _label)


# =====================================================================
# allstats の名前だけは遅延解決する。実装モジュールが psutil 等の
# 任意依存を import するため、未導入環境でも他の機能の名前解決が
# 巻き添えにならないようにする（旧 cogs/allstats.py 入口と同じ挙動）。
# =====================================================================
_ALLSTATS_NAMES = frozenset({"FIELD_VALUE_LIMIT", "_limit_field_value", "SystemStatsCog"})


def __getattr__(name: str):
    if name in _ALLSTATS_NAMES:
        _module = importlib.import_module("core.support.allstats.cog")
        return getattr(_module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
