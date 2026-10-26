"""Suggestion box with a panel, submission modal, and vote buttons."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "suggestions"

FEATURE = Feature(
    key=KEY,
    label="提案箱",
    description="サーバーへの提案を募集し、賛成・反対の票を集めます。",
    order=60,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None


def _entry_store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_suggestions")
    return _entries


async def _entries_cache() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = dict(await _entry_store().load_all())
    return _cache


async def _put_entry(message_id: int, entry: dict[str, Any]) -> None:
    key = str(message_id)
    cache = await _entries_cache()
    cache[key] = dict(entry)
    await _entry_store().set(key, dict(entry))


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channel_id = raw.get("channel_id")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": channel_id if isinstance(channel_id, int) and not isinstance(channel_id, bool) else None,
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


def build_panel_embed() -> discord.Embed:
    return discord.Embed(
        title="提案箱",
        description=(
            "サーバーへの提案を募集しています。"
            "\n下の「提案する」ボタンから、タイトルと内容を送ってください。"
            "\n投稿された提案には、誰でも賛成・反対を投票できます。"
        ),
        color=0xFFFFFF,
    )


def build_embed(entry: dict[str, Any]) -> discord.Embed:
    up = len(entry.get("up") or [])
    down = len(entry.get("down") or [])
    embed = discord.Embed(
        title=str(entry.get("title") or "提案")[:256],
        description=str(entry.get("body") or "")[:4000],
        color=0xFFFFFF,
    )
    embed.add_field(name="賛成", value=str(up), inline=True)
    embed.add_field(name="反対", value=str(down), inline=True)
    embed.add_field(name="状態", value=str(entry.get("status") or "受付中"), inline=True)
    embed.set_footer(text=f"提案者: {entry.get('author_name') or 'メンバー'}"[:2048])
    return embed


class SuggestionCreateView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)

    @discord.ui.button(label="提案する", style=discord.ButtonStyle.primary,
                       custom_id="assist:suggestion:create", row=0)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_suggestion_create(interaction)


class SuggestionVoteView(discord.ui.View):
    def __init__(self, cog: Any, up: int = 0, down: int = 0):
        self.cog = cog
        super().__init__(timeout=None)
        self.children[0].label = f"賛成 {up}"
        self.children[1].label = f"反対 {down}"

    @discord.ui.button(label="賛成", style=discord.ButtonStyle.success,
                       custom_id="assist:suggestion:up", row=0)
    async def upvote(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_suggestion_vote(interaction, "up")

    @discord.ui.button(label="反対", style=discord.ButtonStyle.danger,
                       custom_id="assist:suggestion:down", row=0)
    async def downvote(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_suggestion_vote(interaction, "down")


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if not callable(add_view):
        return
    for view in (SuggestionCreateView(cog), SuggestionVoteView(cog)):
        try:
            add_view(view)
        except Exception:
            logger.exception("提案箱の永続ビューを登録できませんでした")


class SuggestionCreateModal(discord.ui.Modal, title="提案を送信"):
    def __init__(self, cog: Any, guild_id: int, channel_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.channel_id = channel_id
        self.title_input = discord.ui.TextInput(
            label="提案のタイトル",
            max_length=100,
            required=True,
            placeholder="例: 新しいイベントを追加してほしい",
        )
        self.body_input = discord.ui.TextInput(
            label="提案の内容",
            style=discord.TextStyle.paragraph,
            max_length=2000,
            required=True,
            placeholder="理由や具体的な案を書いてください。",
        )
        self.add_item(self.title_input)
        self.add_item(self.body_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("提案箱は現在オフです。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"])
        if channel is None:
            return await interaction.response.send_message("提案先のチャンネルが見つかりません。", ephemeral=True)
        entry = {
            "guild_id": interaction.guild_id,
            "channel_id": channel.id,
            "author_id": interaction.user.id,
            "author_name": getattr(interaction.user, "display_name", None) or getattr(interaction.user, "name", "メンバー"),
            "title": str(self.title_input.value or "提案")[:100],
            "body": str(self.body_input.value or "")[:2000],
            "up": [],
            "down": [],
            "status": "受付中",
        }
        try:
            message = await channel.send(
                embed=build_embed(entry),
                view=SuggestionVoteView(self.cog, 0, 0),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("提案を投稿できませんでした: guild=%s", interaction.guild_id)
            return await interaction.response.send_message("提案を投稿できませんでした。", ephemeral=True)
        await _put_entry(message.id, entry)
        return await interaction.response.send_message("提案を投稿しました。", ephemeral=True)


async def handle_create(cog: Any, interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["channel_id"] is None:
        return await interaction.response.send_message("提案箱は現在オフです。", ephemeral=True)
    return await interaction.response.send_modal(
        SuggestionCreateModal(cog, interaction.guild_id, current["channel_id"])
    )


async def handle_vote(cog: Any, interaction: discord.Interaction, action: str) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("提案メッセージを取得できませんでした。", ephemeral=True)
    entry = (await _entries_cache()).get(str(message.id))
    if entry is None:
        return await interaction.response.send_message("この提案は見つかりません。", ephemeral=True)
    user_id = interaction.user.id
    up = [value for value in (entry.get("up") or []) if value != user_id]
    down = [value for value in (entry.get("down") or []) if value != user_id]
    was_up = user_id in (entry.get("up") or [])
    was_down = user_id in (entry.get("down") or [])
    if action == "up" and not was_up and len(up) >= 500:
        return await interaction.response.send_message(
            "賛成票が上限（500件）に達しています。", ephemeral=True,
        )
    if action == "down" and not was_down and len(down) >= 500:
        return await interaction.response.send_message(
            "反対票が上限（500件）に達しています。", ephemeral=True,
        )
    if action == "up" and not was_up:
        up.append(user_id)
    elif action == "down" and not was_down:
        down.append(user_id)
    entry["up"] = up[:500]
    entry["down"] = down[:500]
    await _put_entry(message.id, entry)
    return await interaction.response.edit_message(
        embed=build_embed(entry),
        view=SuggestionVoteView(cog, len(entry["up"]), len(entry["down"])),
    )


class SuggestionChannelSelect(discord.ui.Select):
    def __init__(self, parent: "SuggestionSettingsView"):
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
        super().__init__(placeholder="提案を投稿するチャンネル", options=options[:25], row=0)

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
        await self.parent_view.refresh(interaction, "提案先のチャンネルを保存しました。")


class SuggestionToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="提案箱", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: SuggestionSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and not view.settings["channel_id"]:
            return await interaction.response.send_message("先に提案先のチャンネルを選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"提案箱を{'オン' if value else 'オフ'}にしました。")


class SuggestionPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: SuggestionSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = view.settings["channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に提案先のチャンネルを選んでください。", ephemeral=True)
        try:
            await channel.send(embed=build_panel_embed(), view=SuggestionCreateView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.response.send_message("提案パネルを送信しました。", ephemeral=True)


class SuggestionSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "提案箱"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(SuggestionChannelSelect(self))
        self.add_item(SuggestionToggleButton())
        self.add_item(SuggestionPanelButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="提案箱",
            description=(
                "サーバーへの提案を募集するパネルを設置します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**提案先**: {channel_label(self.settings['channel_id'])}"
                "\n\n「パネルを送信」で、提案ボタン付きのパネルを投稿します。"
                "投稿された提案は、誰でも賛成・反対に投票できます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> SuggestionSettingsView:
    return SuggestionSettingsView(cog, guild_id)
