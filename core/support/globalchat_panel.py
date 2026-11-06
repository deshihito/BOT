# -*- coding: utf-8 -*-
"""グローバルチャット（サーバーをまたぐ中継）の /support 設定パネル。

中継そのものは core/support/globalchat/cog.py の GlobalChatCog が担い、
登録は同 cog の保存先（global_channels.json の active_channels）を
そのまま使う。荒らし対策の設定は core/support/globalchat_moderation
（guild_settings の "globalchat" セクション）で、保存形式は変えない。
旧 /setup ウィザード廃止で導線が消えていた登録/解除と荒らし対策を、
/support のアクション「グローバルチャット」として復活させたもの。
"""
from __future__ import annotations

import logging

import discord

from core.embeds import we
from core.emojis import FAILED, SUCCESS
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.support import globalchat_moderation as mod
from core.support.server_setup.cog import channel_list_text

logger = logging.getLogger("cogs.support")

#: 中継に必要な Bot の権限（旧ウィザードの権限チェックと同じ組）。
GLOBALCHAT_BOT_PERMISSIONS = ("view_channel", "manage_webhooks", "add_reactions")
_PERMISSION_LABELS = {
    "view_channel": "チャンネルを見る",
    "manage_webhooks": "ウェブフックの管理",
    "add_reactions": "リアクションの追加",
}


def globalchat_cog(bot):
    """GlobalChatCog を、登録操作に必要な形を備えている場合だけ返す。"""
    cog = bot.get_cog("GlobalChatCog")
    if cog is not None and hasattr(cog, "active_channels") and hasattr(cog, "save_channels"):
        return cog
    return None


def guild_globalchat_channel_ids(guild, cog) -> list[int]:
    """このサーバーのチャンネルのうち、グローバルチャットにつないでいるID。"""
    if guild is None or cog is None:
        return []
    return [cid for cid in cog.active_channels if guild.get_channel(cid) is not None]


def set_globalchat_connection(cog, channel_id: int, connect: bool) -> None:
    """登録/解除して即保存する（旧ウィザードの set_global と同じ操作）。"""
    if connect:
        cog.active_channels.add(channel_id)
    else:
        cog.active_channels.discard(channel_id)
    cog.save_channels()


def missing_bot_permissions(channel) -> list[str]:
    """このチャンネルで Bot に足りない権限の日本語名一覧。"""
    guild = getattr(channel, "guild", None)
    me = getattr(guild, "me", None) if guild is not None else None
    if channel is None or me is None:
        return []
    perms = channel.permissions_for(me)
    return [_PERMISSION_LABELS[name] for name in GLOBALCHAT_BOT_PERMISSIONS
            if not getattr(perms, name, False)]


class GlobalChatModerationModal(discord.ui.Modal, title="グローバルチャットの荒らし対策"):
    """このサーバーで足す NG ワードと、このサーバーに届かせないユーザー・サーバー。

    旧ウィザードの ModerationModal と同じ項目・同じ保存方式。
    """

    def __init__(self, view: "GlobalChatSettingsView"):
        super().__init__()
        self.parent_view = view
        s = mod.settings(view.guild.id)
        self.ng_words = discord.ui.TextInput(
            label="NG ワード（改行かカンマ区切り。既定の一覧に追加）", required=False,
            style=discord.TextStyle.paragraph, max_length=2000,
            default="\n".join(s["ng_words"]) or None)
        self.blocked_users = discord.ui.TextInput(
            label="ブロックするユーザー ID", required=False,
            style=discord.TextStyle.paragraph, max_length=2000,
            default="\n".join(map(str, s["blocked_users"])) or None)
        self.blocked_guilds = discord.ui.TextInput(
            label="ブロックするサーバー ID", required=False,
            style=discord.TextStyle.paragraph, max_length=2000,
            default="\n".join(map(str, s["blocked_guilds"])) or None)
        for item in (self.ng_words, self.blocked_users, self.blocked_guilds):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。", ephemeral=True)
        words = mod.parse_words(self.ng_words.value)
        users = mod.parse_ids(self.blocked_users.value)
        guilds = [g for g in mod.parse_ids(self.blocked_guilds.value)
                  if g != self.parent_view.guild.id]
        await mod.save(self.parent_view.guild.id, ng_words=words,
                       blocked_users=users, blocked_guilds=guilds)
        await self.parent_view.refresh(
            interaction,
            f"{SUCCESS} 荒らし対策を保存しました（NG ワード {len(words)} 件・"
            f"ブロックしたユーザー {len(users)} 人・サーバー {len(guilds)} 件）。")


class GlobalChatSettingsView(discord.ui.View):
    """実行したチャンネルの接続状態と、このサーバーの荒らし対策を扱う画面。"""

    def __init__(self, cog: "GlobalChatSupportMixin", guild, channel):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild = guild
        self.channel = channel
        self.notice: str | None = None
        self.build()

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def _gc(self):
        return globalchat_cog(self.cog.bot)

    def build(self):
        self.clear_items()
        gc = self._gc()
        connected = gc is not None and self.channel.id in gc.active_channels
        toggle = discord.ui.Button(
            label="このチャンネルを外す" if connected else "このチャンネルをつなぐ",
            style=discord.ButtonStyle.danger if connected else discord.ButtonStyle.success,
            row=0,
        )
        toggle.callback = self.on_toggle
        self.add_item(toggle)
        moderation = discord.ui.Button(
            label="荒らし対策（NG ワード・ブロック）",
            style=discord.ButtonStyle.secondary, row=1,
        )
        moderation.callback = self.on_moderation
        self.add_item(moderation)

    def embed(self) -> discord.Embed:
        notice = self.notice
        gc = self._gc()
        embed = we(title="🌐 グローバルチャット", description=(
            "つないだチャンネルの発言が、ほかのサーバーのつないだチャンネルにも届きます。"
        ))
        if gc is None:
            embed.add_field(name="状態", value="グローバルチャットの機能が読み込まれていません")
            return embed
        connected = self.channel.id in gc.active_channels
        embed.add_field(
            name=f"#{getattr(self.channel, 'name', 'このチャンネル')}",
            value="つないでいます" if connected else "つないでいません")
        m = mod.settings(self.guild.id)
        embed.add_field(name="荒らし対策", value=(
            f"NG ワード: 既定 + {len(m['ng_words'])} 件／ブロック: ユーザー {len(m['blocked_users'])} 人・"
            f"サーバー {len(m['blocked_guilds'])} 件／連投: 10 秒に 5 件まで"), inline=False)
        others = [cid for cid in guild_globalchat_channel_ids(self.guild, gc)
                  if cid != self.channel.id]
        if others:
            embed.add_field(name="このサーバーのほかのチャンネル",
                            value=channel_list_text(others), inline=False)
        missing = missing_bot_permissions(self.channel)
        if connected and missing:
            embed.add_field(name="Bot の権限", value=(
                f"{FAILED} このチャンネルで足りない権限: " + "、".join(missing)),
                inline=False)
        if notice:
            embed.description = f"{notice}\n\n{embed.description or ''}".strip()
        return embed

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.build()
        self.notice = notice
        if interaction.response.is_done():
            await interaction.edit_original_response(
                content=None, embed=None, attachments=[], view=as_panel_v2(self))
        else:
            await edit_panel_v2(interaction, as_panel_v2(self))

    async def on_toggle(self, interaction: discord.Interaction):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。", ephemeral=True)
        gc = self._gc()
        if gc is None:
            return await interaction.response.send_message(
                "グローバルチャットの機能が読み込まれていません。", ephemeral=True)
        connect = self.channel.id not in gc.active_channels
        set_globalchat_connection(gc, self.channel.id, connect)
        await self.refresh(interaction, (
            SUCCESS + " このチャンネルをグローバルチャットにつなぎました。" if connect
            else SUCCESS + " このチャンネルをグローバルチャットから外しました。"))

    async def on_moderation(self, interaction: discord.Interaction):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。", ephemeral=True)
        await interaction.response.send_modal(GlobalChatModerationModal(self))


class GlobalChatSupportMixin:
    async def show_globalchat_settings(self, interaction: discord.Interaction):
        if interaction.guild is None or interaction.channel is None:
            return await interaction.response.send_message(
                "この設定はサーバー内のテキストチャンネルで利用できます。",
                ephemeral=True,
            )
        view = GlobalChatSettingsView(self, interaction.guild, interaction.channel)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)
