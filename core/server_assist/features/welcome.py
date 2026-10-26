"""Welcome and goodbye messages (ProBot-style join/leave notices)."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, format_template, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "welcome"
MAX_MESSAGE = 1500
DEFAULT_WELCOME = "**{user}** さん、{server} へようこそ！"
DEFAULT_GOODBYE = "**{name}** さんが退出しました。"

FEATURE = Feature(
    key=KEY,
    label="参加・退出メッセージ",
    description="メンバーの参加・退出を、選んだチャンネルへお知らせします。",
    order=10,
    module_name=__name__,
)

PLACEHOLDERS = "{user} / {name} / {server} / {count} / {id}"


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "welcome_enabled": bool(raw.get("welcome_enabled", False)),
        "goodbye_enabled": bool(raw.get("goodbye_enabled", False)),
        "welcome_channel_id": raw.get("welcome_channel_id") if isinstance(raw.get("welcome_channel_id"), int) else None,
        "goodbye_channel_id": raw.get("goodbye_channel_id") if isinstance(raw.get("goodbye_channel_id"), int) else None,
        "welcome_message": str(raw.get("welcome_message") or DEFAULT_WELCOME)[:MAX_MESSAGE],
        "goodbye_message": str(raw.get("goodbye_message") or DEFAULT_GOODBYE)[:MAX_MESSAGE],
    }


def _member_name(member: Any) -> str:
    return getattr(member, "display_name", None) or getattr(member, "name", "メンバー")


def _avatar_url(member: Any) -> str | None:
    avatar = getattr(member, "display_avatar", None)
    return getattr(avatar, "url", None)


def build_embed(member: Any, guild: Any, template: str, *, kind: str = "welcome") -> discord.Embed:
    embed = discord.Embed(
        description=format_template(template, member, guild),
        color=0xFFFFFF,
    )
    author = f"{_member_name(member)} さん"
    icon = _avatar_url(member)
    if icon:
        embed.set_author(name=author, icon_url=icon)
    else:
        embed.set_author(name=author)
    label = "参加" if kind == "welcome" else "退出"
    count = getattr(guild, "member_count", None)
    footer = f"{getattr(guild, 'name', 'サーバー')} • {label}"
    if isinstance(count, int) and count >= 0:
        footer += f" • {count}人"
    embed.set_footer(text=footer)
    embed.timestamp = discord.utils.utcnow()
    return embed


def _channels(guild: Any) -> list[Any]:
    channels = list(getattr(guild, "text_channels", []) or [])
    me = getattr(guild, "me", None)
    usable: list[Any] = []
    for channel in channels:
        if me is not None:
            try:
                permissions = channel.permissions_for(me)
            except Exception:
                permissions = None
            if permissions is not None and not getattr(permissions, "send_messages", False):
                continue
        usable.append(channel)
    return usable[:25]


class WelcomeChannelSelect(discord.ui.Select):
    def __init__(self, parent: "WelcomeSettingsView", kind: str):
        self.parent_view = parent
        self.kind = kind
        current = parent.settings["welcome_channel_id" if kind == "welcome" else "goodbye_channel_id"]
        options: list[discord.SelectOption] = []
        if kind == "goodbye":
            options.append(discord.SelectOption(
                label="参加メッセージと同じ",
                value="0",
                default=current is None,
            ))
        for channel in _channels(parent.guild):
            options.append(discord.SelectOption(
                label=str(getattr(channel, "name", "チャンネル"))[:100],
                value=str(channel.id),
                default=current == channel.id,
            ))
        if not options:
            options.append(discord.SelectOption(label="送信できるチャンネルがありません", value="__none__"))
        super().__init__(
            placeholder="参加メッセージの送信先" if kind == "welcome" else "退出メッセージの送信先",
            options=options[:25],
            row=0 if kind == "welcome" else 1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = self.values[0]
        if value == "__none__":
            return await interaction.response.send_message(
                "Botがメッセージを送信できるテキストチャンネルがありません。", ephemeral=True,
            )
        channel_id = None if value == "0" else int(value)
        field = "welcome_channel_id" if self.kind == "welcome" else "goodbye_channel_id"
        await update_settings(self.parent_view.guild_id, KEY, **{field: channel_id})
        self.parent_view.settings[field] = channel_id
        label = "参加" if self.kind == "welcome" else "退出"
        await self.parent_view.refresh(interaction, f"{label}メッセージの送信先を設定しました。")


class WelcomeToggleButton(discord.ui.Button):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(
            label="参加メッセージ" if kind == "welcome" else "退出メッセージ",
            style=discord.ButtonStyle.secondary,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        field = "welcome_enabled" if self.kind == "welcome" else "goodbye_enabled"
        value = not bool(view.settings.get(field))
        await update_settings(view.guild_id, KEY, **{field: value})
        view.settings[field] = value
        label = "参加" if self.kind == "welcome" else "退出"
        await view.refresh(interaction, f"{label}メッセージを{'オン' if value else 'オフ'}にしました。")


class WelcomeMessageButton(discord.ui.Button):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(
            label="参加文を編集" if kind == "welcome" else "退出文を編集",
            style=discord.ButtonStyle.primary,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(WelcomeMessageModal(view, self.kind))


class WelcomeTestButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="テスト送信", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        channel_id = view.settings.get("welcome_channel_id")
        channel = interaction.guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            return await interaction.response.send_message(
                "先に参加メッセージの送信先を選んでください。", ephemeral=True,
            )
        embed = build_embed(
            interaction.user, interaction.guild, view.settings["welcome_message"], kind="welcome",
        )
        try:
            await channel.send(
                embed=embed,
                allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=True),
            )
        except discord.HTTPException:
            logger.exception("参加メッセージのテスト送信に失敗しました: guild=%s", interaction.guild_id)
            return await interaction.response.send_message(
                "テスト送信に失敗しました。チャンネルの権限を確認してください。", ephemeral=True,
            )
        return await interaction.response.send_message("テストメッセージを送信しました。", ephemeral=True)


class WelcomeMessageModal(discord.ui.Modal):
    def __init__(self, parent: "WelcomeSettingsView", kind: str):
        super().__init__(title="参加メッセージを編集" if kind == "welcome" else "退出メッセージを編集")
        self.parent_view = parent
        self.kind = kind
        field = "welcome_message" if kind == "welcome" else "goodbye_message"
        self.text = discord.ui.TextInput(
            label="メッセージ",
            style=discord.TextStyle.paragraph,
            default=parent.settings.get(field, "")[:MAX_MESSAGE],
            max_length=MAX_MESSAGE,
            required=True,
            placeholder="例: {user} さん、ようこそ！",
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        field = "welcome_message" if self.kind == "welcome" else "goodbye_message"
        value = str(self.text.value or "").strip() or (
            DEFAULT_WELCOME if self.kind == "welcome" else DEFAULT_GOODBYE
        )
        await update_settings(self.parent_view.guild_id, KEY, **{field: value[:MAX_MESSAGE]})
        self.parent_view.settings[field] = value[:MAX_MESSAGE]
        await self.parent_view.refresh(interaction, "メッセージを保存しました。")


class WelcomeSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "参加・退出メッセージ"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        self.add_item(WelcomeChannelSelect(self, "welcome"))
        self.add_item(WelcomeChannelSelect(self, "goodbye"))
        self.add_item(WelcomeToggleButton("welcome"))
        self.add_item(WelcomeToggleButton("goodbye"))
        self.add_item(WelcomeMessageButton("welcome"))
        self.add_item(WelcomeMessageButton("goodbye"))
        self.add_item(WelcomeTestButton())

    def embed(self) -> discord.Embed:
        welcome = "オン" if self.settings["welcome_enabled"] else "オフ"
        goodbye = "オン" if self.settings["goodbye_enabled"] else "オフ"
        embed = discord.Embed(
            title="参加・退出メッセージ",
            description=(
                "メンバーが参加・退出したときに、設定したチャンネルへお知らせします。"
                f"\n\n**参加メッセージ**: {welcome} / 送信先: {channel_label(self.settings['welcome_channel_id'])}"
                f"\n**退出メッセージ**: {goodbye} / 送信先: {channel_label(self.settings['goodbye_channel_id'])}"
                f"\n\n使える置き換え: {PLACEHOLDERS}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        embed.add_field(
            name="参加メッセージの文面",
            value=self.settings["welcome_message"][:400],
            inline=False,
        )
        embed.add_field(
            name="退出メッセージの文面",
            value=self.settings["goodbye_message"][:400],
            inline=False,
        )
        return embed


async def _send(guild: Any, member: Any, kind: str, settings_value: dict[str, Any]) -> None:
    if kind == "welcome":
        channel_id = settings_value.get("welcome_channel_id")
        template = settings_value.get("welcome_message") or DEFAULT_WELCOME
    else:
        channel_id = settings_value.get("goodbye_channel_id") or settings_value.get("welcome_channel_id")
        template = settings_value.get("goodbye_message") or DEFAULT_GOODBYE
    if not channel_id:
        return
    channel = guild.get_channel(channel_id)
    if channel is None:
        return
    me = getattr(guild, "me", None)
    if me is not None:
        try:
            if not channel.permissions_for(me).send_messages:
                return
        except Exception:
            pass
    try:
        await channel.send(
            embed=build_embed(member, guild, template, kind=kind),
            allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=True),
        )
    except discord.HTTPException:
        logger.exception("参加・退出メッセージを送信できませんでした: guild=%s", getattr(guild, "id", None))


async def on_member_join(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None or getattr(member, "bot", False):
        return
    current = settings(guild.id)
    if current["welcome_enabled"]:
        await _send(guild, member, "welcome", current)


async def on_member_remove(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None or getattr(member, "bot", False):
        return
    current = settings(guild.id)
    if current["goodbye_enabled"]:
        await _send(guild, member, "goodbye", current)


def build_view(cog: Any, guild_id: int) -> WelcomeSettingsView:
    return WelcomeSettingsView(cog, guild_id)
