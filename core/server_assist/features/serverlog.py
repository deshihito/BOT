"""Server activity logs for joins, leaves, deletions, roles, and channels."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "serverlog"

FEATURE = Feature(
    key=KEY,
    label="サーバーログ",
    description="参加・退出、メッセージ削除、ロール/チャンネルの作成削除を記録します。",
    order=80,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "log_joins": bool(raw.get("log_joins", True)),
        "log_leaves": bool(raw.get("log_leaves", True)),
        "log_message_delete": bool(raw.get("log_message_delete", True)),
        "log_roles": bool(raw.get("log_roles", True)),
        "log_channels": bool(raw.get("log_channels", True)),
    }


def _channels(guild: Any) -> list[Any]:
    me = getattr(guild, "me", None)
    channels = list(getattr(guild, "text_channels", []) or [])
    usable: list[Any] = []
    for channel in channels:
        if me is not None:
            try:
                if not channel.permissions_for(me).send_messages:
                    continue
            except Exception:
                pass
        usable.append(channel)
    return usable[:25]


async def _send(guild: Any, current: dict[str, Any], embed: discord.Embed) -> None:
    if not current["enabled"] or current["channel_id"] is None:
        return
    channel = guild.get_channel(current["channel_id"])
    if channel is None:
        return
    try:
        await channel.send(embed=embed)
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("サーバーログを送信できませんでした: guild=%s", getattr(guild, "id", None))


def _member_embed(member: Any, title: str, color: int = 0xFFFFFF) -> discord.Embed:
    embed = discord.Embed(title=title, description=getattr(member, "mention", ""), color=color)
    embed.add_field(name="ユーザーID", value=str(getattr(member, "id", "")), inline=True)
    created = getattr(member, "created_at", None)
    if created is not None:
        embed.add_field(name="アカウント作成", value=discord.utils.format_dt(created, "R"), inline=True)
    joined = getattr(member, "joined_at", None)
    if joined is not None:
        embed.add_field(name="参加日時", value=discord.utils.format_dt(joined, "R"), inline=True)
    roles = [role for role in (getattr(member, "roles", None) or []) if not getattr(role, "is_default", lambda: False)()]
    if roles:
        embed.add_field(name="ロール", value=" ".join(getattr(role, "mention", "") for role in roles[:10]), inline=False)
    return embed


async def on_member_join(cog: Any, member: Any) -> None:
    current = settings(member.guild.id)
    if not current["log_joins"]:
        return
    await _send(member.guild, current, _member_embed(member, "メンバー参加"))


async def on_member_remove(cog: Any, member: Any) -> None:
    current = settings(member.guild.id)
    if not current["log_leaves"]:
        return
    await _send(member.guild, current, _member_embed(member, "メンバー退出", 0xFFFFFF))


async def on_message_delete(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    if guild is None:
        return
    current = settings(guild.id)
    if not current["log_message_delete"]:
        return
    embed = discord.Embed(title="メッセージ削除", color=0xFFFFFF)
    author = getattr(message, "author", None)
    embed.add_field(
        name="投稿者",
        value=f"{getattr(author, 'mention', '')} / ID {getattr(author, 'id', '')}",
        inline=False,
    )
    embed.add_field(name="チャンネル", value=f"<#{getattr(message.channel, 'id', 0)}>", inline=False)
    content = (getattr(message, "content", "") or "").strip()
    embed.add_field(name="内容", value=(content[:1500] or "*本文なし*"), inline=False)
    attachments = list(getattr(message, "attachments", []) or [])
    if attachments:
        embed.add_field(name="添付", value=f"{len(attachments)}件", inline=False)
    await _send(guild, current, embed)


async def on_guild_role_create(cog: Any, role: Any) -> None:
    current = settings(role.guild.id)
    if not current["log_roles"]:
        return
    embed = discord.Embed(title="ロール作成", description=getattr(role, "mention", ""), color=0xFFFFFF)
    embed.add_field(name="名前", value=str(getattr(role, "name", "")), inline=True)
    embed.add_field(name="ID", value=str(getattr(role, "id", "")), inline=True)
    await _send(role.guild, current, embed)


async def on_guild_role_delete(cog: Any, role: Any) -> None:
    current = settings(role.guild.id)
    if not current["log_roles"]:
        return
    embed = discord.Embed(title="ロール削除", color=0xFFFFFF)
    embed.add_field(name="名前", value=str(getattr(role, "name", "")), inline=True)
    embed.add_field(name="ID", value=str(getattr(role, "id", "")), inline=True)
    await _send(role.guild, current, embed)


async def on_guild_channel_create(cog: Any, channel: Any) -> None:
    guild = channel.guild
    current = settings(guild.id)
    if not current["log_channels"]:
        return
    embed = discord.Embed(title="チャンネル作成", description=getattr(channel, "mention", ""), color=0xFFFFFF)
    embed.add_field(name="名前", value=str(getattr(channel, "name", "")), inline=True)
    embed.add_field(name="種類", value=str(getattr(channel, "type", "")), inline=True)
    await _send(guild, current, embed)


async def on_guild_channel_delete(cog: Any, channel: Any) -> None:
    guild = channel.guild
    current = settings(guild.id)
    if not current["log_channels"]:
        return
    embed = discord.Embed(title="チャンネル削除", color=0xFFFFFF)
    embed.add_field(name="名前", value=str(getattr(channel, "name", "")), inline=True)
    embed.add_field(name="種類", value=str(getattr(channel, "type", "")), inline=True)
    await _send(guild, current, embed)


class ServerLogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "ServerLogSettingsView"):
        self.parent_view = parent
        current = parent.settings["channel_id"]
        super().__init__(placeholder="サーバーログの送信先", channel_types=[discord.ChannelType.text, discord.ChannelType.news],
                         min_values=0, max_values=1,
                         default_values=([discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                                         if current is not None else []), row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not self.values:
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = self.values[0].id
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "サーバーログの送信先を保存しました。")


class ServerLogToggleButton(discord.ui.Button):
    def __init__(self, key: str, label: str, row: int = 2):
        self.key = key
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=row)

    async def callback(self, interaction: discord.Interaction):
        view: ServerLogSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.key == "enabled" and not view.settings["enabled"] and not view.settings["channel_id"]:
            return await interaction.response.send_message("先にログの送信先を選んでください。", ephemeral=True)
        value = not bool(view.settings[self.key])
        await update_settings(view.guild_id, KEY, **{self.key: value})
        view.settings[self.key] = value
        await view.refresh(interaction, "サーバーログの設定を更新しました。")


class ServerLogSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "サーバーログ"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(ServerLogChannelSelect(self))
        self.add_item(ServerLogToggleButton("enabled", "サーバーログ", row=2))
        self.add_item(ServerLogToggleButton("log_joins", "参加", row=2))
        self.add_item(ServerLogToggleButton("log_leaves", "退出", row=2))
        self.add_item(ServerLogToggleButton("log_message_delete", "削除", row=2))
        self.add_item(ServerLogToggleButton("log_roles", "ロール", row=2))
        self.add_item(ServerLogToggleButton("log_channels", "チャンネル", row=3))

    def embed(self) -> discord.Embed:
        on_off = lambda value: "オン" if value else "オフ"
        return discord.Embed(
            title="サーバーログ",
            description=(
                "サーバー内の出来事をログチャンネルへ記録します。"
                f"\n\n**状態**: {on_off(self.settings['enabled'])}"
                f"\n**送信先**: {channel_label(self.settings['channel_id'])}"
                f"\n**参加**: {on_off(self.settings['log_joins'])}"
                f"\n**退出**: {on_off(self.settings['log_leaves'])}"
                f"\n**メッセージ削除**: {on_off(self.settings['log_message_delete'])}"
                f"\n**ロール**: {on_off(self.settings['log_roles'])}"
                f"\n**チャンネル**: {on_off(self.settings['log_channels'])}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> ServerLogSettingsView:
    return ServerLogSettingsView(cog, guild_id)
