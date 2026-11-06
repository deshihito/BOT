"""Shared UI helpers for server-assist feature views."""
from __future__ import annotations

from typing import Any

import discord

from core.panel_v2 import as_panel_v2


class BackToAssistButton(discord.ui.Button):
    def __init__(self, row: int = 4):
        super().__init__(label="サーバーアシストへ戻る", style=discord.ButtonStyle.secondary, row=row)

    async def callback(self, interaction: discord.Interaction):
        cog = getattr(self.view, "cog", None)
        if cog is None:
            return await interaction.response.send_message("設定画面を開き直してください。", ephemeral=True)
        await cog.show_home_edit(interaction)


class AssistFeatureView(discord.ui.View):
    """Base class for a settings screen inside the server-assist hub."""

    feature_key = ""
    feature_title = "サーバーアシスト設定"

    def __init__(self, cog: Any, guild_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.notice: str | None = None
        self.add_item(BackToAssistButton())

    def can_manage(self, interaction: discord.Interaction) -> bool:
        permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
        return bool(
            getattr(permissions, "administrator", False)
            or getattr(permissions, "manage_guild", False)
        )

    def embed(self) -> discord.Embed:
        raise NotImplementedError

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.notice = notice
        view = as_panel_v2(self)
        if interaction.response.is_done():
            return await interaction.edit_original_response(
                content=None, embed=None, attachments=[], view=view,
            )
        return await interaction.response.edit_message(
            content=None, embed=None, attachments=[], view=view,
        )


def channel_label(channel_id: Any) -> str:
    return f"<#{channel_id}>" if isinstance(channel_id, int) and channel_id else "未設定"


def notice_line(notice: str | None) -> str:
    return f"\n\n**{notice}**" if notice else ""
