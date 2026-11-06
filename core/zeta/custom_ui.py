import discord
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from discord.ext import commands
from typing import Dict, List, Optional
import re
import os
from core import logfare
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.emojis import SUCCESS

from core.zeta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.zeta.common import MAX_CUSTOM_PER_USER, _clip, validate_custom_fields  # noqa: F401

logger = logging.getLogger("cogs.zetamodoki")


class CustomPersonaModal(discord.ui.Modal):
    """キャラクターとシチュエーションの登録・編集フォーム。"""

    def __init__(self, cog, owner_id: int, entry: dict | None = None, origin_view: "CustomManageView | None" = None):
        super().__init__(title="シチュエーションを編集" if entry else "シチュエーションを登録")
        self.cog = cog
        self.owner_id = owner_id
        self.entry = entry
        self.origin_view = origin_view
        entry = entry or {}

        self.name_input = discord.ui.TextInput(
            label="キャラクター名", placeholder="例: ミオ", max_length=32,
            default=entry.get("name"),
        )
        self.persona_input = discord.ui.TextInput(
            label="ペルソナ（性格・背景・口調）", style=discord.TextStyle.paragraph,
            placeholder="例: 世話焼きな幼馴染。一人称は「わたし」。素直になれず…", max_length=1000,
            default=entry.get("persona"),
        )
        self.situation_input = discord.ui.TextInput(
            label="シチュエーション（現在の状況）", style=discord.TextStyle.paragraph,
            placeholder="例: 夏祭りの帰り道、二人で人気のない神社の石段に座っている。", max_length=1000,
            default=entry.get("situation"),
        )
        self.first_message_input = discord.ui.TextInput(
            label="最初のセリフ", style=discord.TextStyle.paragraph,
            placeholder="例: （浴衣の袖をいじりながら）「……ねぇ、もう少しだけ、ここにいてもいい？」", max_length=1000,
            default=entry.get("first_message"),
        )
        self.icon_input = discord.ui.TextInput(
            label="アイコン画像URL（任意）", placeholder="https://… 空欄ならデフォルト画像",
            required=False, max_length=500, default=entry.get("icon_url") or None,
        )
        for item in (self.name_input, self.persona_input, self.situation_input,
                     self.first_message_input, self.icon_input):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        fields, error = validate_custom_fields(
            self.name_input.value, self.persona_input.value, self.situation_input.value,
            self.first_message_input.value, self.icon_input.value,
        )
        if error:
            return await interaction.response.send_message(error, ephemeral=True)

        store = self.cog.custom
        if self.entry:
            saved, error = await store.update(self.owner_id, self.entry["id"], fields)
            verb = "更新"
        else:
            saved, error = await store.add(self.owner_id, fields)
            verb = "登録"
        if error:
            return await interaction.response.send_message(error, ephemeral=True)

        if self.origin_view is not None:
            view = CustomManageView(
                self.cog, self.owner_id, saved["id"],
                notice=f"「{saved['name']}」を{verb}しました。",
            )
            return await edit_panel_v2(interaction, as_panel_v2(view))
        await interaction.response.send_message(
            f"「{saved['name']}」を{verb}しました。`ZetaModoki` の「会話を開始」から選べます。", ephemeral=True,
        )


class CustomEntrySelect(discord.ui.Select):
    def __init__(self, parent_view: "CustomManageView"):
        self.parent_view = parent_view
        options = [
            discord.SelectOption(
                label=_clip(e["name"], 100), value=e["id"],
                description=_clip(e["situation"], 100), emoji="⭐",
                default=e["id"] == parent_view.selected_id,
            )
            for e in parent_view.entries
        ]
        super().__init__(placeholder="編集・削除する登録を選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        new_view = CustomManageView(view.cog, view.owner_id, self.values[0])
        await edit_panel_v2(interaction, as_panel_v2(new_view))


class CustomManageView(discord.ui.View):
    """登録済みシチュエーションの一覧・登録・編集・削除。"""

    def __init__(self, cog, owner_id: int, selected_id: str | None = None, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.owner_id = owner_id
        self.notice = notice
        self.entries = cog.custom.list(owner_id)
        ids = [e["id"] for e in self.entries]
        self.selected_id = selected_id if selected_id in ids else (ids[0] if ids else None)

        if self.entries:
            self.add_item(CustomEntrySelect(self))
        self.register_button.disabled = len(self.entries) >= MAX_CUSTOM_PER_USER
        self.edit_button.disabled = self.selected_id is None
        self.delete_button.disabled = self.selected_id is None

    def embed(self) -> discord.Embed:
        # Components V2 へ変換される前提で、本文(description)のみで構成する
        lines = []
        if self.notice:
            lines += [f"{SUCCESS} {self.notice}", ""]
        if not self.entries:
            lines.append("まだ登録がありません。「新規登録」からキャラクターとシチュエーションを作成できます。")
        for e in self.entries:
            mark = "▶ " if e["id"] == self.selected_id else ""
            lines.append(f"**{mark}{_clip(e['name'], 60)}**")
            lines.append(_clip(f"状況: {e['situation']}", 300))
            lines.append("")
        lines.append("-# 登録したシチュエーションは、あなたの「会話を開始」の選択肢に追加されます。")
        return discord.Embed(
            title=f"登録済みシチュエーション（{len(self.entries)}/{MAX_CUSTOM_PER_USER}）",
            description="\n".join(lines),
            color=discord.Color.purple(),
        )

    async def _owner_only(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="新規登録", style=discord.ButtonStyle.success, emoji="➕", row=1)
    async def register_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        if len(self.cog.custom.list(self.owner_id)) >= MAX_CUSTOM_PER_USER:
            return await interaction.response.send_message(
                f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。", ephemeral=True)
        await interaction.response.send_modal(CustomPersonaModal(self.cog, self.owner_id, None, self))

    @discord.ui.button(label="編集", style=discord.ButtonStyle.primary, emoji="✏️", row=1)
    async def edit_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        entry = self.cog.custom.get(self.owner_id, self.selected_id) if self.selected_id else None
        if entry is None:
            return await interaction.response.send_message("編集する登録を選択してください。", ephemeral=True)
        await interaction.response.send_modal(CustomPersonaModal(self.cog, self.owner_id, entry, self))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger, emoji="🗑️", row=1)
    async def delete_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        entry = self.cog.custom.get(self.owner_id, self.selected_id) if self.selected_id else None
        if entry is None:
            return await interaction.response.send_message("削除する登録を選択してください。", ephemeral=True)
        confirm = CustomDeleteConfirmView(self.cog, self.owner_id, entry)
        await edit_panel_v2(interaction, as_panel_v2(confirm))


class CustomDeleteConfirmView(discord.ui.View):
    def __init__(self, cog, owner_id: int, entry: dict):
        super().__init__(timeout=60)
        self.cog, self.owner_id, self.entry = cog, owner_id, entry
        self.entry_id = entry["id"]

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="登録の削除",
            description=f"「{self.entry['name']}」を削除しますか？この操作は取り消せません。",
            color=discord.Color.red(),
        )

    @discord.ui.button(label="削除する", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        removed, error = await self.cog.custom.delete(self.owner_id, self.entry_id)
        notice = error or f"「{removed['name']}」を削除しました。"
        view = CustomManageView(self.cog, self.owner_id, notice=notice)
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view = CustomManageView(self.cog, self.owner_id, self.entry_id)
        await edit_panel_v2(interaction, as_panel_v2(view))


class ZetaInfoView(discord.ui.View):
    """ボタンを持たない、Embed相当の表示だけのパネル（V2変換用）。"""

    def __init__(self, embed: discord.Embed):
        super().__init__(timeout=None)
        self._embed = embed

    def embed(self) -> discord.Embed:
        return self._embed
