# -*- coding: utf-8 -*-
"""自動リアクション設定の UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *
from core.support.messages import MANAGE_GUILD_REQUIRED, SETTINGS_UPDATE_FAILED
from .binjou import normalize_binjou_emoji


class AutoReactChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent_view):
        self.parent_view = parent_view
        super().__init__(
            placeholder="Auto reactを設定するチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        self.parent_view.channel_id = self.values[0].id
        await self.parent_view.refresh(interaction)


class AutoReactModal(discord.ui.Modal, title="Auto reactの絵文字"):
    emojis = discord.ui.TextInput(
        label="自動で付ける絵文字（改行またはカンマ区切り・空欄で解除）",
        placeholder="🎉, <:custom:123456789012345678>",
        max_length=500,
        required=False,
        style=discord.TextStyle.paragraph,
    )

    def __init__(self, parent_view):
        super().__init__()
        self.parent_view = parent_view

    async def on_submit(self, interaction: discord.Interaction):
        await self.parent_view.save(interaction, self.emojis.value)


class AutoReactSettingsView(discord.ui.View):
    def __init__(self, settings: dict):
        super().__init__(timeout=300)
        self.settings = settings
        self.channel_id = None
        self.add_item(AutoReactChannelSelect(self))

    @staticmethod
    def can_manage(interaction):
        return can_manage_guild(interaction)

    def embed(self):
        rows = self.settings.get("channels", {})
        lines = [f"<#{channel_id}>: {' '.join(emojis)}" for channel_id, emojis in rows.items()]
        return discord.Embed(
            title="Auto react設定",
            description=("メッセージ受信時に自動で付ける絵文字をチャンネルごとに設定します。\n"
                         "複数の絵文字は改行またはカンマで区切ってください。空欄で選択チャンネルの設定を解除します。\n\n"
                         + ("\n".join(lines) if lines else "設定済みチャンネルはありません。")),
            color=0xFFFFFF,
        )

    async def refresh(self, interaction):
        await edit_panel_v2(interaction, as_panel_v2(self))

    @discord.ui.button(label="選択チャンネルの絵文字を設定", style=discord.ButtonStyle.primary, row=1)
    async def configure(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        if self.channel_id is None:
            return await interaction.response.send_message("先にチャンネルを選択してください。", ephemeral=True)
        await interaction.response.send_modal(AutoReactModal(self))

    async def save(self, interaction, text):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        raw_emojis = [value.strip() for value in str(text or "").replace("\n", ",").split(",") if value.strip()]
        if len(raw_emojis) > 20:
            return await interaction.response.send_message("絵文字は1チャンネルにつき20個までです。", ephemeral=True)
        try:
            emojis = [str(normalize_binjou_emoji(value)) for value in raw_emojis]
        except ValueError as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        rows = dict(self.settings.get("channels", {}))
        if emojis:
            rows[str(self.channel_id)] = list(dict.fromkeys(emojis))
        else:
            rows.pop(str(self.channel_id), None)
        try:
            await guild_settings.get_store().update(interaction.guild_id, AUTO_REACT_SECTION, channels=rows)
            self.settings["channels"] = rows
            await interaction.response.send_message("Auto react設定を更新しました。", ephemeral=True)
        except Exception:
            logger.exception("Auto react設定の保存に失敗しました")
            await interaction.response.send_message(SETTINGS_UPDATE_FAILED, ephemeral=True)
