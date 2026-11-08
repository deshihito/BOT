"""Server stat voice-channel counters."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from core.support.server_assist import as_int, Feature, get_settings, update_settings
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, channel_permission_check, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED

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
        return as_int(raw.get(name))
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


class StatsRefreshButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="今すぐ更新", style=discord.ButtonStyle.success, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StatsSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not view.settings["enabled"]:
            return await interaction.response.send_message(
                "先にサーバースタッツをオンにしてください。", ephemeral=True,
            )
        await update_stats(interaction.guild, view.settings)
        return await interaction.response.send_message("スタッツを更新しました。")


class StatsSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="member_channel_id", placeholder="メンバー数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=0, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
            self.add_item(AssistChannelSelect(self, field="online_channel_id", placeholder="オンライン数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=1, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
            self.add_item(AssistChannelSelect(self, field="boost_channel_id", placeholder="ブースト数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=2, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
        self.add_item(AssistToggleButton("enabled", "サーバースタッツ", row=3, require=lambda view, interaction, value: "先に表示先のVCを選んでください。" if value and not any(view.settings[key] for key in ("member_channel_id", "online_channel_id", "boost_channel_id")) else None))
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
