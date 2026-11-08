# -*- coding: utf-8 -*-
"""音声トリガー設定の UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *
from core.support.emojis import FAILED
from core.support.messages import SETTINGS_UPDATE_FAILED


# ===== 音声トリガー UI ==================================================
class VoiceTriggerPermissionSelect(discord.ui.Select):
    def __init__(self, parent: "VoiceTriggerPanel"):
        self.parent_view = parent
        current = parent.settings["permission"]
        super().__init__(
            placeholder="操作権限を選択",
            options=[
                discord.SelectOption(label="管理者のみ", value="admin", default=current == "admin"),
                discord.SelectOption(label="ギルド内の全ユーザー", value="everyone", default=current == "everyone"),
            ],
            min_values=1, max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.save(interaction, "権限設定を更新しました。", permission=self.values[0])


class VoiceTriggerDeleteSelect(discord.ui.Select):
    def __init__(self, parent: "VoiceTriggerPanel", triggers: dict):
        self.parent_view = parent
        options = [discord.SelectOption(label=w[:100], value=w[:100]) for w in list(triggers)[:25]]
        if not options:
            options = [discord.SelectOption(label="登録なし", value="__none__")]
        super().__init__(placeholder="削除するトリガーを選択", options=options)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            return await interaction.response.send_message("削除するトリガーがありません。", ephemeral=True)
        cog = interaction.client.get_cog("VoiceTriggerCog")
        if cog is None:
            return await interaction.response.send_message("音声トリガー機能が読み込まれていません。", ephemeral=True)
        try:
            msg = await cog.unregister(interaction.guild, self.values[0])
        except Exception as exc:
            return await interaction.response.send_message(f"{FAILED} {exc}", ephemeral=True)
        await interaction.response.send_message(msg, ephemeral=True)
        await self.parent_view.refresh(interaction)


class VoiceTriggerPanel(discord.ui.LayoutView):
    """音声トリガー設定パネル（Components V2）。"""

    def __init__(self, cog: "SupportCog", settings: dict, triggers: dict, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.triggers = triggers
        self.notice = notice
        self._build()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if self.settings["permission"] == "admin":
            perms = getattr(interaction.user, "guild_permissions", None)
            if not getattr(perms, "administrator", False):
                await interaction.response.send_message("このパネルは管理者のみ操作できます。", ephemeral=True)
                return False
        return True

    def _build(self):
        self.clear_items()
        head = "## 🎤 音声トリガー登録\nテキストのトリガー単語で登録済み音声を再生します。（5秒まで・ギルドあたり10個）"
        if self.notice:
            head = f"{self.notice}\n\n{head}"
        rows = "\n".join(f"• `{w}`" for w in self.triggers) or "登録なし"
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(f"### 登録済み ({len(self.triggers)}/10)\n{rows}"),
                discord.ui.Separator(),
                discord.ui.ActionRow(VoiceTriggerPermissionSelect(self)),
                discord.ui.ActionRow(VoiceTriggerDeleteSelect(self, self.triggers)),
                accent_colour=0xF1C40F,
            )
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_voice_trigger_settings(store, interaction.guild_id)
        cog = interaction.client.get_cog("VoiceTriggerCog")
        self.triggers = cog.list_triggers(interaction.guild_id) if cog else {}
        self.notice = notice
        self._build()
        await interaction.edit_original_response(view=self)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(
                interaction.guild_id, VOICE_TRIGGER_SETTINGS_SECTION, **values)
        except Exception:
            logger.exception("音声トリガー設定の更新に失敗")
            return await interaction.followup.send(SETTINGS_UPDATE_FAILED, ephemeral=True)
        await self.refresh(interaction, notice)
