"""Server stat voice-channel counters."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "stats"
INTERVAL_SECONDS = 600

FEATURE = Feature(
    key=KEY,
    label="サーバースタッツ",
    description="メンバー数・オンライン数・ブースト数をVC名に反映します。",
    order=90,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    def channel_id(name: str) -> int | None:
        value = raw.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) else None
    return {
        "enabled": bool(raw.get("enabled", False)),
        "member_channel_id": channel_id("member_channel_id"),
        "online_channel_id": channel_id("online_channel_id"),
        "boost_channel_id": channel_id("boost_channel_id"),
    }


def _counts(guild: Any) -> dict[str, int]:
    members = list(getattr(guild, "members", []) or [])
    member_count = getattr(guild, "member_count", None)
    if not isinstance(member_count, int):
        member_count = len(members)
    online = sum(
        1 for member in members
        if not getattr(member, "bot", False)
        and getattr(member, "status", None) != discord.Status.offline
    )
    boosts = getattr(guild, "premium_subscription_count", 0) or 0
    return {"member": member_count, "online": online, "boost": int(boosts)}


async def update_stats(guild: Any, current: dict[str, Any]) -> None:
    if not current["enabled"]:
        return
    counts = _counts(guild)
    labels = {"member": "メンバー", "online": "オンライン", "boost": "ブースト"}
    for key, label in labels.items():
        channel_id = current.get(f"{key}_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            continue
        name = f"{label}: {counts[key]}"
        if getattr(channel, "name", None) == name:
            continue
        try:
            await channel.edit(name=name, reason="Server stats")
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("サーバースタッツを更新できませんでした: guild=%s channel=%s", getattr(guild, "id", None), channel_id)


async def _runner(cog: Any) -> None:
    await cog.bot.wait_until_ready()
    while True:
        for guild in list(getattr(cog.bot, "guilds", []) or []):
            current = settings(guild.id)
            if current["enabled"]:
                await update_stats(guild, current)
        await asyncio.sleep(INTERVAL_SECONDS)


def start_tasks(cog: Any) -> None:
    task = asyncio.create_task(_runner(cog), name="server-assist-stats")
    getattr(cog, "_feature_tasks", []).append(task)


class StatsChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "StatsSettingsView", kind: str):
        self.parent_view = parent
        self.kind = kind
        current = parent.settings.get(f"{kind}_channel_id")
        labels = {"member": "メンバー数", "online": "オンライン数", "boost": "ブースト数"}
        super().__init__(
            placeholder=f"{labels.get(kind, kind)}を表示するVC",
            channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice],
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                if current is not None else []
            ),
            row=0 if kind == "member" else 1 if kind == "online" else 2,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel = self.values[0] if self.values else None
        if channel is not None:
            me = getattr(self.parent_view.guild, "me", None)
            if me is not None and not getattr(channel.permissions_for(me), "manage_channels", False):
                return await interaction.response.send_message("そのVCを管理する権限がありません。", ephemeral=True)
        value = getattr(channel, "id", None)
        field = f"{self.kind}_channel_id"
        await update_settings(self.parent_view.guild_id, KEY, **{field: value})
        self.parent_view.settings[field] = value
        await self.parent_view.refresh(interaction, "スタッツの表示先を保存しました。")


class StatsToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="サーバースタッツ", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StatsSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and not any(
            view.settings[key] for key in ("member_channel_id", "online_channel_id", "boost_channel_id")
        ):
            return await interaction.response.send_message("先に表示先のVCを選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"サーバースタッツを{'オン' if value else 'オフ'}にしました。")


class StatsRefreshButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="今すぐ更新", style=discord.ButtonStyle.success, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StatsSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not view.settings["enabled"]:
            return await interaction.response.send_message(
                "先にサーバースタッツをオンにしてください。", ephemeral=True,
            )
        await update_stats(interaction.guild, view.settings)
        return await interaction.response.send_message("スタッツを更新しました。", ephemeral=True)


class StatsSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "サーバースタッツ"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(StatsChannelSelect(self, "member"))
            self.add_item(StatsChannelSelect(self, "online"))
            self.add_item(StatsChannelSelect(self, "boost"))
        self.add_item(StatsToggleButton())
        self.add_item(StatsRefreshButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="サーバースタッツ",
            description=(
                "既存のボイスチャンネル名を、定期的にサーバー統計へ更新します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**メンバー数**: {channel_label(self.settings['member_channel_id'])}"
                f"\n**オンライン数**: {channel_label(self.settings['online_channel_id'])}"
                f"\n**ブースト数**: {channel_label(self.settings['boost_channel_id'])}"
                "\n\n更新間隔は10分です。チャンネル名の変更には「チャンネルの管理」権限が必要です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> StatsSettingsView:
    return StatsSettingsView(cog, guild_id)
