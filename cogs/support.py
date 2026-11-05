# -*- coding: utf-8 -*-
"""サポート系機能を /support に統合する入口。

実装は core/support/ パッケージに機能ごとに分割されている。
このモジュールは、それらを合成した SupportCog と、従来どおり
`cogs.support` から import できる名前の再エクスポートを担う。
"""
from __future__ import annotations

import logging

import discord
from discord import app_commands
from discord.ext import commands

from core import action_usage, guild_settings, usage_stats
from core.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2
from core.support.common import *
from core.support.auth import *
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
from core.support.auth import AuthSupportMixin
from core.support.roles import RoleSupportMixin
from core.support.logs import LogSupportMixin
from core.support.sticky import StickySupportMixin
from core.support.honeypot import HoneypotSupportMixin
from core.support.binjou import BinjouSupportMixin
from core.support.sns import SnsSupportMixin
from core.support.quest import QuestSupportMixin
from core.support.levelup import LevelUpSupportMixin

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
    _sns_x_rss_template,
    _sns_x_token,
)

logger = logging.getLogger(__name__)


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
    commands.Cog,
):
    SUPPORT_REQUIRED_PERMISSIONS = {
        "muted": "manage_roles",
        "whisper": "manage_channels",
        "sticky": "manage_guild",
        "clear": "manage_messages",
        "role_bulk": "manage_roles",
        "binjou": "manage_guild",
        "auto_react": "manage_guild",
        "giveaway": "manage_guild",
        "vc_log": "manage_guild",
        "message_log": "manage_guild",
        "moderation_log": "manage_guild",
        "honeypot": "manage_guild",
        "ticket": "manage_guild",
        "auth_panel": "administrator",
        "role_panel": "administrator",
        "language": "manage_guild",
        "sns_notify": "administrator",
        "quest_notify": "administrator",
        "levelup_notify": "manage_guild",
        "server_assist": "manage_guild",
        "sokunuke_status": "manage_guild",
        "sokunuke_on": "manage_guild",
        "sokunuke_off": "manage_guild",
        "sokunuke_vc_on": "manage_guild",
        "sokunuke_vc_off": "manage_guild",
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
        view = SupportPanelView(self, history_specs=history_specs)
        await interaction.response.send_message(
            view=as_panel_v2(view),
            ephemeral=True,
        )


    async def dispatch(self, interaction: discord.Interaction, selected: str):
        if not await self.check_support_permission(interaction, selected):
            return

        # 利用履歴（よく使う／最近）は権限チェックを通った実行だけを記録する。
        await action_usage.record_safely(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"support:{selected}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"support:{selected}")

        if selected == "server_assist":
            cog = self.bot.get_cog("ServerAssistCog")
            if cog is None:
                return await self._missing(interaction, "サーバーアシスト")
            return await cog.show_home(interaction)

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

        cog = self.bot.get_cog("BumpRta")
        if cog is None:
            return await self._missing(interaction, "bump/up通知・RTA")

        bumprta_action = selected.removeprefix("bumprta_")
        return await cog.bumprta_command(
            interaction,
            app_commands.Choice(name=bumprta_action, value=bumprta_action),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SupportCog(bot))
