"""Automatically add configured reactions to messages in a channel."""
from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "autoreact"
MAX_EMOJIS = 10
SEEN_LIMIT = 1000
MAX_TASKS = 100
_SPLIT = re.compile(r"[,、\n]+")

FEATURE = Feature(
    key=KEY,
    label="自動リアクション",
    description="指定チャンネルのメッセージに自動でリアクションを付けます。",
    order=110,
    module_name=__name__,
)

_seen: "OrderedDict[int, None]" = OrderedDict()
_tasks: set[asyncio.Task] = set()


def reset_state() -> None:
    _seen.clear()


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    emojis = raw.get("emojis")
    cleaned = []
    if isinstance(emojis, list):
        for emoji in emojis:
            if isinstance(emoji, str) and emoji.strip() and emoji not in cleaned:
                cleaned.append(emoji.strip())
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": _as_int(raw.get("channel_id")),
        "emojis": cleaned[:MAX_EMOJIS],
    }


def parse_emojis(value: Any) -> list[str]:
    result: list[str] = []
    for token in _SPLIT.split(str(value or "")):
        token = token.strip()
        if token and token not in result:
            result.append(token[:100])
    return result[:MAX_EMOJIS]


def _can_manage(interaction: discord.Interaction) -> bool:
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


def _remember(message_id: int) -> bool:
    if message_id in _seen:
        return False
    _seen[message_id] = None
    while len(_seen) > SEEN_LIMIT:
        _seen.popitem(last=False)
    return True


async def drain() -> None:
    """テスト用: バックグラウンドのリアクション付与が終わるまで待つ。"""
    if _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def shutdown(cog: Any = None) -> None:
    """Cog終了時に、待っているリアクション付与を止める。"""
    tasks = list(_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _add_reactions(message: Any, emojis: list[str]) -> None:
    for emoji in emojis:
        try:
            await message.add_reaction(emoji)
        except Exception:
            logger.exception(
                "自動リアクションを付けられませんでした: message=%s emoji=%s",
                getattr(message, "id", None), emoji,
            )


async def on_message(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    if guild is None:
        return
    current = settings(getattr(guild, "id", 0))
    if not current["enabled"] or current["channel_id"] is None or not current["emojis"]:
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
            permissions = channel.permissions_for(me)
            if not getattr(permissions, "read_message_history", False):
                return
            if not getattr(permissions, "add_reactions", False):
                return
        except Exception:
            pass
    add_reaction = getattr(message, "add_reaction", None)
    if not callable(add_reaction):
        return
    message_id = getattr(message, "id", None)
    if message_id is not None and not _remember(message_id):
        return
    if len(_tasks) >= MAX_TASKS:
        logger.debug("自動リアクションの待ちタスクが上限に達しました: guild=%s", getattr(guild, "id", None))
        return
    # レート制限待ちで他のサーバーアシスト処理を止めないよう、付与はバックグラウンドで行う。
    task = asyncio.create_task(_add_reactions(message, list(current["emojis"])))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


class AutoReactEmojiModal(discord.ui.Modal, title="自動リアクション"):
    def __init__(self, guild_id: int):
        super().__init__()
        self.guild_id = guild_id
        self.emoji_input = discord.ui.TextInput(
            label="絵文字（カンマか改行で区切る）",
            style=discord.TextStyle.paragraph,
            max_length=1000,
            required=True,
            placeholder="👍, 🎉, <:custom:123456789>",
        )
        self.add_item(self.emoji_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not _can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        emojis = parse_emojis(self.emoji_input.value)
        if not emojis:
            return await interaction.response.send_message("絵文字を1つ以上入力してください。", ephemeral=True)
        await update_settings(interaction.guild_id, KEY, emojis=emojis)
        return await interaction.response.send_message(
            f"自動リアクションを{len(emojis)}個保存しました。", ephemeral=True,
        )


class AutoReactChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "AutoReactSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="自動リアクションを付けるチャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = self.values[0].id
        channel = self.parent_view.guild.get_channel(channel_id)
        me = getattr(self.parent_view.guild, "me", None)
        if channel is not None and me is not None:
            try:
                if not channel.permissions_for(me).send_messages:
                    return await interaction.response.send_message(
                        "そのチャンネルには送信できません。", ephemeral=True,
                    )
            except Exception:
                pass
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "自動リアクションのチャンネルを保存しました。")


class AutoReactEmojiButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="リアクションを設定", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoReactSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(AutoReactEmojiModal(view.guild_id))


class AutoReactToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="自動リアクション", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoReactSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and (
            view.settings["channel_id"] is None or not view.settings["emojis"]
        ):
            return await interaction.response.send_message(
                "先にチャンネルとリアクションを設定してください。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"自動リアクションを{'オン' if value else 'オフ'}にしました。")


class AutoReactSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "自動リアクション"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AutoReactChannelSelect(self))
        self.add_item(AutoReactEmojiButton())
        self.add_item(AutoReactToggleButton())

    def embed(self) -> discord.Embed:
        emojis = " ".join(self.settings["emojis"]) or "未設定"
        return discord.Embed(
            title="自動リアクション",
            description=(
                "指定したチャンネルのユーザー投稿へ、自動でリアクションを付けます。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**対象チャンネル**: {channel_label(self.settings['channel_id'])}"
                f"\n**リアクション**: {emojis[:1000]}"
                f"\n\n最大{MAX_EMOJIS}個まで。Botの投稿は対象外です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> AutoReactSettingsView:
    return AutoReactSettingsView(cog, guild_id)

