"""Create a thread for every message in a configured channel."""
from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "autothread"

ARCHIVE_CHOICES = {
    60: "1時間",
    1440: "1日",
    4320: "3日",
    10080: "1週間",
}
DEFAULT_ARCHIVE = 1440
SEEN_LIMIT = 1000
MAX_PENDING_TASKS = 100

_seen: "OrderedDict[int, None]" = OrderedDict()
_tasks: set[asyncio.Task] = set()

FEATURE = Feature(
    key=KEY,
    label="自動スレッド",
    description="指定したチャンネルの各メッセージにスレッドを作ります。",
    order=80,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channel_id = raw.get("channel_id")
    archive = raw.get("archive_minutes")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": (
            channel_id
            if isinstance(channel_id, int) and not isinstance(channel_id, bool)
            else None
        ),
        "archive_minutes": archive if archive in ARCHIVE_CHOICES else DEFAULT_ARCHIVE,
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


def _thread_name(message: Any) -> str:
    content = str(getattr(message, "content", "") or "").strip()
    first_line = content.splitlines()[0].strip() if content else ""
    return (first_line or "新しいスレッド")[:100]


def reset_state() -> None:
    _seen.clear()


def _remember(message_id: int) -> bool:
    if message_id in _seen:
        return False
    _seen[message_id] = None
    while len(_seen) > SEEN_LIMIT:
        _seen.popitem(last=False)
    return True


async def drain() -> None:
    """テスト用: バックグラウンドのスレッド作成が終わるまで待つ。"""
    if _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def shutdown(cog: Any = None) -> None:
    """Cog終了時に、待っているスレッド作成を止める。"""
    tasks = list(_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _create_thread(
    message: Any, name: str, archive_minutes: int, guild_id: Any, channel_id: Any,
) -> None:
    try:
        await message.create_thread(name=name, auto_archive_duration=archive_minutes)
    except Exception:
        logger.exception(
            "自動スレッドを作成できませんでした: guild=%s channel=%s",
            guild_id, channel_id,
        )


async def on_message(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    if guild is None:
        return
    current = settings(getattr(guild, "id", 0))
    if not current["enabled"] or current["channel_id"] is None:
        return
    author = getattr(message, "author", None)
    if author is None or getattr(author, "bot", False):
        return
    channel = getattr(message, "channel", None)
    if channel is None or getattr(channel, "id", None) != current["channel_id"]:
        return
    me = getattr(guild, "me", None)
    if me is not None:
        try:
            if not getattr(channel.permissions_for(me), "create_public_threads", False):
                return
        except Exception:
            pass
    message_id = getattr(message, "id", None)
    if message_id is not None:
        if not _remember(message_id):
            return
    if getattr(message, "thread", None) is not None:
        return
    create_thread = getattr(message, "create_thread", None)
    if not callable(create_thread):
        return
    if len(_tasks) >= MAX_PENDING_TASKS:
        logger.debug(
            "自動スレッドの待ちタスクが上限に達しました: guild=%s channel=%s",
            getattr(guild, "id", None), current["channel_id"],
        )
        return
    # レート制限待ちで他のサーバーアシスト処理を止めないよう、作成はバックグラウンドで行う。
    task = asyncio.create_task(
        _create_thread(
            message, _thread_name(message), current["archive_minutes"],
            getattr(guild, "id", None), current["channel_id"],
        )
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


class AutoThreadChannelSelect(discord.ui.Select):
    def __init__(self, parent: "AutoThreadSettingsView"):
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
            options = [discord.SelectOption(label="利用できるチャンネルがありません", value="__none__")]
        super().__init__(placeholder="自動スレッドを作るチャンネル", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("利用できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "自動スレッドのチャンネルを保存しました。")


class AutoThreadArchiveSelect(discord.ui.Select):
    def __init__(self, parent: "AutoThreadSettingsView"):
        self.parent_view = parent
        options = [
            discord.SelectOption(
                label=label,
                value=str(minutes),
                default=minutes == parent.settings["archive_minutes"],
            )
            for minutes, label in ARCHIVE_CHOICES.items()
        ]
        super().__init__(placeholder="スレッドの自動アーカイブ", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        minutes = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, archive_minutes=minutes)
        self.parent_view.settings["archive_minutes"] = minutes
        await self.parent_view.refresh(interaction, "自動アーカイブの時間を保存しました。")


class AutoThreadToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="自動スレッド", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoThreadSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["channel_id"] is None:
            return await interaction.response.send_message("先にチャンネルを選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"自動スレッドを{'オン' if value else 'オフ'}にしました。")


class AutoThreadSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "自動スレッド"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AutoThreadChannelSelect(self))
            self.add_item(AutoThreadArchiveSelect(self))
        self.add_item(AutoThreadToggleButton())

    def embed(self) -> discord.Embed:
        archive = ARCHIVE_CHOICES.get(self.settings["archive_minutes"], str(self.settings["archive_minutes"]))
        return discord.Embed(
            title="自動スレッド",
            description=(
                "指定したチャンネルにメッセージが投稿されると、自動でスレッドを作ります。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**対象チャンネル**: {channel_label(self.settings['channel_id'])}"
                f"\n**自動アーカイブ**: {archive}"
                "\n\nBotのメッセージは対象外です。Botに「公開スレッドを作成」権限が必要です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> AutoThreadSettingsView:
    return AutoThreadSettingsView(cog, guild_id)

