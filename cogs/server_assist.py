"""Unified entry point for ProBot-style server assist features."""
from __future__ import annotations

import importlib
import logging
from typing import Any

import discord
from discord.ext import commands

from core import guild_settings
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.server_assist import discover_features, has_manage_permission

logger = logging.getLogger(__name__)


class AssistFeatureSelect(discord.ui.Select):
    def __init__(self, cog: "ServerAssistCog"):
        self.cog = cog
        options = [
            discord.SelectOption(
                label=feature.label[:100],
                description=feature.description[:100],
                value=feature.key,
            )
            for feature in cog.features[:25]
        ]
        if not options:
            options = [discord.SelectOption(label="利用できる機能がありません", value="__none__")]
        super().__init__(placeholder="設定する機能を選択してください", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            return await interaction.response.send_message("利用できる機能がありません。", ephemeral=True)
        await self.cog.show_feature(interaction, self.values[0])


class ServerAssistHomeView(discord.ui.View):
    def __init__(self, cog: "ServerAssistCog"):
        super().__init__(timeout=300)
        self.cog = cog
        self.add_item(AssistFeatureSelect(cog))

    def embed(self) -> discord.Embed:
        embed = discord.Embed(
            title="サーバーアシスト",
            description=(
                "ProBot 互換のサーバー設定をここにまとめています。"
                "下のメニューから機能を選んでください。"
            ),
            color=0xFFFFFF,
        )
        for feature in self.cog.features[:20]:
            embed.add_field(name=feature.label, value=feature.description, inline=False)
        if not self.cog.features:
            embed.description = "利用できる機能がありません。Botのログを確認してください。"
        return embed


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

    async def show_home(self, interaction: discord.Interaction):
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        await interaction.response.send_message(
            view=as_panel_v2(ServerAssistHomeView(self)),
            ephemeral=True,
        )

    async def show_home_edit(self, interaction: discord.Interaction):
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await edit_panel_v2(interaction, as_panel_v2(ServerAssistHomeView(self)))

    async def show_feature(self, interaction: discord.Interaction, key: str):
        if not has_manage_permission(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
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
                "設定画面の読み込みに失敗しました。Botのログを確認してください。", ephemeral=True,
            )
        return await edit_panel_v2(interaction, as_panel_v2(view))

    async def handle_level_rewards(self, guild, member, old_level: int, new_level: int):
        module = self.modules.get("leveling")
        if module is None:
            return
        return await module.handle_level_rewards(self, guild, member, old_level, new_level)

    async def handle_temp_voice_action(self, interaction, action: str):
        module = self.modules.get("tempvoice")
        if module is None:
            return await interaction.response.send_message(
                "一時VC機能を読み込めませんでした。", ephemeral=True,
            )
        return await module.handle_action(self, interaction, action)

    async def handle_suggestion_create(self, interaction):
        module = self.modules.get("suggestions")
        if module is None:
            return await interaction.response.send_message(
                "提案箱を読み込めませんでした。", ephemeral=True,
            )
        return await module.handle_create(self, interaction)

    async def handle_suggestion_vote(self, interaction, action: str):
        module = self.modules.get("suggestions")
        if module is None:
            return await interaction.response.send_message(
                "提案箱を読み込めませんでした。", ephemeral=True,
            )
        return await module.handle_vote(self, interaction, action)

    async def _dispatch(self, hook: str, *args: Any):
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
