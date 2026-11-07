# -*- coding: utf-8 -*-
"""VC参加時の自動開始の設定パネル。元は /support「自動化・通知」から開く。"""
from __future__ import annotations

from .common import *
from core.support.messages import SETTINGS_UPDATE_FAILED
from core.vc.auto_start import (
    AUTO_START_FEATURES,
    VC_AUTO_START_SECTION,
    get_vc_auto_start_settings,
)


class VcAutoStartToggleButton(discord.ui.Button):
    def __init__(self, parent: "VcAutoStartPanel", key: str, label: str):
        self.parent_view = parent
        self.key = key
        enabled = bool(parent.settings.get(key))
        super().__init__(
            label=f"{label}: {'ON' if enabled else 'OFF'}",
            style=discord.ButtonStyle.success if enabled else discord.ButtonStyle.secondary,
        )

    async def callback(self, interaction: discord.Interaction):
        enabled = not bool(self.parent_view.settings.get(self.key))
        await self.parent_view.save(
            interaction,
            f"{self.label.split(':')[0]}の自動開始を{'オン' if enabled else 'オフ'}にしました。",
            **{self.key: enabled},
        )


class VcAutoStartRoomModal(discord.ui.Modal, title="グローバルVCの自動開始ルーム"):
    room = discord.ui.TextInput(label="ルーム名", max_length=100)
    password = discord.ui.TextInput(
        label="パスワード（非公開ルームのみ）", required=False, max_length=100
    )

    def __init__(self, parent: "VcAutoStartPanel"):
        super().__init__()
        self.parent_view = parent
        self.room.default = parent.settings.get("global_room") or None

    async def on_submit(self, interaction: discord.Interaction):
        await self.parent_view.save(
            interaction,
            "グローバルVCの自動開始ルームを設定しました。",
            global_room=self.room.value.strip() or None,
            global_password=self.password.value.strip() or None,
        )


class VcAutoStartRoomButton(discord.ui.Button):
    def __init__(self, parent: "VcAutoStartPanel"):
        self.parent_view = parent
        super().__init__(label="GVCルーム設定", style=discord.ButtonStyle.primary)

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(VcAutoStartRoomModal(self.parent_view))


class VcAutoStartPanel(discord.ui.LayoutView):
    """VC参加時の自動開始の設定パネル（Components V2・サーバー管理権限）。"""

    def __init__(self, cog: "SupportCog", settings: dict, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.notice = notice
        self._build()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False):
            return True
        await interaction.response.send_message(
            "この設定にはサーバー管理権限が必要です。",
            ephemeral=True,
        )
        return False

    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item):
        await report_callback_error(interaction, "VC自動開始パネルでエラー", error=error)

    def _status_text(self) -> str:
        s = self.settings
        lines = [
            f"{label}: **{'ON' if s.get(key) else 'OFF'}**" for key, label, _ in AUTO_START_FEATURES
        ]
        room = s.get("global_room")
        lines.append(f"GVCルーム: {room if room else '未設定'}")
        return "\n".join(lines)

    def _build(self):
        self.clear_items()
        head = "## VC参加時の自動開始\nボットがVCに参加した時に、オンの機能を自動で開始します。"
        if self.notice:
            head = f"{self.notice}\n\n{head}"
        rows = [
            discord.ui.ActionRow(
                *[VcAutoStartToggleButton(self, key, label) for key, label, _ in AUTO_START_FEATURES[:2]]
            ),
            discord.ui.ActionRow(
                *[VcAutoStartToggleButton(self, key, label) for key, label, _ in AUTO_START_FEATURES[2:]],
                VcAutoStartRoomButton(self),
            ),
        ]
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(self._status_text()),
                discord.ui.Separator(),
                *rows,
                accent_colour=0x3498DB,
            )
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_vc_auto_start_settings(store, interaction.guild_id)
        self.notice = notice
        self._build()
        await edit_interaction_message(interaction, view=self)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(
                interaction.guild_id, VC_AUTO_START_SECTION, **values
            )
        except Exception:
            logger.exception("VC自動開始設定の更新に失敗しました")
            return await interaction.followup.send(
                SETTINGS_UPDATE_FAILED,
                ephemeral=True,
            )
        await self.refresh(interaction, notice)


class VcAutoStartSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_vc_auto_start_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_auto_start_settings(store, interaction.guild_id)
        await interaction.response.send_message(
            view=VcAutoStartPanel(self, settings),
            ephemeral=True,
        )
