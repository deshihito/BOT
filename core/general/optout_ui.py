# -*- coding: utf-8 -*-
"""オプトアウト設定パネル（general:optout_settings の着地先）。

自分の発言を「対象にしない」ための個人設定を1画面に集約する:
- コメントガチャで掘り返さない（core/general/optout.py）
- 今北産業の要約に使わない（同上）
- MIQで引用しない（保存先は既存の MIQ 設定 prefs の refuse が正。
  このパネルは同じ値を読み書きするだけで、二重管理しない）

操作は開いた本人のみ。保存先の失敗は followup で知らせる。
"""
from __future__ import annotations

import logging

import discord

from core.general import optout
from core.general.miq.miq import miq_get_prefs, miq_save_prefs
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger("cogs.general")

MIQ_KEY = "miq"
TOGGLES = (
    (optout.FEATURE_COMMENTGACHA, "コメントガチャで掘り返さない"),
    (optout.FEATURE_IMAKITA, "今北産業の要約に使わない"),
    (MIQ_KEY, "MIQで引用しない"),
)


class _OptOutToggleButton(discord.ui.Button):
    def __init__(self, parent: "OptOutSettingsView", key: str, label: str, row: int):
        self.parent_view = parent
        self.key = key
        on = parent.state.get(key, False)
        super().__init__(
            label=f"{label}: {'ON' if on else 'OFF'}",
            style=discord.ButtonStyle.danger if on else discord.ButtonStyle.secondary,
            row=row,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if interaction.user.id != parent.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ変更できます。", ephemeral=True)
        await parent.toggle(interaction, self.key)


class OptOutSettingsView(discord.ui.View):
    """オプトアウト設定のトグルだけを持つ小さな設定 View。"""

    def __init__(self, cog, user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.state: dict[str, bool] = {}
        self.refresh_state()
        self.refresh()

    async def interaction_check(self, interaction) -> bool:
        return interaction.user.id == self.user_id

    def refresh_state(self):
        state = optout.get_optouts(self.user_id)
        state[MIQ_KEY] = bool(miq_get_prefs(self.user_id).get("refuse"))
        self.state = state

    def refresh(self):
        self.clear_items()
        for row, (key, label) in enumerate(TOGGLES):
            self.add_item(_OptOutToggleButton(self, key, label, row))

    async def toggle(self, interaction: discord.Interaction, key: str):
        new_value = not self.state.get(key, False)
        ok = True
        if key == MIQ_KEY:
            prefs = miq_get_prefs(self.user_id)
            prefs["refuse"] = new_value
            ok = await miq_save_prefs(self.user_id, prefs)
        else:
            try:
                await optout.set_optout(self.user_id, key, new_value)
            except Exception:
                logger.exception("オプトアウト設定の保存に失敗しました")
                ok = False
        self.refresh_state()
        self.refresh()
        await edit_panel_v2(interaction, as_panel_v2(self))
        if not ok:
            try:
                await interaction.followup.send(
                    "設定の保存に失敗しました。時間をおいて再試行してください。",
                    ephemeral=True)
            except discord.HTTPException:
                logger.debug("オプトアウト: 設定保存の失敗通知の送信に失敗しました", exc_info=True)

    def embed(self) -> discord.Embed:
        def onoff(key: str) -> str:
            return "ON（対象外）" if self.state.get(key) else "OFF（対象）"

        lines = [
            f"コメントガチャで掘り返さない: `{onoff(optout.FEATURE_COMMENTGACHA)}`",
            f"今北産業の要約に使わない: `{onoff(optout.FEATURE_IMAKITA)}`",
            f"MIQで引用しない: `{onoff(MIQ_KEY)}`",
            "ONにすると、あなたの発言はその機能の対象になりません（全サーバー共通）。",
        ]
        return discord.Embed(
            title="オプトアウト設定", description="\n".join(lines), color=0xFFFFFF)
