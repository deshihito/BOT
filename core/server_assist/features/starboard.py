"""Starboard: repost messages that receive enough star reactions."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "starboard"
DEFAULT_EMOJI = "⭐"
EMOJIS = ["⭐", "🌟", "✨", "❤️", "🔥", "👀"]
MAX_DESCRIPTION = 1800

FEATURE = Feature(
    key=KEY,
    label="Starboard",
    description="リアクションが集まったメッセージを、Starboardチャンネルへ転載します。",
    order=30,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None
_cache_lock: asyncio.Lock | None = None
_locks: dict[str, asyncio.Lock] = {}


def reset_cache() -> None:
    """Test helper: forget the in-memory starboard mapping."""
    global _entries, _cache, _cache_lock
    _entries = None
    _cache = None
    _cache_lock = None
    _locks.clear()


def _entry_store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_starboard")
    return _entries


async def _entries_cache() -> dict[str, dict[str, Any]]:
    global _cache, _cache_lock
    if _cache is None:
        if _cache_lock is None:
            _cache_lock = asyncio.Lock()
        async with _cache_lock:
            if _cache is None:
                _cache = dict(await _entry_store().load_all())
    return _cache


def _lock_for(key: str) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


def _entry_key(guild_id: int, message_id: int) -> str:
    return f"{guild_id}:{message_id}"


async def _put_entry(guild_id: int, message_id: int, entry: dict[str, Any]) -> None:
    cache = await _entries_cache()
    key = _entry_key(guild_id, message_id)
    cache[key] = dict(entry)
    await _entry_store().set(key, dict(entry))


async def _pop_entry(guild_id: int, message_id: int) -> dict[str, Any] | None:
    cache = await _entries_cache()
    key = _entry_key(guild_id, message_id)
    entry = cache.pop(key, None)
    if entry is not None:
        await _entry_store().delete(key)
    return entry


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    try:
        threshold = int(raw.get("threshold", 3))
    except (TypeError, ValueError):
        threshold = 3
    threshold = max(1, min(10, threshold))
    emoji = raw.get("emoji")
    if not isinstance(emoji, str) or not emoji.strip():
        emoji = DEFAULT_EMOJI
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "emoji": emoji[:64],
        "threshold": threshold,
        "allow_self": bool(raw.get("allow_self", False)),
    }


async def _reaction_count(message: Any, emoji: str, *, allow_self: bool) -> int:
    for reaction in getattr(message, "reactions", []) or []:
        if str(getattr(reaction, "emoji", "")) == emoji:
            try:
                total = int(reaction.count)
            except (TypeError, ValueError):
                return 0
            if allow_self:
                return total
            author_id = getattr(getattr(message, "author", None), "id", None)
            try:
                users = [user async for user in reaction.users()]
            except Exception:
                return total
            return sum(1 for user in users if getattr(user, "id", None) != author_id)
    return 0


def _author_icon(message: Any) -> str | None:
    author = getattr(message, "author", None)
    avatar = getattr(author, "display_avatar", None)
    return getattr(avatar, "url", None)


def build_board_embed(message: Any, count: int, emoji: str) -> discord.Embed:
    content = (getattr(message, "content", "") or "").strip()
    if not content:
        content = "*本文なし（添付ファイルのみ）*"
    embed = discord.Embed(description=content[:MAX_DESCRIPTION], color=0xFFFFFF)
    author = getattr(message, "author", None)
    name = getattr(author, "display_name", None) or getattr(author, "name", "メンバー")
    icon = _author_icon(message)
    if icon:
        embed.set_author(name=name, icon_url=icon)
    else:
        embed.set_author(name=name)
    channel = getattr(message, "channel", None)
    jump_url = getattr(message, "jump_url", None)
    channel_name = getattr(channel, "name", "チャンネル")
    if jump_url:
        embed.add_field(name="元メッセージ", value=f"[#{channel_name} へ飛ぶ]({jump_url})", inline=False)
    attachments = list(getattr(message, "attachments", []) or [])
    image = next((item for item in attachments if str(getattr(item, "content_type", "")).startswith("image/")), None)
    if image is not None:
        embed.set_image(url=getattr(image, "url", ""))
    embed.set_footer(text=f"{emoji} {count}")
    created_at = getattr(message, "created_at", None)
    if created_at is not None:
        embed.timestamp = created_at
    return embed


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


class StarboardChannelSelect(discord.ui.Select):
    def __init__(self, parent: "StarboardSettingsView"):
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
        super().__init__(placeholder="Starboardの送信先", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message(
                "Botが送信できるテキストチャンネルがありません。", ephemeral=True,
            )
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "Starboardの送信先を保存しました。")


class StarboardEmojiSelect(discord.ui.Select):
    def __init__(self, parent: "StarboardSettingsView"):
        self.parent_view = parent
        current = parent.settings["emoji"]
        options = [
            discord.SelectOption(label=emoji, value=emoji, default=emoji == current)
            for emoji in EMOJIS
        ]
        if current not in EMOJIS:
            options.append(discord.SelectOption(label=current, value=current, default=True))
        super().__init__(placeholder="反応に使う絵文字", options=options[:25], row=1)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        emoji = self.values[0][:64]
        await update_settings(self.parent_view.guild_id, KEY, emoji=emoji)
        self.parent_view.settings["emoji"] = emoji
        await self.parent_view.refresh(interaction, "Starboardの絵文字を保存しました。")


class StarboardThresholdSelect(discord.ui.Select):
    def __init__(self, parent: "StarboardSettingsView"):
        self.parent_view = parent
        current = parent.settings["threshold"]
        super().__init__(
            placeholder="転載するリアクション数",
            options=[
                discord.SelectOption(label=f"{value} 個", value=str(value), default=value == current)
                for value in range(1, 11)
            ],
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        threshold = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, threshold=threshold)
        self.parent_view.settings["threshold"] = threshold
        await self.parent_view.refresh(interaction, "Starboardのしきい値を保存しました。")


class StarboardToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="Starboard", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StarboardSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"Starboardを{'オン' if value else 'オフ'}にしました。")


class StarboardSelfButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="自己リアクション", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StarboardSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["allow_self"]
        await update_settings(view.guild_id, KEY, allow_self=value)
        view.settings["allow_self"] = value
        await view.refresh(
            interaction,
            f"自分のメッセージへのリアクションを{'許可' if value else '無視'}します。",
        )


class StarboardSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "Starboard"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(StarboardChannelSelect(self))
        self.add_item(StarboardEmojiSelect(self))
        self.add_item(StarboardThresholdSelect(self))
        self.add_item(StarboardToggleButton())
        self.add_item(StarboardSelfButton())

    def embed(self) -> discord.Embed:
        embed = discord.Embed(
            title="Starboard",
            description=(
                "リアクションが集まったメッセージを、別のチャンネルへ転載します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**送信先**: {channel_label(self.settings['channel_id'])}"
                f"\n**絵文字**: {self.settings['emoji']}"
                f"\n**しきい値**: {self.settings['threshold']} 個"
                f"\n**自分のメッセージへのリアクション**: {'許可' if self.settings['allow_self'] else '無視'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        if self.settings["channel_id"] is None:
            embed.add_field(
                name="はじめに",
                value="送信先チャンネルを選び、Starboardをオンにしてください。",
                inline=False,
            )
        return embed


async def _delete_board(guild: Any, entry: dict[str, Any]) -> None:
    channel = guild.get_channel(entry.get("channel_id"))
    board_id = entry.get("board_id")
    if channel is None or not board_id:
        return
    try:
        message = await channel.fetch_message(int(board_id))
        await message.delete()
    except (discord.NotFound, discord.Forbidden, discord.HTTPException):
        logger.debug("Starboardの転載を削除できませんでした: guild=%s board=%s", getattr(guild, "id", None), board_id)


async def _handle(cog: Any, payload: Any) -> None:
    guild = getattr(cog.bot, "get_guild", lambda _id: None)(getattr(payload, "guild_id", None))
    if guild is None:
        return
    current = settings(guild.id)
    if not current["enabled"] or current["channel_id"] is None:
        return
    if str(getattr(payload, "emoji", "")) != current["emoji"]:
        return
    if getattr(payload, "channel_id", None) == current["channel_id"]:
        return
    source_channel = guild.get_channel(getattr(payload, "channel_id", None))
    if source_channel is None:
        source_channel = getattr(cog.bot, "get_channel", lambda _id: None)(getattr(payload, "channel_id", None))
    if source_channel is None:
        return
    lock_key = f"{guild.id}:{getattr(payload, 'message_id', 0)}"
    async with _lock_for(lock_key):
        await _handle_locked(guild, payload, current, source_channel)


async def _handle_locked(guild: Any, payload: Any, current: dict[str, Any], source_channel: Any) -> None:
    try:
        message = await source_channel.fetch_message(int(payload.message_id))
    except (discord.NotFound, discord.Forbidden, discord.HTTPException):
        logger.debug("Starboardの元メッセージを取得できませんでした: %s", getattr(payload, "message_id", None))
        return
    if getattr(getattr(message, "author", None), "bot", False):
        return
    if not current["allow_self"] and getattr(getattr(message, "author", None), "id", None) == getattr(payload, "user_id", None):
        return
    count = await _reaction_count(message, current["emoji"], allow_self=current["allow_self"])
    key_guild = guild.id
    key_message = int(payload.message_id)
    entry = (await _entries_cache()).get(_entry_key(key_guild, key_message))
    if count < current["threshold"]:
        if entry is not None:
            await _delete_board(guild, entry)
            await _pop_entry(key_guild, key_message)
        return
    board_channel = guild.get_channel(current["channel_id"])
    if board_channel is None:
        return
    embed = build_board_embed(message, count, current["emoji"])
    if entry is not None:
        try:
            board = await board_channel.fetch_message(int(entry["board_id"]))
            await board.edit(embed=embed)
        except discord.NotFound:
            await _pop_entry(key_guild, key_message)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("Starboardの転載を更新できませんでした: guild=%s message=%s", guild.id, key_message)
            return
        else:
            await _put_entry(key_guild, key_message, {**entry, "count": count})
            return
    try:
        board = await board_channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
    except (discord.NotFound, discord.Forbidden, discord.HTTPException):
        logger.exception("Starboardへ転載できませんでした: guild=%s message=%s", guild.id, key_message)
        return
    await _put_entry(key_guild, key_message, {
        "board_id": int(getattr(board, "id", 0)),
        "channel_id": current["channel_id"],
        "count": count,
    })


async def on_raw_reaction_add(cog: Any, payload: Any) -> None:
    await _handle(cog, payload)


async def on_raw_reaction_remove(cog: Any, payload: Any) -> None:
    await _handle(cog, payload)


async def on_raw_message_delete(cog: Any, payload: Any) -> None:
    guild_id = getattr(payload, "guild_id", None)
    message_id = getattr(payload, "message_id", None)
    if guild_id is None or message_id is None:
        return
    entry = (await _entries_cache()).get(_entry_key(guild_id, int(message_id)))
    if entry is None:
        return
    guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
    if guild is not None:
        await _delete_board(guild, entry)
    await _pop_entry(guild_id, int(message_id))


def build_view(cog: Any, guild_id: int) -> StarboardSettingsView:
    return StarboardSettingsView(cog, guild_id)
