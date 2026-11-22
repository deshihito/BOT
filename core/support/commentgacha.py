# -*- coding: utf-8 -*-
"""コメントガチャの /support 設定パネル。

設定の正は core/general/commentgacha/settings.py（GuildSettings の
``commentgacha`` セクション）。ここは表示と保存だけを担う。
判定（無効・ブラックリスト・クールダウン）は CommentGachaCog 側。
"""
from __future__ import annotations

from .common import *
from core.general.commentgacha import settings as gacha_settings
from core.support.messages import MANAGE_GUILD_REQUIRED, SETTINGS_UPDATE_FAILED

SECTION = gacha_settings.SECTION


def _channel_mentions(channel_ids) -> str:
    if not channel_ids:
        return "なし"
    shown = " ".join(f"<#{channel_id}>" for channel_id in channel_ids[:10])
    if len(channel_ids) > 10:
        shown += f" 他{len(channel_ids) - 10}件"
    return shown


class _BlockedSourceSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "CommentGachaSettingsView"):
        self.parent_view = parent
        defaults = [
            discord.Object(id=channel_id)
            for channel_id in parent.settings["blocked_source_channel_ids"]
        ]
        super().__init__(
            placeholder="掘り返し元にできないチャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=0,
            max_values=gacha_settings.MAX_BLOCKED_CHANNELS,
            default_values=defaults,
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        channel_ids = [channel.id for channel in self.values]
        await self.parent_view.save(
            interaction, "掘り返し元にできないチャンネルを更新しました。",
            blocked_source_channel_ids=channel_ids)


class _BlockedTriggerSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "CommentGachaSettingsView"):
        self.parent_view = parent
        defaults = [
            discord.Object(id=channel_id)
            for channel_id in parent.settings["blocked_trigger_channel_ids"]
        ]
        super().__init__(
            placeholder="発動できないチャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=0,
            max_values=gacha_settings.MAX_BLOCKED_CHANNELS,
            default_values=defaults,
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        channel_ids = [channel.id for channel in self.values]
        await self.parent_view.save(
            interaction, "発動できないチャンネルを更新しました。",
            blocked_trigger_channel_ids=channel_ids)


class _CooldownSelect(discord.ui.Select):
    def __init__(self, parent: "CommentGachaSettingsView"):
        self.parent_view = parent
        current = parent.settings["cooldown_seconds"]
        super().__init__(
            placeholder="クールダウン（チャンネル単位）",
            options=[
                discord.SelectOption(
                    label=f"クールダウン: {gacha_settings.COOLDOWN_LABELS[seconds]}",
                    value=str(seconds),
                    default=seconds == current,
                )
                for seconds in gacha_settings.COOLDOWN_PRESETS
            ],
            min_values=1,
            max_values=1,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        seconds = int(self.values[0])
        await self.parent_view.save(
            interaction,
            f"クールダウンを{gacha_settings.COOLDOWN_LABELS[seconds]}にしました。",
            cooldown_seconds=seconds)


class CommentGachaSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.notice: str | None = None
        self._build()

    def _build(self):
        self.clear_items()
        self.add_item(_BlockedSourceSelect(self))
        self.add_item(_BlockedTriggerSelect(self))
        self.add_item(_CooldownSelect(self))
        enabled = self.settings["enabled"]
        toggle = discord.ui.Button(
            label="オフにする" if enabled else "オンにする",
            style=discord.ButtonStyle.danger if enabled else discord.ButtonStyle.success,
            custom_id="support:commentgacha:toggle",
            row=3,
        )
        toggle.callback = self._toggle
        self.add_item(toggle)

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_guild(interaction)

    async def _toggle(self, interaction: discord.Interaction):
        await self.save(
            interaction,
            "コメントガチャを" + ("オフ" if self.settings["enabled"] else "オン") + "にしました。",
            enabled=not self.settings["enabled"])

    def embed(self, notice: str | None = None) -> discord.Embed:
        if notice is None:
            notice = self.notice
        settings = self.settings
        description = (
            f"状態: **{'オン' if settings['enabled'] else 'オフ'}**\n"
            f"クールダウン: **{gacha_settings.COOLDOWN_LABELS[settings['cooldown_seconds']]}**"
            "（発動チャンネル単位）\n"
            f"掘り返し元にできない: {_channel_mentions(settings['blocked_source_channel_ids'])}\n"
            f"発動できない: {_channel_mentions(settings['blocked_trigger_channel_ids'])}"
        )
        if notice:
            description = f"{notice}\n\n{description}"
        return discord.Embed(
            title="コメントガチャ設定", description=description, color=0xFFFFFF)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(
                interaction.guild_id, SECTION, **values)
        except Exception:
            logger.exception("コメントガチャ設定の保存に失敗しました")
            return await interaction.followup.send(
                SETTINGS_UPDATE_FAILED, ephemeral=True)
        await self.refresh(interaction, notice)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = gacha_settings.get_settings(store, interaction.guild_id)
        self.notice = notice
        self._build()
        await edit_panel_v2(interaction, as_panel_v2(self))


class CommentGachaSupportMixin:
    """SupportCog の一部。entry.py で合成される。"""

    async def show_commentgacha_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = gacha_settings.get_settings(store, interaction.guild_id)
        await interaction.response.send_message(
            view=as_panel_v2(CommentGachaSettingsView(self, settings)),
            ephemeral=True,
        )
