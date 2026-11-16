# -*- coding: utf-8 -*-
"""WORLD BOX の Discord チャンネル連携を /support から設定するパネル。

連携レコードは Web（ゲーム内ギルドボード「掲示」タブ）と同一の bot_kv
``worldbox_union_settings``（キー = ギルド ID）を読み書きするので、
どちらで変更してももう一方にそのまま反映される。レコードの形式と
解釈は core/support/worldbox/link.py（純粋ロジック）が正で、Web の
parseUnionChatSettings と揃えてある。

中継そのものは Bot ワーカー（core/general/circulation/worldbox_chat.py
の送信と worldbox_discord.py の受信）が担う。ここでは設定だけを扱い、
連携の実効条件（建国の有無など）はワーカー側の既存解決に委ねる。
"""
from __future__ import annotations

import logging
import time

import discord

from core.support.common import can_manage_guild
from core.support.embeds import we
from core.support.emojis import FAILED, SUCCESS
from core.support.globalchat.globalchat_panel import (
    globalchat_cog,
    guild_globalchat_channel_ids,
)
from core.support.messages import MANAGE_GUILD_REQUIRED, SETTINGS_UPDATE_FAILED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.storage import KVStore
from core.support.worldbox.link import (
    NATIONS_NS,
    UNION_SETTINGS_NS,
    build_link_status_fields,
    build_union_settings_record,
    parse_nation_guild_ids,
    parse_union_link,
)

logger = logging.getLogger("cogs.support")

#: 連携先チャンネルで Bot に必要な権限（ディレクトリ公開の対象条件と同じ組）。
WORLDBOX_LINK_BOT_PERMISSIONS = ("view_channel", "send_messages")
_PERMISSION_LABELS = {
    "view_channel": "チャンネルを見る",
    "send_messages": "メッセージを送信",
}


def missing_bot_permissions(channel) -> list[str]:
    """このチャンネルで Bot に足りない権限の日本語名一覧（globalchat と同型）。"""
    guild = getattr(channel, "guild", None)
    me = getattr(guild, "me", None) if guild is not None else None
    if channel is None or me is None:
        return []
    perms = channel.permissions_for(me)
    return [_PERMISSION_LABELS[name] for name in WORLDBOX_LINK_BOT_PERMISSIONS
            if not getattr(perms, name, False)]


def _now_ms() -> int:
    return int(time.time() * 1000)


class WorldBoxLinkChannelSelect(discord.ui.ChannelSelect):
    """連携先にするテキストチャンネルを選ぶ。選んだら即保存する。"""

    def __init__(self, parent_view: "WorldBoxLinkSettingsView"):
        self.parent_view = parent_view
        super().__init__(
            placeholder="連携先のチャンネルを選択（選ぶと即保存）",
            channel_types=[discord.ChannelType.text],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        channel = self.values[0]
        await self.parent_view.save_link(
            interaction, "channel", str(channel.id),
            f"{SUCCESS} 連携先を #{getattr(channel, 'name', channel.id)} に設定しました。")


class WorldBoxLinkSettingsView(discord.ui.View):
    """このサーバーの WORLD BOX 連携状態と変更操作を扱う画面。"""

    def __init__(self, cog, guild, settings_store: KVStore, nations_store: KVStore):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild = guild
        self.settings_store = settings_store
        self.nations_store = nations_store
        self.mode: str = "none"
        self.channel_id: str | None = None
        self.has_nation: bool = False
        self.notice: str | None = None
        self.build()

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_guild(interaction)

    async def load_state(self) -> None:
        """連携レコードと建国状態を読み直す。読み取り失敗時は未連携扱い。"""
        try:
            raw = await self.settings_store.load_one(str(self.guild.id))
            self.mode, self.channel_id = parse_union_link(raw)
        except Exception:
            logger.warning("worldbox link: 連携設定の読み取りに失敗しました（guild=%s）", self.guild.id)
            self.mode, self.channel_id = "none", None
        try:
            nations_raw = await self.nations_store.load_one("nations")
            self.has_nation = str(self.guild.id) in parse_nation_guild_ids(nations_raw)
        except Exception:
            logger.warning("worldbox link: 国家データの読み取りに失敗しました（guild=%s）", self.guild.id)
            self.has_nation = False

    def _global_channel(self):
        """このサーバーのグローバルチャット連携チャンネル（無ければ None）。"""
        gc = globalchat_cog(self.cog.bot)
        ids = guild_globalchat_channel_ids(self.guild, gc)
        if not ids:
            return None
        return self.guild.get_channel(ids[0])

    def _linked_channel(self):
        """mode "channel" の連携先をサーバー内で解決する（無ければ None）。"""
        if self.mode != "channel" or not self.channel_id:
            return None
        try:
            return self.guild.get_channel(int(self.channel_id))
        except (TypeError, ValueError):
            return None

    def _target_channel(self):
        """現在の連携先チャンネル（権限表示用）。解決できなければ None。"""
        if self.mode == "channel":
            return self._linked_channel()
        if self.mode == "global":
            return self._global_channel()
        return None

    def build(self):
        self.clear_items()
        self.add_item(WorldBoxLinkChannelSelect(self))
        global_channel = self._global_channel()
        use_global = discord.ui.Button(
            label="グローバルチャットを流用",
            style=discord.ButtonStyle.primary,
            row=1,
            disabled=global_channel is None or self.mode == "global",
        )
        use_global.callback = self.on_use_global
        self.add_item(use_global)
        unlink = discord.ui.Button(
            label="連携を解除",
            style=discord.ButtonStyle.danger,
            row=1,
            disabled=self.mode == "none",
        )
        unlink.callback = self.on_unlink
        self.add_item(unlink)

    def embed(self) -> discord.Embed:
        linked = self._linked_channel()
        global_channel = self._global_channel()
        target = self._target_channel()
        missing = missing_bot_permissions(target) if target is not None else []
        fields = build_link_status_fields(
            mode=self.mode,
            channel_id=self.channel_id,
            channel_name=getattr(linked, "name", None) if linked is not None else None,
            global_channel_name=(
                getattr(global_channel, "name", None) if global_channel is not None else None),
            has_nation=self.has_nation,
            missing_bot_permissions=missing,
        )
        embed = we(title="WORLD BOX連携", description=(
            "WORLD BOX 内のユニオンチャットと、このサーバーの Discord チャンネルをつなぎます。"
            "ゲーム内のギルドボード「掲示」タブと同じ設定です。"))
        for name, value in fields:
            embed.add_field(name=name, value=(f"{FAILED} {value}" if name == "Bot の権限" else value),
                            inline=False)
        if self._global_channel() is None and self.mode != "global":
            embed.add_field(name="グローバルチャット流用",
                            value="このサーバーにグローバルチャット連携チャンネルが"
                                  "ないため使えません（先に「グローバルチャット」で接続してください）",
                            inline=False)
        if self.notice:
            embed.description = f"{self.notice}\n\n{embed.description or ''}".strip()
        return embed

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        await self.load_state()
        self.build()
        self.notice = notice
        if interaction.response.is_done():
            await interaction.edit_original_response(
                content=None, embed=None, attachments=[], view=as_panel_v2(self))
        else:
            await edit_panel_v2(interaction, as_panel_v2(self))

    async def save_link(self, interaction: discord.Interaction, mode: str,
                        channel_id: str | None, notice: str):
        """連携レコードを Web と同じ形式で保存して画面を更新する。"""
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        try:
            record = build_union_settings_record(mode, channel_id, _now_ms())
            await self.settings_store.set(str(self.guild.id), record)
        except Exception:
            logger.exception("worldbox link: 連携設定の保存に失敗しました（guild=%s）", self.guild.id)
            return await interaction.response.send_message(
                SETTINGS_UPDATE_FAILED, ephemeral=True)
        await self.refresh(interaction, notice)

    async def on_use_global(self, interaction: discord.Interaction):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        if self._global_channel() is None:
            return await interaction.response.send_message(
                "このサーバーにグローバルチャット連携チャンネルがありません。",
                ephemeral=True)
        await self.save_link(
            interaction, "global", None,
            f"{SUCCESS} グローバルチャットを流用する連携に設定しました。")

    async def on_unlink(self, interaction: discord.Interaction):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        await self.save_link(
            interaction, "none", None, f"{SUCCESS} WORLD BOX連携を解除しました。")


class WorldBoxLinkSupportMixin:
    async def show_worldbox_link_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )
        view = WorldBoxLinkSettingsView(
            self, interaction.guild,
            KVStore(UNION_SETTINGS_NS), KVStore(NATIONS_NS))
        await view.load_state()
        view.build()
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)
