"""Unified entry point for server assist features."""
from __future__ import annotations

import importlib
import inspect
import logging
from typing import Any

import discord
from discord.ext import commands

from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.messages import ASSIST_MANAGE_REQUIRED, feature_not_loaded
from core.support.server_assist import discover_features, has_manage_permission

logger = logging.getLogger(__name__)


class ServerAssistCog(commands.Cog):
    """Loads feature modules and forwards Discord events to them."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.features = discover_features(refresh=True)
        self.by_key = {feature.key: feature for feature in self.features}
        self.modules: dict[str, Any] = {}
        self._feature_tasks: list[Any] = []
        for feature in self.features:
            try:
                self.modules[feature.key] = importlib.import_module(feature.module_name)
            except Exception:
                logger.exception("サーバーアシスト機能を読み込めませんでした: %s", feature.key)

    async def cog_load(self):
        try:
            await guild_settings.get_store().ensure_loaded()
        except Exception:
            logger.exception("サーバーアシスト設定の読み込みに失敗しました")
        for module in self.modules.values():
            for name in ("register_views", "start_tasks"):
                hook = getattr(module, name, None)
                if callable(hook):
                    try:
                        hook(self)
                    except Exception:
                        logger.exception("サーバーアシストの %s に失敗しました", name)

    async def cog_unload(self):
        for task in self._feature_tasks:
            task.cancel()
        for key, module in self.modules.items():
            hook = getattr(module, "shutdown", None)
            if not callable(hook):
                continue
            try:
                result = hook(self)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.exception("サーバーアシストの shutdown に失敗しました: %s", key)

    async def show_panel_edit(self, interaction: discord.Interaction, feature_key: str | None = None):
        """設定画面から /support パネルへ戻る（その機能が属するジャンルを開く）。

        旧ハブ（サーバーアシストホーム）は再編で廃止したため、戻り先は
        /support パネルそのもの。ジャンルは SUPPORT_ACTIONS_BY_GENRE から
        逆引きする（import は循環回避のため実行時に行う）。
        """
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        support_cog = self.bot.get_cog("SupportCog")
        if support_cog is None:
            return await interaction.response.send_message(
                "設定画面を開き直してください。", ephemeral=True,
            )
        genre = None
        if feature_key:
            from core.support.common import SUPPORT_ACTIONS_BY_GENRE

            target = f"assist_{feature_key}"
            genre = next(
                (
                    name
                    for name, items in SUPPORT_ACTIONS_BY_GENRE.items()
                    if any(value == target for _label, value in items)
                ),
                None,
            )
        from core.support.panel import SupportPanelView

        view = SupportPanelView(
            support_cog, genre=genre, owner_id=getattr(interaction.user, "id", None),
        )
        return await edit_panel_v2(interaction, as_panel_v2(view))

    async def show_feature(self, interaction: discord.Interaction, key: str):
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        feature = self.by_key.get(key)
        if feature is None or interaction.guild_id is None:
            return await interaction.response.send_message(
                "設定画面を開き直してください。", ephemeral=True,
            )
        try:
            view = feature.build_view(self, interaction.guild_id)
        except Exception:
            logger.exception("サーバーアシスト設定画面を作れませんでした: %s", key)
            return await interaction.response.send_message(
                "設定画面の読み込みに失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。", ephemeral=True,
            )
        return await edit_panel_v2(interaction, as_panel_v2(view))

    async def show_feature_preset(self, interaction: discord.Interaction, key: str,
                                  preset: str | None = None, notice: str | None = None):
        """機能数再編の preset 入口（assist_reminder 等）から機能画面を開く。

        元機能の View をそのまま使い、preset 名と案内文（notice）を
        View に付与して開く。View の embed は notice_line(self.notice) で
        案内を表示する（全 assist 機能共通）。preset は View の属性として
        保持され、将来のスコープ表示に使える。
        """
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        feature = self.by_key.get(key)
        if feature is None or interaction.guild_id is None:
            return await interaction.response.send_message(
                "設定画面を開き直してください。", ephemeral=True,
            )
        try:
            view = feature.build_view(self, interaction.guild_id)
        except Exception:
            logger.exception("サーバーアシスト設定画面を作れませんでした: %s", key)
            return await interaction.response.send_message(
                "設定画面の読み込みに失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。", ephemeral=True,
            )
        view.preset = preset
        if notice:
            view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    async def _delegate(self, interaction, key: str, noun: str, method: str, *args):
        module = self.modules.get(key)
        if module is None:
            return await interaction.response.send_message(
                feature_not_loaded(noun), ephemeral=True,
            )
        return await getattr(module, method)(self, interaction, *args)

    async def handle_level_rewards(self, guild, member, old_level: int, new_level: int):
        module = self.modules.get("leveling")
        if module is None:
            return
        return await module.handle_level_rewards(self, guild, member, old_level, new_level)

    async def handle_temp_voice_action(self, interaction, action: str):
        return await self._delegate(interaction, "tempvoice", "一時VC機能", "handle_action", action)

    async def handle_suggestion_create(self, interaction):
        return await self._delegate(interaction, "suggestions", "提案箱", "handle_create")

    async def handle_suggestion_vote(self, interaction, action: str):
        return await self._delegate(interaction, "suggestions", "提案箱", "handle_vote", action)

    async def handle_application_create(self, interaction):
        return await self._delegate(interaction, "applications", "応募フォーム", "handle_create")

    async def handle_application_review(self, interaction, action: str):
        return await self._delegate(interaction, "applications", "応募フォーム", "handle_review", action)
    async def handle_poll_create(self, interaction):
        return await self._delegate(interaction, "polls", "投票", "handle_create")

    async def handle_poll_vote(self, interaction, values):
        return await self._delegate(interaction, "polls", "投票", "handle_vote", values)

    async def handle_poll_close(self, interaction):
        return await self._delegate(interaction, "polls", "投票", "handle_close")

    async def handle_poll_refresh(self, interaction):
        return await self._delegate(interaction, "polls", "投票", "handle_refresh")

    async def handle_event_create(self, interaction):
        return await self._delegate(interaction, "events", "イベント", "handle_create")

    async def handle_event_rsvp(self, interaction, choice):
        return await self._delegate(interaction, "events", "イベント", "handle_rsvp", choice)

    async def handle_event_close(self, interaction):
        return await self._delegate(interaction, "events", "イベント", "handle_close")

    async def handle_event_refresh(self, interaction):
        return await self._delegate(interaction, "events", "イベント", "handle_refresh")

    async def _dispatch(self, hook: str, *args: Any):
        # イベント駆動の機能（参加・退出メッセージ等）はここを通る。設定の
        # メモリ写しは ensure_loaded を呼ぶ経路（パネル操作等）でしか更新されない
        # ため、起動直後の読み込みが API 障害でローカルの控えに落ちた場合、
        # 誰かがパネルを開くまで古い（空の）設定のまま静かに動かなくなる。
        # dispatch の入口で読み直しを試みる（鮮度内なら時刻チェックだけで戻る）。
        try:
            await guild_settings.get_store().ensure_loaded()
        except Exception:
            logger.exception("サーバーアシスト設定の読み直しに失敗しました")
        for key, module in self.modules.items():
            callback = getattr(module, hook, None)
            if callback is None:
                continue
            try:
                await callback(self, *args)
            except Exception:
                logger.exception("サーバーアシストの %s 処理に失敗しました: %s", hook, key)

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        await self._dispatch("on_member_join", member)

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        await self._dispatch("on_member_remove", member)

    @commands.Cog.listener()
    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent):
        await self._dispatch("on_raw_reaction_add", payload)

    @commands.Cog.listener()
    async def on_raw_reaction_remove(self, payload: discord.RawReactionActionEvent):
        await self._dispatch("on_raw_reaction_remove", payload)

    @commands.Cog.listener()
    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent):
        await self._dispatch("on_raw_message_delete", payload)

    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message):
        await self._dispatch("on_message_delete", message)

    @commands.Cog.listener()
    async def on_guild_role_create(self, role: discord.Role):
        await self._dispatch("on_guild_role_create", role)

    @commands.Cog.listener()
    async def on_guild_role_delete(self, role: discord.Role):
        await self._dispatch("on_guild_role_delete", role)

    @commands.Cog.listener()
    async def on_guild_channel_create(self, channel: discord.abc.GuildChannel):
        await self._dispatch("on_guild_channel_create", channel)

    @commands.Cog.listener()
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel):
        await self._dispatch("on_guild_channel_delete", channel)

    @commands.Cog.listener()
    async def on_invite_create(self, invite: discord.Invite):
        await self._dispatch("on_invite_create", invite)

    @commands.Cog.listener()
    async def on_invite_delete(self, invite: discord.Invite):
        await self._dispatch("on_invite_delete", invite)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        await self._dispatch("on_message", message)

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member, before, after):
        await self._dispatch("on_voice_state_update", member, before, after)

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        await self._dispatch("on_interaction", interaction)


async def setup(bot: commands.Bot):
    await bot.add_cog(ServerAssistCog(bot))
