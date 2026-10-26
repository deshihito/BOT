"""Admin embed builder: compose an embed and post it to a configured channel."""
from __future__ import annotations

import logging
import re
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "embed"
COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")

FEATURE = Feature(
    key=KEY,
    label="埋め込みビルダー",
    description="タイトル・本文・色・フッターを指定してEmbedを投稿します。",
    order=90,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channel_id = raw.get("channel_id")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": (
            channel_id
            if isinstance(channel_id, int) and not isinstance(channel_id, bool)
            else None
        ),
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


def parse_color(value: Any) -> int | None:
    """#RRGGBB / RRGGBB を色へ。空なら None、形式違いは ValueError。"""
    text = str(value or "").strip()
    if not text:
        return None
    match = COLOR_RE.match(text)
    if match is None:
        raise ValueError("invalid color")
    return int(match.group(1), 16)


class EmbedCreateModal(discord.ui.Modal, title="埋め込みを作成"):
    def __init__(self, guild_id: int):
        super().__init__()
        self.guild_id = guild_id
        self.title_input = discord.ui.TextInput(
            label="タイトル",
            max_length=256,
            required=True,
        )
        self.body_input = discord.ui.TextInput(
            label="本文",
            style=discord.TextStyle.paragraph,
            max_length=4000,
            required=True,
        )
        self.color_input = discord.ui.TextInput(
            label="色（#RRGGBB）",
            max_length=7,
            required=False,
            placeholder="#5865F2",
        )
        self.footer_input = discord.ui.TextInput(
            label="フッター",
            max_length=2048,
            required=False,
        )
        self.add_item(self.title_input)
        self.add_item(self.body_input)
        self.add_item(self.color_input)
        self.add_item(self.footer_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("埋め込みビルダーは現在オフです。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"])
        if channel is None:
            return await interaction.response.send_message("投稿先のチャンネルが見つかりません。", ephemeral=True)
        try:
            color = parse_color(self.color_input.value)
        except ValueError:
            return await interaction.response.send_message(
                "色は #RRGGBB の形式で指定してください。", ephemeral=True,
            )
        await interaction.response.defer(ephemeral=True)
        embed = discord.Embed(
            title=str(self.title_input.value or "")[:256],
            description=str(self.body_input.value or "")[:4000],
            color=color if color is not None else 0xFFFFFF,
        )
        footer = str(self.footer_input.value or "").strip()
        if footer:
            embed.set_footer(text=footer[:2048])
        try:
            await channel.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("Embedを送信できませんでした: guild=%s", interaction.guild_id)
            return await interaction.followup.send("Embedを送信できませんでした。", ephemeral=True)
        return await interaction.followup.send(f"{channel.mention} に送信しました。", ephemeral=True)


async def handle_create(interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["channel_id"] is None:
        return await interaction.response.send_message("埋め込みビルダーは現在オフです。", ephemeral=True)
    return await interaction.response.send_modal(EmbedCreateModal(interaction.guild_id))


class EmbedChannelSelect(discord.ui.Select):
    def __init__(self, parent: "EmbedSettingsView"):
        self.parent_view = parent
        current = parent.settings["channel_id"]
        options = [
            discord.SelectOption(
                label=str(getattr(channel, "name", "チャンネル"))[:100],
                value=str(channel.id),
                default=channel.id == current,
            )
            for channel in _channels(parent.guild)
        ]
        if not options:
            options = [discord.SelectOption(label="送信できるチャンネルがありません", value="__none__")]
        super().__init__(placeholder="Embedを投稿するチャンネル", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "投稿先のチャンネルを保存しました。")


class EmbedToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="埋め込みビルダー", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EmbedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["channel_id"] is None:
            return await interaction.response.send_message("先に投稿先を選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"埋め込みビルダーを{'オン' if value else 'オフ'}にしました。")


class EmbedCreateButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="埋め込みを作成", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EmbedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] or view.settings["channel_id"] is None:
            return await interaction.response.send_message(
                "先に投稿先を選び、埋め込みビルダーをオンにしてください。", ephemeral=True,
            )
        return await interaction.response.send_modal(EmbedCreateModal(view.guild_id))


class EmbedSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "埋め込みビルダー"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(EmbedChannelSelect(self))
        self.add_item(EmbedToggleButton())
        self.add_item(EmbedCreateButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="埋め込みビルダー",
            description=(
                "タイトル・本文・色・フッターを指定して、Embedを投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**投稿先**: {channel_label(self.settings['channel_id'])}"
                "\n\n「埋め込みを作成」から内容を入力してください。色は #RRGGBB 形式（空欄は白）です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> EmbedSettingsView:
    return EmbedSettingsView(cog, guild_id)

