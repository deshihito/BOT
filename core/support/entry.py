# -*- coding: utf-8 -*-
"""SupportCog 本体（旧 cogs/support.py の中身）。

入口は集約ファイル cogs/support.py で、このモジュールは SupportCog の
合成と edit_auth_panel_message を担う。cogs.support から import できる
名前は cogs/support.py がこのモジュールから再エクスポートする。
"""
from __future__ import annotations

import logging

import discord
from discord import app_commands
from discord.ext import commands

from core.support import guild_settings
from core.general import action_usage
from core.support.usage_stats import usage_stats
from core.support.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2
from core.support.common import *
from core.support.auth_panel import *
from core.support.roles import *
from core.support.logs import *
from core.support.sticky import *
from core.support.honeypot import *
from core.support.binjou import *
from core.support.panel import *
from core.support.autoreact import *
from core.support.voice_trigger import *
from core.support.sns import *
from core.support.quest import *
from core.support.levelup import *
from core.support.auth_panel import AuthSupportMixin
from core.support.roles import RoleSupportMixin
from core.support.logs import LogSupportMixin
from core.support.sticky import StickySupportMixin
from core.support.honeypot import HoneypotSupportMixin
from core.support.binjou import BinjouSupportMixin
from core.support.sns import SnsSupportMixin
from core.support.quest import QuestSupportMixin
from core.support.levelup import LevelUpSupportMixin
from core.support.vc_auto_start import *  # noqa: F401,F403
from core.support.vc_auto_start import VcAutoStartSupportMixin
from core.support.globalchat.globalchat_panel import GlobalChatSupportMixin
from core.support.bot_fixer import BotFixerSupportMixin

# 分割前の cogs.support が持っていた内部ヘルパーも互換のため再エクスポートする
import html as _html

from core.support.common import _SUPPORT_ACTION_BY_VALUE, _support_actions, _support_int
from core.support.quest import (
    _ORBS_RE,
    _QUEST_LANG_RE,
    _quest_country,
    _quest_feed_url,
    _quest_from_discord,
    _quest_http_url,
)
from core.support.sns import (
    _GH_OWNER_RE,
    _GH_REPO_RE,
    _SNS_NS,
    _X_USER_RE,
    _YT_ID_RE,
    _sns_env_int,
    _sns_github_token,
    _sns_text,
)

logger = logging.getLogger("cogs.support")  # 集約後も従来のロガー名を維持（テストの assertLogs 互換）

# 機能数再編: assist_ preset 入口 -> (元機能キー, preset 名, 案内文)。
# 汎用 assist_ 分岐に落とすと show_feature(未知キー) で失敗するため、
# dispatch では必ず汎用分岐より前に special-case する。
ASSIST_PRESET_ACTIONS = {
    "assist_reminder": (
        "timed", "reminders",
        "一回限りリマインダーは、下の「リマインダーを追加」から登録できます。",
    ),
    "assist_goodbye": (
        "welcome", "goodbye",
        "退出メッセージの設定です（送信先・文面・オン/オフ）。参加側は「参加・退出メッセージ」から変更できます。",
    ),
    "assist_embed_templates": (
        "embed", "templates",
        "埋め込みテンプレートの管理です（保存・読み込み・削除）。",
    ),
    "assist_warning_escalation": (
        "warnings", "escalation",
        "警告エスカレーション（警告が一定件数たまったときの自動処分）の設定です。",
    ),
    "assist_application_review": (
        "applications", "review",
        "応募審査まわりの設定です（レビュー先チャンネルなど）。審査自体は、レビュー先に届いた応募メッセージのボタンから行います。",
    ),
    "assist_events_link": (
        "events", "scheduled",
        "公式イベント連携（Discordのスケジュールイベントへの同期）の設定です。",
    ),
}

# boardNotify サービス別入口 -> (BumpRta の event_type, 表示名)。
BUMPRTA_SERVICE_ACTIONS = {
    "bumprta_bump": ("bump", "DISBOARD"),
    "bumprta_up": ("up", "ディス速"),
    "bumprta_vote": ("vote", "鯖ちゃんねる"),
    "bumprta_takasumi": ("takasumi", "TakasumiBOT"),
    "bumprta_dicoall": ("dicoall", "Dicoall"),
    "bumprta_dcafe": ("dcafe", "Discord Cafe"),
    "bumprta_sharkbot": ("sharkbot", "SharkBot"),
    "bumprta_dsio": ("dsio", "DiscordServers.io"),
    "bumprta_discom": ("discom", "DISCOM"),
}

# SNS プラットフォーム別入口 -> SnsNotifyPanel の platform preset。
SNS_PLATFORM_ACTIONS = {
    "sns_youtube": "youtube",
    "sns_x": "x",
    "sns_github": "github",
    "sns_rss": "rss",
}


async def edit_auth_panel_message(interaction: discord.Interaction, panel):
    """Modal後などでも設定パネルを再描画するための補助。"""
    try:
        await interaction.response.edit_message(
            content=None,
            embed=None,
            attachments=[],
            view=as_panel_v2(panel),
        )
    except discord.HTTPException:
        logger.debug("認証パネルの編集に失敗しました（再送信で代替します）", exc_info=True)
        if interaction.response.is_done():
            await interaction.followup.send(view=as_panel_v2(panel), ephemeral=True)
        else:
            await interaction.response.send_message(view=as_panel_v2(panel), ephemeral=True)


class SupportCog(
    SnsSupportMixin,
    QuestSupportMixin,
    LevelUpSupportMixin,
    AuthSupportMixin,
    RoleSupportMixin,
    LogSupportMixin,
    StickySupportMixin,
    HoneypotSupportMixin,
    BinjouSupportMixin,
    VcAutoStartSupportMixin,
    GlobalChatSupportMixin,
    BotFixerSupportMixin,
    commands.Cog,
):
    SUPPORT_REQUIRED_PERMISSIONS = {
        "muted": "manage_roles",
        "muted_settings": "manage_roles",
        "whisper": "manage_channels",
        "sticky": "manage_guild",
        "clear": "manage_messages",
        "role_bulk": "manage_roles",
        "binjou": "manage_guild",
        "binjou_custom": "manage_guild",
        "auto_react": "manage_guild",
        "giveaway": "manage_guild",
        "vc_log": "manage_guild",
        "message_log": "manage_guild",
        "moderation_log": "manage_guild",
        "honeypot": "manage_guild",
        "ticket": "manage_guild",
        "ticket_types": "manage_guild",
        "ticket_transcript": "manage_guild",
        "ticket_assign": "manage_guild",
        "auth_panel": "administrator",
        "auth_questions": "administrator",
        "role_panel": "administrator",
        "language": "manage_guild",
        "sns_notify": "administrator",
        "sns_youtube": "administrator",
        "sns_x": "administrator",
        "sns_github": "administrator",
        "sns_rss": "administrator",
        "sns_youtube_live": "administrator",
        "earthquake": "administrator",
        "quest_notify": "administrator",
        "quest_manual": "administrator",
        "levelup_notify": "manage_guild",
        "levelup_card_theme": "manage_guild",
        "vc_auto_start": "manage_guild",
        "news_notify": "manage_guild",
        "bot_fixer": "manage_guild",
        "bot_fixer_bots": "manage_guild",
        "bot_fixer_rates": "manage_guild",
        "globalchat": "manage_guild",
        "globalchat_mod": "manage_guild",
        "tempvoice_panel": "manage_guild",
        # boardNotify 再編の新 value。水準は bumprta_command 内の
        # on/off/role 分岐が要求する manage_guild に合わせる。
        "bumprta_bump": "manage_guild",
        "bumprta_up": "manage_guild",
        "bumprta_vote": "manage_guild",
        "bumprta_takasumi": "manage_guild",
        "bumprta_dicoall": "manage_guild",
        "bumprta_dcafe": "manage_guild",
        "bumprta_sharkbot": "manage_guild",
        "bumprta_dsio": "manage_guild",
        "bumprta_discom": "manage_guild",
        "bumprta_settings": "manage_guild",
        # assist preset 入口（汎用 assist_ 分岐の manage_guild と同じ水準を明示）。
        "assist_reminder": "manage_guild",
        "assist_goodbye": "manage_guild",
        "assist_embed_templates": "manage_guild",
        "assist_warning_escalation": "manage_guild",
        "assist_application_review": "manage_guild",
        "assist_events_link": "manage_guild",
        # 旧ハブ値。アクションとしては廃止し、dispatch の互換分岐（案内のみ）用に残す。
        "server_assist": "manage_guild",
        "sokunuke_status": "manage_guild",
        "sokunuke_on": "manage_guild",
        "sokunuke_off": "manage_guild",
        "sokunuke_vc_on": "manage_guild",
        "sokunuke_vc_off": "manage_guild",
        # 人物分析は一般メンバーが閲覧できる（権限要件なしを明示する）。
        # 収集トグルの変更だけ、パネル側でサーバー管理権限を要求する。
        "person_analysis": None,
        # サーバー分析も人物分析と同じ扱い（閲覧は一般メンバー可、
        # 収集トグルの変更だけパネル側でサーバー管理権限を要求する）。
        "server_analytics": None,
    }

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._sticky_locks: dict[int, asyncio.Lock] = {}
        self._panel_pending: set[int] = set()
        self._sns_locks: dict[int, asyncio.Lock] = {}
        self._http: aiohttp.ClientSession | None = None
        self._sns: SnsFetcher | None = None
        self._quest_locks: dict[int, asyncio.Lock] = {}
        self._quest: QuestFetcher | None = None


    @staticmethod
    def has_support_permission(interaction: discord.Interaction, permission: str) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "administrator", False)
            or getattr(permissions, permission, False)
        )


    async def check_support_permission(self, interaction: discord.Interaction, selected: str) -> bool:
        permission = self.SUPPORT_REQUIRED_PERMISSIONS.get(selected)
        if permission is None and selected.startswith("assist_"):
            # サーバーアシスト再編で一級アクション化した各機能。設定画面側
            # （ServerAssistCog.show_feature）でも同じ権限を要求する。
            permission = "manage_guild"

        if permission is None or self.has_support_permission(interaction, permission):
            return True

        labels = {
            "manage_guild": "サーバーの管理",
            "manage_roles": "ロールの管理",
            "manage_channels": "チャンネルの管理",
            "manage_messages": "メッセージの管理",
            "administrator": "管理者",
        }

        await interaction.response.send_message(
            f"この機能を使うには「{labels.get(permission, permission)}」権限が必要です。",
            ephemeral=True,
        )
        return False


    async def cog_load(self):
        self._http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20),
            headers={"User-Agent": SNS_USER_AGENT},
        )
        self._sns = SnsFetcher(self._http)
        self.sns_poll.start()
        self._quest = QuestFetcher(self._http)
        self.quest_poll.start()


    async def cog_unload(self):
        self.sns_poll.cancel()
        self.quest_poll.cancel()
        if self._http is not None and not self._http.closed:
            await self._http.close()


    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return

        custom_id = interaction.data.get("custom_id", "")

        if custom_id == "auth_panel:start":
            await self.handle_auth_start(interaction)
            return

        if custom_id == "role_panel:assign":
            values = interaction.data.get("values") or []
            if not values:
                return

            try:
                role_id = int(values[0])
            except (TypeError, ValueError):
                return

            await self.handle_role_panel_assign(interaction, role_id)


    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or getattr(message.author, "bot", False):
            return

        if await self._handle_honeypot_message(message):
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        auto_react = store.get(message.guild.id, AUTO_REACT_SECTION).get("channels", {})
        emojis = auto_react.get(str(message.channel.id), []) if isinstance(auto_react, dict) else []
        for emoji_value in emojis if isinstance(emojis, list) else []:
            try:
                await message.add_reaction(normalize_binjou_emoji(emoji_value))
            except (ValueError, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "Auto reactを追加できません (guild=%s channel=%s emoji=%s)",
                    message.guild.id,
                    message.channel.id,
                    emoji_value,
                )
        settings = get_sticky_settings(store, message.guild.id)

        if settings["enabled"] and settings["channel_id"] == message.channel.id:
            await self.send_sticky_panel(message.guild)


    @app_commands.command(name="support", description="サポート機能の操作パネルを表示します")
    @app_commands.guild_only()
    async def support(self, interaction: discord.Interaction):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        history_specs = action_usage.history_panel_specs(
            store, interaction.guild_id, interaction.user.id, "support")
        view = SupportPanelView(self, history_specs=history_specs,
                                owner_id=interaction.user.id)
        # 他ルートと揃えて公開で出す（導線最適化ラウンド2）。操作は
        # SupportPanelView.interaction_check で呼び出し本人に制限する。
        await interaction.response.send_message(
            view=as_panel_v2(view),
        )


    async def show_bumprta_service(self, interaction: discord.Interaction, selected: str):
        """boardNotify サービス別入口: 共通の通知状態＋次回予定＋ランキング案内。

        サービス別設定は現行に存在しないため作らず、状態は共通設定
        （BumpRta の _is_enabled / _role_id）をそのまま表示する。
        次回通知予定は BumpRta のメモリ内リマインダー（_reminders）から
        そのサービス分で最も早いものを出す。
        """
        event_type, label = BUMPRTA_SERVICE_ACTIONS[selected]
        cog = self.bot.get_cog("BumpRta")
        if cog is None:
            return await self._missing(interaction, "boardNotify")

        enabled = await cog._is_enabled(interaction.guild_id)
        role_id = await cog._role_id(interaction.guild_id)
        role_text = f"<@&{role_id}>" if role_id else "なし"

        next_text = "予定なし（次にコマンドが成功すると予約されます）"
        reminders = getattr(cog, "_reminders", {}) or {}
        due_list = [
            rem.due_ts for rem in reminders.values()
            if getattr(rem, "guild_id", None) == interaction.guild_id
            and getattr(rem, "kind", None) == event_type
        ]
        if due_list:
            due = int(min(due_list))
            next_text = f"<t:{due}:F>（<t:{due}:R>）"

        embed = discord.Embed(
            title=f"{label}（boardNotify）",
            description=(
                f"通知状態（共通）: **{'オン' if enabled else 'オフ'}**\n"
                f"メンションロール（共通）: {role_text}\n"
                f"次回通知予定: {next_text}\n\n"
                "通知のオン/オフ・メンションロールの変更は「boardNotify設定（共通）」から行えます。\n"
                f"{label} のRTAランキングは /general の「ランキング」で確認できます。"
            ),
            color=0xFFFFFF,
        )
        return await interaction.response.send_message(embed=embed, ephemeral=True)


    async def show_bumprta_settings_panel(self, interaction: discord.Interaction):
        """boardNotify 共通設定: 既存 bumprta_status の状態表示＋設定用View。

        オン/オフ・ロール設定の実処理は BumpRtaSettingsView のボタンが
        BumpRta.bumprta_command の既存分岐へ委譲する。
        """
        cog = self.bot.get_cog("BumpRta")
        if cog is None:
            return await self._missing(interaction, "boardNotify")

        enabled = await cog._is_enabled(interaction.guild_id)
        role_id = await cog._role_id(interaction.guild_id)
        role_text = f"<@&{role_id}>" if role_id else "なし"
        embed = discord.Embed(
            title="boardNotify設定（共通）",
            description=(
                f"boardNotify: **{'オン' if enabled else 'オフ'}**（初期状態: オン）"
                f"\n通知メンションロール: {role_text}"
            ),
            color=0xFFFFFF,
        )
        return await interaction.response.send_message(
            embed=embed, view=BumpRtaSettingsView(cog), ephemeral=True)


    async def dispatch(self, interaction: discord.Interaction, selected: str):
        if not await self.check_support_permission(interaction, selected):
            return

        # BOT fixer のコマンド制限（support:bot_fixer 自身と管理者は対象外）。
        from core.support import command_control

        if not await command_control.guard(interaction, f"support:{selected}"):
            return

        # 利用履歴（よく使う／最近）は権限チェックを通った実行だけを記録する。
        # 保存の書き込みで応答を遅らせないようバックグラウンド記録を使う。
        action_usage.record_safely_in_background(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"support:{selected}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"support:{selected}")

        # 機能数再編: assist preset 入口は汎用 assist_ 分岐より前に処理する
        # （汎用分岐へ落とすと show_feature(未知キー) で失敗する）。
        if selected in ASSIST_PRESET_ACTIONS:
            feature_key, preset, notice = ASSIST_PRESET_ACTIONS[selected]
            cog = self.bot.get_cog("ServerAssistCog")
            if cog is None:
                return await self._missing(interaction, "サーバーアシスト")
            show_preset = getattr(cog, "show_feature_preset", None)
            if show_preset is None:
                return await cog.show_feature(interaction, feature_key)
            return await show_preset(interaction, feature_key, preset=preset, notice=notice)

        if selected.startswith("assist_"):
            # サーバーアシスト再編: 各機能は /support の一級アクション。
            # パネル／quick・ショートカットから個別機能を直接開く。
            cog = self.bot.get_cog("ServerAssistCog")
            if cog is None:
                return await self._missing(interaction, "サーバーアシスト")
            return await cog.show_feature(interaction, selected.removeprefix("assist_"))

        if selected in BUMPRTA_SERVICE_ACTIONS:
            return await self.show_bumprta_service(interaction, selected)

        if selected == "bumprta_settings":
            return await self.show_bumprta_settings_panel(interaction)

        if selected in SNS_PLATFORM_ACTIONS:
            return await self.show_sns_notify_settings(
                interaction, platform=SNS_PLATFORM_ACTIONS[selected])

        if selected == "sns_youtube_live":
            return await self.show_sns_notify_settings(interaction, live=True)

        if selected == "bot_fixer_bots":
            return await self.show_bot_fixer_settings(interaction, preset={"area": "bot"})

        if selected == "bot_fixer_rates":
            return await self.show_bot_fixer_settings(
                interaction, preset={"area": "command", "purpose": "rates"})

        if selected == "muted_settings":
            cog = self.bot.get_cog("Muted")
            if cog is None:
                return await self._missing(interaction, "Muted")
            show_settings = getattr(cog, "show_muted_settings", None)
            if show_settings is not None:
                return await show_settings(interaction)
            return await cog.muted_setting(interaction)

        if selected in {"ticket_types", "ticket_transcript"}:
            cog = self.bot.get_cog("TicketCog")
            if cog is None:
                return await self._missing(interaction, "チケット")
            show_advanced = getattr(cog, "show_advanced_settings", None)
            if show_advanced is not None:
                return await show_advanced(interaction)
            return await cog.show_settings(interaction)

        if selected == "ticket_assign":
            cog = self.bot.get_cog("TicketCog")
            if cog is None:
                return await self._missing(interaction, "チケット")
            show_guide = getattr(cog, "show_assign_guide", None)
            if show_guide is not None:
                return await show_guide(interaction)
            return await cog.show_settings(interaction)

        if selected == "auth_questions":
            return await self.show_auth_question_settings(interaction)

        if selected == "globalchat_mod":
            return await self.show_globalchat_moderation(interaction)

        if selected == "tempvoice_panel":
            return await interaction.response.send_message(
                view=as_panel_v2(TempVoicePanelGuideView(self)), ephemeral=True)

        if selected == "levelup_card_theme":
            return await self.show_levelup_card_theme_settings(interaction)

        if selected == "quest_manual":
            return await self.show_quest_manual(interaction)

        if selected == "binjou_custom":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_binjou_settings(store, interaction.guild_id)
            view = EmojiBinjouView(self, settings)
            if getattr(interaction, "message", None) is not None and not interaction.response.is_done():
                return await interaction.response.send_modal(BinjouRuleModal(view))
            return await interaction.response.send_message(
                view=as_panel_v2(view),
                ephemeral=True,
            )

        if selected == "server_assist":
            # 旧ハブ値の互換分岐。保存済みショートカット等に残っていても
            # 行き止まりにせず、新しい到達経路を案内する。
            return await interaction.response.send_message(
                "サーバーアシストは /support の各ジャンルに分かれました。"
                "使いたい機能は /support パネルのジャンルから選んでください。",
                ephemeral=True,
            )

        if selected == "auth_panel":
            return await self.show_auth_settings(interaction)

        if selected == "role_panel":
            return await self.show_role_panel_settings(interaction)
        if selected == "language":
            cog = self.bot.get_cog("LocalizationCog")
            if cog is None:
                return await self._missing(interaction, "言語設定")
            return await cog.show_language_settings(interaction)

        if selected == "sns_notify":
            return await self.show_sns_notify_settings(interaction)

        if selected == "quest_notify":
            return await self.show_quest_notify_settings(interaction)

        if selected == "levelup_notify":
            return await self.show_levelup_notify_settings(interaction)

        if selected == "vc_auto_start":
            return await self.show_vc_auto_start_settings(interaction)

        if selected == "bot_fixer":
            return await self.show_bot_fixer_settings(interaction)

        if selected == "globalchat":
            return await self.show_globalchat_settings(interaction)

        if selected == "sticky":
            return await self.show_sticky_settings(interaction)

        if selected == "honeypot":
            return await self.show_honeypot_settings(interaction)

        if selected == "ticket":
            cog = self.bot.get_cog("TicketCog")
            if cog is None:
                return await self._missing(interaction, "チケット")
            return await cog.show_settings(interaction)

        if selected == "giveaway":
            return await interaction.response.send_modal(GiveawayModal(self))

        if selected == "vc_log":
            return await self.show_vc_log_settings(interaction)

        if selected == "message_log":
            return await self.show_activity_log_settings(
                interaction,
                MESSAGE_LOG_SECTION,
                "メッセージ編集履歴の設定",
                "オンにすると、ユーザーのメッセージ編集前後をEmbedで記録します。",
            )

        if selected == "moderation_log":
            return await self.show_activity_log_settings(
                interaction,
                MODERATION_LOG_SECTION,
                "モデレート履歴の設定",
                "オンにすると、TO・KICK・BANの実行者、対象者、詳細をEmbedで記録します。",
            )

        if selected == "binjou":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_binjou_settings(store, interaction.guild_id)

            view = EmojiBinjouView(self, settings)
            return await interaction.response.send_message(
                view=as_panel_v2(view),
                ephemeral=True,
            )

        if selected == "auto_react":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = store.get(interaction.guild_id, AUTO_REACT_SECTION)
            view = AutoReactSettingsView(settings if isinstance(settings, dict) else {})
            return await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

        if selected == "role_bulk":
            return await self._role_bulk(interaction, None)

        if selected == "muted":
            cog = self.bot.get_cog("Muted")
            if cog is None:
                return await self._missing(interaction, "Muted")
            return await cog.muted_setting(interaction)

        if selected == "whisper":
            permissions = getattr(interaction, "permissions", None)
            if not getattr(permissions, "manage_channels", False):
                return await interaction.response.send_message(
                    "この操作には「チャンネルの管理」権限が必要です。",
                    ephemeral=True,
                )

            cog = self.bot.get_cog("WhisperCog")
            if cog is None:
                return await self._missing(interaction, "匿名つぶやき")

            return await cog.whisper(interaction)

        if selected == "clear":
            return await interaction.response.send_modal(SupportClearModal(self))

        if selected == "voice_trigger":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_voice_trigger_settings(store, interaction.guild_id)
            cog = self.bot.get_cog("VoiceTriggerCog")
            triggers = cog.list_triggers(interaction.guild_id) if cog else {}
            return await interaction.response.send_message(
                view=VoiceTriggerPanel(self, settings, triggers), ephemeral=True)

        if selected == "person_analysis":
            cog = self.bot.get_cog("PersonAnalysisCog")
            if cog is None:
                return await self._missing(interaction, "人物分析")
            return await cog.show_person_analysis(interaction)

        if selected == "server_analytics":
            cog = self.bot.get_cog("ServerAnalyticsCog")
            if cog is None:
                return await self._missing(interaction, "サーバー分析")
            return await cog.show_server_analytics(interaction)

        if selected == "earthquake":
            cog = self.bot.get_cog("EarthquakeCog")
            if cog is None:
                return await self._missing(interaction, "地震情報")
            return await cog.show_earthquake_settings(interaction)

        if selected == "news_notify":
            cog = self.bot.get_cog("NewsCog")
            if cog is None:
                return await self._missing(interaction, "ニュース通知")
            return await cog.open_panel(interaction)

        if selected.startswith("sokunuke_"):
            cog = self.bot.get_cog("SokuNukeRta")
            if cog is None:
                return await self._missing(interaction, "即抜けRTA")
            action = selected.removeprefix("sokunuke_")
            if action == "vc_on":
                action = "vc_on"
            return await cog.sokunuke_command(
                interaction,
                app_commands.Choice(name=action, value=action),
            )

        # 最終フォールスルー（boardNotify 互換）: 正リストから外した旧
        # bumprta_status/on/off/role もここへ落ち、従来どおり動作する
        # （保存済みショートカット・/quick 経由の旧 value を死なせない）。
        # 新 value（bumprta_bump 等のサービス別入口と bumprta_settings）は
        # 上の special-case で処理済みのため、ここには来ない。
        cog = self.bot.get_cog("BumpRta")
        if cog is None:
            return await self._missing(interaction, "boardNotify")

        bumprta_action = selected.removeprefix("bumprta_")
        return await cog.bumprta_command(
            interaction,
            app_commands.Choice(name=bumprta_action, value=bumprta_action),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SupportCog(bot))
