"""Scheduled announcements and one-shot reminders posted by the server-assist hub."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import discord

from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.server_assist import Feature, get_settings, update_settings, usable_text_channels as _channels
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "timed"
MAX_SCHEDULES = 10
MAX_REMINDERS = 25
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
RELATIVE_RE = re.compile(r"^(\d+)\s*(秒|s|分|m|時間|h|日|d)?$")
REMINDER_MIN_SECONDS = 30
REMINDER_MAX_SECONDS = 30 * 24 * 3600
REMINDER_STALE_DAYS = 7
CATCHUP_MINUTES = 2
try:
    TIMEZONE = ZoneInfo(os.getenv("TIMED_TIMEZONE", "Asia/Tokyo"))
except ZoneInfoNotFoundError:
    TIMEZONE = None

FEATURE = Feature(
    key=KEY,
    label="タイマー告知",
    description="毎日決まった時刻の告知と、「10分後」などの一回限りのリマインダーを投稿します。",
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


def parse_relative_time(value: str) -> timedelta | None:
    """「10分」「2時間」「1日」「30m」「45」(分) のような相対指定を timedelta にする。"""
    match = RELATIVE_RE.fullmatch((value or "").strip())
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2) or "分"
    seconds = amount * {"秒": 1, "s": 1, "分": 60, "m": 60, "時間": 3600, "h": 3600, "日": 86400, "d": 86400}[unit]
    if not REMINDER_MIN_SECONDS <= seconds <= REMINDER_MAX_SECONDS:
        return None
    return timedelta(seconds=seconds)


def _parse_due_at(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _normalize_reminder(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    message = str(raw.get("message") or "").strip()
    due = _parse_due_at(raw.get("due_at"))
    user_id = raw.get("user_id")
    if not message or due is None or not isinstance(user_id, int):
        return None
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "user_id": user_id,
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "message": message[:500],
        "due_at": due.astimezone(timezone.utc).isoformat(),
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
    reminders = []
    seen_reminders = set()
    for item in raw.get("reminders") or []:
        normalized = _normalize_reminder(item)
        if normalized is not None and normalized["id"] not in seen_reminders:
            seen_reminders.add(normalized["id"])
            reminders.append(normalized)
    reminders.sort(key=lambda item: item["due_at"])
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "schedules": unique[:MAX_SCHEDULES],
        "reminders": reminders[:MAX_REMINDERS],
    }


async def _save(guild_id: int, schedules: list[dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, schedules=schedules[:MAX_SCHEDULES])


async def _save_reminders(guild_id: int, reminders: list[dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, reminders=reminders[:MAX_REMINDERS])


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


def due_reminders(current: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    due = []
    for reminder in current.get("reminders", []):
        parsed = _parse_due_at(reminder.get("due_at"))
        if parsed is not None and parsed <= now:
            due.append(reminder)
    return due


async def send_due_reminders(guild: Any, current: dict[str, Any], now: datetime | None = None) -> None:
    """期限が来たリマインダーを送って一覧から消す。再起動後も保存済みのため復旧する。

    7日以上過ぎたものは送らずに破棄する。
    """
    now = now or datetime.now(timezone.utc)
    due = due_reminders(current, now)
    if not due:
        return
    stale_before = now - timedelta(days=REMINDER_STALE_DAYS)
    done_ids: list[str] = []
    for reminder in due:
        due_at = _parse_due_at(reminder.get("due_at"))
        if due_at is not None and due_at < stale_before:
            done_ids.append(str(reminder.get("id")))
            continue
        channel_id = reminder.get("channel_id") or current.get("channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            continue
        embed = discord.Embed(
            title="リマインダー",
            description=str(reminder.get("message") or "")[:4000],
            color=0xFFFFFF,
        )
        try:
            await channel.send(
                content=f"<@{reminder['user_id']}>",
                embed=embed,
                allowed_mentions=discord.AllowedMentions(
                    users=[discord.Object(id=int(reminder["user_id"]))]),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("リマインダーを送信できませんでした: guild=%s", getattr(guild, "id", None))
            continue
        done_ids.append(str(reminder.get("id")))
    if not done_ids:
        return
    latest = list(settings(guild.id)["reminders"])
    remaining = [item for item in latest if str(item.get("id")) not in done_ids]
    if len(remaining) != len(latest):
        await _save_reminders(guild.id, remaining)


async def _runner(cog: Any) -> None:
    await cog.bot.wait_until_ready()
    while True:
        now = datetime.now(TIMEZONE) if TIMEZONE is not None else datetime.now()
        for guild in list(getattr(cog.bot, "guilds", []) or []):
            current = settings(guild.id)
            if current["enabled"]:
                await send_due(guild, current, now)
            if current["reminders"]:
                await send_due_reminders(guild, current)
        await asyncio.sleep(20)


def start_tasks(cog: Any) -> None:
    task = asyncio.create_task(_runner(cog), name="server-assist-timed")
    getattr(cog, "_feature_tasks", []).append(task)


class TimedChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "TimedSettingsView"):
        self.parent_view = parent
        current = parent.settings["channel_id"]
        super().__init__(
            placeholder="タイマー告知の送信先",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                if current is not None else []
            ),
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel = self.values[0] if self.values else None
        if channel is None:
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        me = getattr(self.parent_view.guild, "me", None)
        if me is not None and not getattr(channel.permissions_for(me), "send_messages", False):
            return await interaction.response.send_message("そのチャンネルにはBotが送信できません。", ephemeral=True)
        channel_id = channel.id
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


class ReminderModal(discord.ui.Modal):
    def __init__(self, parent: "TimedSettingsView"):
        super().__init__(title="リマインダーを追加")
        self.parent_view = parent
        self.after_input = discord.ui.TextInput(
            label="いつ通知するか",
            max_length=16,
            required=True,
            placeholder="例: 10分 / 2時間 / 1日 / 30m",
        )
        self.message_input = discord.ui.TextInput(
            label="メッセージ",
            style=discord.TextStyle.paragraph,
            max_length=500,
            required=True,
        )
        self.add_item(self.after_input)
        self.add_item(self.message_input)

    async def on_submit(self, interaction: discord.Interaction):
        delta = parse_relative_time(str(self.after_input.value or ""))
        if delta is None:
            return await interaction.response.send_message(
                "時間は「10分」「2時間」「1日」「30m」のように入力してください（30秒〜30日）。",
                ephemeral=True,
            )
        message = str(self.message_input.value or "").strip()
        if not message:
            return await interaction.response.send_message("メッセージを入力してください。", ephemeral=True)
        current = settings(self.parent_view.guild_id)
        if current["channel_id"] is None:
            return await interaction.response.send_message("先に送信先を選んでください。", ephemeral=True)
        if len(current["reminders"]) >= MAX_REMINDERS:
            return await interaction.response.send_message(
                f"リマインダーは最大{MAX_REMINDERS}件です。", ephemeral=True,
            )
        due_at = datetime.now(timezone.utc) + delta
        reminders = list(current["reminders"])
        reminders.append({
            "id": uuid.uuid4().hex[:8],
            "user_id": interaction.user.id,
            "channel_id": current["channel_id"],
            "message": message[:500],
            "due_at": due_at.isoformat(),
        })
        await _save_reminders(self.parent_view.guild_id, reminders)
        display = due_at.astimezone(TIMEZONE) if TIMEZONE is not None else due_at
        await self.parent_view.reopen(
            interaction, f"リマインダーを登録しました（{display.strftime('%m/%d %H:%M')}）。")


class ReminderAddButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="リマインダーを追加", style=discord.ButtonStyle.success, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        if view.settings["channel_id"] is None:
            return await interaction.response.send_message("先に送信先を選んでください。", ephemeral=True)
        if len(view.settings["reminders"]) >= MAX_REMINDERS:
            return await interaction.response.send_message(
                f"リマインダーは最大{MAX_REMINDERS}件です。", ephemeral=True,
            )
        return await interaction.response.send_modal(ReminderModal(view))


class ReminderDeleteSelect(discord.ui.Select):
    def __init__(self, cog: Any, guild_id: int, reminders: list[dict[str, Any]]):
        self.cog = cog
        self.guild_id = guild_id
        options = []
        for reminder in reminders:
            due = _parse_due_at(reminder.get("due_at"))
            display = due.astimezone(TIMEZONE) if due is not None and TIMEZONE is not None else due
            when = display.strftime("%m/%d %H:%M") if display is not None else "?"
            options.append(discord.SelectOption(
                label=f"{when} — {reminder['message'][:40]}"[:100],
                description=f"登録者: {reminder['user_id']}"[:100],
                value=reminder["id"],
            ))
        super().__init__(placeholder="削除するリマインダー", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        reminders = list(settings(self.guild_id)["reminders"])
        target = next((item for item in reminders if item.get("id") == self.values[0]), None)
        if target is None:
            return await interaction.response.send_message("そのリマインダーは既にありません。", ephemeral=True)
        parent = TimedSettingsView(self.cog, self.guild_id)
        if target["user_id"] != interaction.user.id and not parent.can_manage(interaction):
            return await interaction.response.send_message(
                "他人のリマインダーは削除できません。", ephemeral=True,
            )
        await _save_reminders(
            self.guild_id, [item for item in reminders if item.get("id") != self.values[0]])
        await interaction.response.send_message("リマインダーを削除しました。", ephemeral=True)
        self.view.stop()


class ReminderDeleteView(discord.ui.View):
    def __init__(self, cog: Any, guild_id: int, reminders: list[dict[str, Any]]):
        super().__init__(timeout=300)
        self.add_item(ReminderDeleteSelect(cog, guild_id, reminders))


class ReminderDeleteButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="リマインダーを削除", style=discord.ButtonStyle.danger, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: TimedSettingsView = self.view
        reminders = list(settings(view.guild_id)["reminders"])
        if not reminders:
            return await interaction.response.send_message("リマインダーがありません。", ephemeral=True)
        return await interaction.response.send_message(
            "削除するリマインダーを選んでください。",
            view=ReminderDeleteView(view.cog, view.guild_id, reminders),
            ephemeral=True,
        )


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
        self.add_item(ReminderAddButton())
        self.add_item(ReminderDeleteButton())

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
        reminder_lines = []
        for reminder in self.settings["reminders"][:10]:
            due = _parse_due_at(reminder.get("due_at"))
            display = due.astimezone(TIMEZONE) if due is not None and TIMEZONE is not None else due
            when = display.strftime("%m/%d %H:%M") if display is not None else "?"
            reminder_lines.append(f"{when} — <@{reminder['user_id']}> {reminder['message'][:60]}")
        return discord.Embed(
            title="タイマー告知",
            description=(
                "毎日決まった時刻に、設定したメッセージを投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**送信先**: {channel_label(self.settings['channel_id'])}"
                f"\n**登録数**: {len(self.settings['schedules'])}/{MAX_SCHEDULES}"
                f"\n\n{chr(10).join(lines) if lines else '告知はありません。'}"
                f"\n\n**リマインダー**: {len(self.settings['reminders'])}/{MAX_REMINDERS}件"
                + (f"\n{chr(10).join(reminder_lines)}" if reminder_lines else "")
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> TimedSettingsView:
    return TimedSettingsView(cog, guild_id)
