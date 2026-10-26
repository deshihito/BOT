"""Scheduled announcements posted by the server-assist hub."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import discord

from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "timed"
MAX_SCHEDULES = 10
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
CATCHUP_MINUTES = 2
try:
    TIMEZONE = ZoneInfo(os.getenv("TIMED_TIMEZONE", "Asia/Tokyo"))
except ZoneInfoNotFoundError:
    TIMEZONE = None

FEATURE = Feature(
    key=KEY,
    label="タイマー告知",
    description="毎日決まった時刻に、設定したメッセージを投稿します。",
    order=100,
    module_name=__name__,
)


def parse_time(value: str) -> tuple[int, int] | None:
    match = TIME_RE.fullmatch((value or "").strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _normalize(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    time_value = str(raw.get("time") or "").strip()
    if parse_time(time_value) is None:
        return None
    message = str(raw.get("message") or "").strip()
    if not message:
        return None
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "time": time_value.zfill(5),
        "message": message[:1500],
        "last_sent": str(raw.get("last_sent") or ""),
    }


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    schedules = []
    for item in raw.get("schedules") or []:
        normalized = _normalize(item)
        if normalized is not None:
            schedules.append(normalized)
    seen = set()
    unique = []
    for schedule in schedules:
        if schedule["id"] in seen:
            continue
        seen.add(schedule["id"])
        unique.append(schedule)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "schedules": unique[:MAX_SCHEDULES],
    }


async def _save(guild_id: int, schedules: list[dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, schedules=schedules[:MAX_SCHEDULES])


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


def due_schedules(current: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    today = now.date().isoformat()
    now_minutes = now.hour * 60 + now.minute
    due = []
    for schedule in current.get("schedules", []):
        parsed = parse_time(str(schedule.get("time") or ""))
        if parsed is None or schedule.get("last_sent") == today:
            continue
        scheduled_minutes = parsed[0] * 60 + parsed[1]
        if 0 <= now_minutes - scheduled_minutes <= CATCHUP_MINUTES:
            due.append(schedule)
    return due


async def send_due(guild: Any, current: dict[str, Any], now: datetime | None = None) -> None:
    if not current["enabled"] or current["channel_id"] is None:
        return
    now = now or (datetime.now(TIMEZONE) if TIMEZONE is not None else datetime.now())
    due = due_schedules(current, now)
    if not due:
        return
    channel = guild.get_channel(current["channel_id"])
    if channel is None:
        return
    sent_ids: list[str] = []
    for schedule in due:
        embed = discord.Embed(
            title="定期告知",
            description=schedule["message"][:4000],
            color=0xFFFFFF,
        )
        try:
            await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("タイマー告知を送信できませんでした: guild=%s", getattr(guild, "id", None))
            continue
        sent_ids.append(str(schedule.get("id")))
    if not sent_ids:
        return
    latest = list(settings(guild.id)["schedules"])
    changed = False
    for item in latest:
        if str(item.get("id")) in sent_ids and item.get("last_sent") != now.date().isoformat():
            item["last_sent"] = now.date().isoformat()
            changed = True
    if changed:
        await _save(guild.id, latest)


async def _runner(cog: Any) -> None:
    await cog.bot.wait_until_ready()
    while True:
        now = datetime.now(TIMEZONE) if TIMEZONE is not None else datetime.now()
        for guild in list(getattr(cog.bot, "guilds", []) or []):
            current = settings(guild.id)
            if current["enabled"]:
                await send_due(guild, current, now)
        await asyncio.sleep(20)


def start_tasks(cog: Any) -> None:
    task = asyncio.create_task(_runner(cog), name="server-assist-timed")
    getattr(cog, "_feature_tasks", []).append(task)


class TimedChannelSelect(discord.ui.Select):
    def __init__(self, parent: "TimedSettingsView"):
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
        super().__init__(placeholder="タイマー告知の送信先", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        await self.parent_view.reopen(interaction, "タイマー告知の送信先を保存しました。")


class TimedScheduleSelect(discord.ui.Select):
    def __init__(self, parent: "TimedSettingsView"):
        self.parent_view = parent
        options = [
            discord.SelectOption(
                label=f"{schedule['time']} — {schedule['message'][:40]}"[:100],
                value=schedule["id"],
                default=schedule["id"] == parent.selected_id,
            )
            for schedule in parent.settings["schedules"]
        ]
        if not options:
            options = [discord.SelectOption(label="告知はありません", value="__none__")]
        super().__init__(placeholder="編集・削除する告知を選択", options=options[:25], row=1)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            self.parent_view.selected_id = None
            return await interaction.response.send_message("告知がありません。", ephemeral=True)
        self.parent_view.selected_id = self.values[0]
        await self.parent_view.reopen(interaction, "告知を選択しました。")


class TimedAddButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="告知を追加", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if len(view.settings["schedules"]) >= MAX_SCHEDULES:
            return await interaction.response.send_message(
                f"告知は最大{MAX_SCHEDULES}件です。", ephemeral=True,
            )
        return await interaction.response.send_modal(TimedModal(view))


class TimedEditButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="編集", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        schedule = view.selected_schedule()
        if schedule is None:
            return await interaction.response.send_message("先に告知を選んでください。", ephemeral=True)
        return await interaction.response.send_modal(TimedModal(view, schedule))


class TimedDeleteButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="削除", style=discord.ButtonStyle.danger, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.selected_id is None:
            return await interaction.response.send_message("先に告知を選んでください。", ephemeral=True)
        schedules = [
            item for item in settings(view.guild_id)["schedules"]
            if item.get("id") != view.selected_id
        ]
        await _save(view.guild_id, schedules)
        view.selected_id = None
        await view.reopen(interaction, "告知を削除しました。")


class TimedToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="タイマー告知", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and not view.settings["channel_id"]:
            return await interaction.response.send_message("先に送信先を選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        await view.reopen(interaction, f"タイマー告知を{'オン' if value else 'オフ'}にしました。")


class TimedModal(discord.ui.Modal):
    def __init__(self, parent: "TimedSettingsView", schedule: dict[str, Any] | None = None):
        super().__init__(title="タイマー告知を編集" if schedule else "タイマー告知を追加")
        self.parent_view = parent
        self.schedule = schedule
        self.time_input = discord.ui.TextInput(
            label="時刻（HH:MM）",
            default=str((schedule or {}).get("time") or "12:00"),
            max_length=5,
            required=True,
            placeholder="例: 20:00",
        )
        self.message_input = discord.ui.TextInput(
            label="メッセージ",
            style=discord.TextStyle.paragraph,
            default=str((schedule or {}).get("message") or "")[:1500],
            max_length=1500,
            required=True,
        )
        self.add_item(self.time_input)
        self.add_item(self.message_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        time_text = str(self.time_input.value or "").strip()
        if parse_time(time_text) is None:
            return await interaction.response.send_message(
                "時刻は HH:MM（例: 20:00）で入力してください。", ephemeral=True,
            )
        message = str(self.message_input.value or "").strip()
        if not message:
            return await interaction.response.send_message("メッセージを入力してください。", ephemeral=True)
        schedules = list(settings(self.parent_view.guild_id)["schedules"])
        if self.schedule:
            found = False
            for item in schedules:
                if item.get("id") == self.schedule.get("id"):
                    item.update({"time": time_text.zfill(5), "message": message[:1500]})
                    found = True
                    break
            if not found:
                schedules.append({
                    "id": self.schedule.get("id"),
                    "time": time_text.zfill(5),
                    "message": message[:1500],
                    "last_sent": self.schedule.get("last_sent", ""),
                })
            selected = self.schedule.get("id")
        else:
            selected = uuid.uuid4().hex[:8]
            schedules.append({
                "id": selected,
                "time": time_text.zfill(5),
                "message": message[:1500],
                "last_sent": "",
            })
        await _save(self.parent_view.guild_id, schedules)
        self.parent_view.selected_id = selected
        await self.parent_view.reopen(interaction, "タイマー告知を保存しました。")


class TimedSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "タイマー告知"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        self.selected_id: str | None = None
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(TimedChannelSelect(self))
        self.add_item(TimedScheduleSelect(self))
        self.add_item(TimedAddButton())
        self.add_item(TimedEditButton())
        self.add_item(TimedDeleteButton())
        self.add_item(TimedToggleButton())

    def selected_schedule(self) -> dict[str, Any] | None:
        if self.selected_id is None:
            return None
        return next(
            (item for item in self.settings["schedules"] if item.get("id") == self.selected_id),
            None,
        )

    async def reopen(self, interaction: discord.Interaction, notice: str | None = None):
        view = TimedSettingsView(self.cog, self.guild_id)
        view.selected_id = self.selected_id
        view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    def embed(self) -> discord.Embed:
        lines = []
        for schedule in self.settings["schedules"]:
            mark = "▶ " if schedule.get("id") == self.selected_id else ""
            lines.append(f"{mark}{schedule['time']} — {schedule['message'][:80]}")
        return discord.Embed(
            title="タイマー告知",
            description=(
                "毎日決まった時刻に、設定したメッセージを投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**送信先**: {channel_label(self.settings['channel_id'])}"
                f"\n**登録数**: {len(self.settings['schedules'])}/{MAX_SCHEDULES}"
                f"\n\n{chr(10).join(lines) if lines else '告知はありません。'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> TimedSettingsView:
    return TimedSettingsView(cog, guild_id)
