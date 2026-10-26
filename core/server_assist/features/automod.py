"""Configurable AutoMod filters for invite links, links, mentions, and caps."""
from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "automod"

FEATURE = Feature(
    key=KEY,
    label="AutoMod",
    description="招待リンク・外部リンク・メンションスパム・大文字スパムを自動削除します。",
    order=70,
    module_name=__name__,
)

INVITE_RE = re.compile(r"(?:discord(?:app)?\.(?:gg|com/invite)/[A-Za-z0-9-]+)", re.I)
LINK_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    try:
        max_mentions = int(raw.get("max_mentions", 5))
    except (TypeError, ValueError):
        max_mentions = 5
    try:
        caps_percent = int(raw.get("caps_percent", 70))
    except (TypeError, ValueError):
        caps_percent = 70
    try:
        timeout_minutes = int(raw.get("timeout_minutes", 0))
    except (TypeError, ValueError):
        timeout_minutes = 0
    return {
        "enabled": bool(raw.get("enabled", False)),
        "log_channel_id": raw.get("log_channel_id") if isinstance(raw.get("log_channel_id"), int) else None,
        "block_invites": bool(raw.get("block_invites", False)),
        "block_links": bool(raw.get("block_links", False)),
        "max_mentions": max(0, min(25, max_mentions)),
        "caps_percent": max(0, min(100, caps_percent)),
        "timeout_minutes": max(0, min(1440, timeout_minutes)),
    }


def detect_violation(content: str, mention_count: int, current: dict[str, Any]) -> str | None:
    text = content or ""
    if current.get("block_invites") and INVITE_RE.search(text):
        return "招待リンク"
    if current.get("block_links") and LINK_RE.search(text):
        return "外部リンク"
    max_mentions = int(current.get("max_mentions") or 0)
    if max_mentions and mention_count >= max_mentions:
        return f"メンションスパム（{mention_count}件）"
    caps_percent = int(current.get("caps_percent") or 0)
    letters = [char for char in text if char.isalpha()]
    if caps_percent and len(letters) >= 10:
        uppercase = sum(1 for char in letters if char.isupper())
        if uppercase * 100 / len(letters) >= caps_percent:
            return f"大文字スパム（{uppercase * 100 // len(letters)}%）"
    return None


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


def _exempt(message: Any) -> bool:
    guild = getattr(message, "guild", None)
    author = getattr(message, "author", None)
    if guild is None or author is None or getattr(author, "bot", False):
        return True
    permissions = getattr(author, "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_messages", False)
    )


def _log_embed(message: Any, reason: str, timeout_minutes: int) -> discord.Embed:
    embed = discord.Embed(
        title="AutoMod",
        description=f"理由: **{reason}**",
        color=0xFFFFFF,
    )
    embed.add_field(
        name="ユーザー",
        value=f"{getattr(message.author, 'mention', '')} / ID {getattr(message.author, 'id', '')}",
        inline=False,
    )
    embed.add_field(name="チャンネル", value=f"<#{getattr(message.channel, 'id', 0)}>", inline=False)
    content = (getattr(message, "content", "") or "").strip()
    embed.add_field(name="内容", value=(content[:1000] or "*本文なし*"), inline=False)
    if timeout_minutes:
        embed.set_footer(text=f"{timeout_minutes}分のタイムアウトも適用")
    return embed


async def on_message(cog: Any, message: Any) -> None:
    current = settings(getattr(getattr(message, "guild", None), "id", 0))
    if not current["enabled"] or _exempt(message):
        return
    reason = detect_violation(
        getattr(message, "content", "") or "",
        len(getattr(message, "mentions", []) or []),
        current,
    )
    if reason is None:
        return
    guild = message.guild
    me = getattr(guild, "me", None)
    channel = getattr(message, "channel", None)
    try:
        if me is None or channel is None or not channel.permissions_for(me).manage_messages:
            return
        await message.delete()
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        logger.debug("AutoMod: メッセージを削除できませんでした: %s", getattr(message, "id", None))
        return
    timeout_minutes = int(current.get("timeout_minutes") or 0)
    if timeout_minutes and hasattr(message.author, "timeout"):
        try:
            permissions = getattr(me, "guild_permissions", None)
            if getattr(permissions, "moderate_members", False):
                await message.author.timeout(
                    timedelta(minutes=timeout_minutes), reason=f"AutoMod: {reason}",
                )
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("AutoMod: タイムアウトできませんでした: %s", getattr(message.author, "id", None))
    log_channel = guild.get_channel(current["log_channel_id"]) if current["log_channel_id"] else None
    if log_channel is not None:
        try:
            await log_channel.send(embed=_log_embed(message, reason, timeout_minutes))
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("AutoMod: ログを送信できませんでした: %s", getattr(guild, "id", None))


class AutoModLogChannelSelect(discord.ui.Select):
    def __init__(self, parent: "AutoModSettingsView"):
        self.parent_view = parent
        current = parent.settings["log_channel_id"]
        options = [discord.SelectOption(label="ログを送らない", value="0", default=current is None)]
        options += [
            discord.SelectOption(
                label=str(getattr(channel, "name", "チャンネル"))[:100],
                value=str(channel.id),
                default=channel.id == current,
            )
            for channel in _channels(parent.guild)
        ]
        super().__init__(placeholder="AutoModのログ送信先", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = None if self.values[0] == "0" else int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, log_channel_id=channel_id)
        self.parent_view.settings["log_channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "AutoModのログ送信先を保存しました。")


class AutoModMentionSelect(discord.ui.Select):
    def __init__(self, parent: "AutoModSettingsView"):
        self.parent_view = parent
        current = parent.settings["max_mentions"]
        options = [discord.SelectOption(label="メンション制限なし", value="0", default=current == 0)]
        options += [
            discord.SelectOption(label=f"{value} 件以上", value=str(value), default=current == value)
            for value in (3, 5, 10)
        ]
        super().__init__(placeholder="メンションスパムのしきい値", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, max_mentions=value)
        self.parent_view.settings["max_mentions"] = value
        await self.parent_view.refresh(interaction, "メンション制限を保存しました。")


class AutoModCapsSelect(discord.ui.Select):
    def __init__(self, parent: "AutoModSettingsView"):
        self.parent_view = parent
        current = parent.settings["caps_percent"]
        options = [discord.SelectOption(label="大文字チェックなし", value="0", default=current == 0)]
        options += [
            discord.SelectOption(label=f"{value}% 以上", value=str(value), default=current == value)
            for value in (50, 70, 90)
        ]
        super().__init__(placeholder="大文字スパムのしきい値", options=options, row=2)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, caps_percent=value)
        self.parent_view.settings["caps_percent"] = value
        await self.parent_view.refresh(interaction, "大文字チェックを保存しました。")


class AutoModTimeoutSelect(discord.ui.Select):
    def __init__(self, parent: "AutoModSettingsView"):
        self.parent_view = parent
        current = parent.settings["timeout_minutes"]
        options = [discord.SelectOption(label="タイムアウトなし", value="0", default=current == 0)]
        options += [
            discord.SelectOption(label=f"{value} 分", value=str(value), default=current == value)
            for value in (1, 5, 10, 60)
        ]
        super().__init__(placeholder="違反時のタイムアウト", options=options, row=3)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, timeout_minutes=value)
        self.parent_view.settings["timeout_minutes"] = value
        await self.parent_view.refresh(interaction, "タイムアウト設定を保存しました。")


class AutoModToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="AutoMod", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        view: AutoModSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"AutoModを{'オン' if value else 'オフ'}にしました。")


class AutoModInvitesButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="招待リンク", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        view: AutoModSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["block_invites"]
        await update_settings(view.guild_id, KEY, block_invites=value)
        view.settings["block_invites"] = value
        await view.refresh(interaction, f"招待リンクの削除を{'オン' if value else 'オフ'}にしました。")


class AutoModLinksButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="外部リンク", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        view: AutoModSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["block_links"]
        await update_settings(view.guild_id, KEY, block_links=value)
        view.settings["block_links"] = value
        await view.refresh(interaction, f"外部リンクの削除を{'オン' if value else 'オフ'}にしました。")


class AutoModSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "AutoMod"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AutoModLogChannelSelect(self))
        self.add_item(AutoModMentionSelect(self))
        self.add_item(AutoModCapsSelect(self))
        self.add_item(AutoModTimeoutSelect(self))
        self.add_item(AutoModToggleButton())
        self.add_item(AutoModInvitesButton())
        self.add_item(AutoModLinksButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="AutoMod",
            description=(
                "荒らし対策のフィルターです。管理者と「メッセージの管理」権限を持つ人は対象外です。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**ログ**: {channel_label(self.settings['log_channel_id'])}"
                f"\n**招待リンク**: {'削除' if self.settings['block_invites'] else '許可'}"
                f"\n**外部リンク**: {'削除' if self.settings['block_links'] else '許可'}"
                f"\n**メンション**: {self.settings['max_mentions'] or '制限なし'}"
                f"\n**大文字**: {self.settings['caps_percent'] or 'チェックなし'}"
                f"\n**タイムアウト**: {self.settings['timeout_minutes'] or 'なし'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> AutoModSettingsView:
    return AutoModSettingsView(cog, guild_id)
